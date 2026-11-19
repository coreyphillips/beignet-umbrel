import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { decimalsOf, fmtUnits, isSafeToAnimate, toUnits, unitOf } from '../lib/asset-amount.js';

/**
 * An amount of an asset: the figure, and the asset's name small beside it.
 *
 * The figure is formatted from the decimal string the wallet sent, digit for
 * digit (lib/asset-amount.js). `unit={false}` leaves the name off, for a
 * column whose heading already says which asset it is.
 */
export function AssetAmount({ value, asset, unit = true, className = '' }) {
	// A collectible is one of one. "1 Genesis Ticket" counts something that
	// cannot be counted, so it is named instead.
	if (asset?.type === 'collectible' && toUnits(value) === 1n) {
		return <span className={`asset-amount ${className}`}>{unitOf(asset, 40)}</span>;
	}
	return (
		<span className={`asset-amount ${className}`}>
			{fmtUnits(value, decimalsOf(asset))}
			{unit && <span className="asset-unit">{unitOf(asset)}</span>}
		</span>
	);
}

// How long a balance takes to count to its new figure, whatever the distance.
const COUNT_MS = 700;
// Quick away and slow to land, so the last digits can be read as they settle.
const easeOut = (t) => 1 - (1 - t) ** 4;

/**
 * The same, counting up or down to a new balance.
 *
 * What moves is how far along the change is, from 0 to 1, not the balance
 * itself. An asset's units can run to twenty digits, and a count that slowed
 * as it closed on its target would spend seconds on the last few of them: this
 * way a change of a trillion units takes as long as a change of ten.
 *
 * The arithmetic in between is on a JS number, which stops being exact at
 * 2^53, so an amount above that is never animated: it is shown as the digits
 * it is. Below it the count only ever passes through whole units, and it ends
 * on the string the wallet sent.
 */
export function AnimatedAssetAmount({ value, asset, unit = true, className = '' }) {
	const reduced = useReducedMotion();
	const safe = isSafeToAnimate(value);
	const target = safe ? Number(toUnits(value)) : 0;
	const still = !safe || reduced || asset?.type === 'collectible';
	const ends = useRef({ from: target, to: target });
	const progress = useRef(1);
	const [at, setAt] = useState(1);
	useEffect(() => {
		const { from, to } = ends.current;
		if (to === target) return undefined;
		if (still) {
			ends.current = { from: target, to: target };
			return undefined;
		}
		// From whatever is on screen, which is part way if a count was running.
		ends.current = { from: Math.round(from + (to - from) * progress.current), to: target };
		const began = performance.now();
		let frame = 0;
		const step = () => {
			const t = Math.min(1, (performance.now() - began) / COUNT_MS);
			progress.current = t < 1 ? easeOut(t) : 1;
			setAt(progress.current);
			if (t < 1) frame = requestAnimationFrame(step);
		};
		progress.current = 0;
		setAt(0);
		frame = requestAnimationFrame(step);
		return () => cancelAnimationFrame(frame);
	}, [still, target]);

	if (still) return <AssetAmount value={value} asset={asset} unit={unit} className={className} />;
	const { from, to } = ends.current;
	// Arrived, and at the figure being asked for: show that figure itself.
	const arrived = to === target && at >= 1;
	const figure = arrived ? value : String(Math.max(0, Math.round(from + (to - from) * at)));
	return <AssetAmount value={figure} asset={asset} unit={unit} className={className} />;
}
