import { useMemo } from 'react';
import { AVATAR_INK, avatarOf } from '../lib/asset-avatar.js';

/**
 * The picture beside an asset's name, drawn from its ID (lib/asset-avatar.js).
 *
 * A circle for an asset, a rounded square for a collectible, so the two kinds
 * are told apart by shape and not by colour alone. An asset with no ID yet, a
 * mint still being written, gets an empty dashed ring: there is nothing to
 * draw a face from until the transaction exists.
 *
 * Decorative: the name is always beside it, so it is hidden from a screen
 * reader instead of being described.
 */
export default function AssetAvatar({ asset, size = 'md', ready = false, className = '' }) {
	const spec = useMemo(() => avatarOf(asset), [asset?.assetId, asset?.groupKey]);
	const shape = asset?.type === 'collectible' ? ' collectible' : '';
	if (!spec) {
		return <span className={`asset-avatar seedling ${size}${shape} ${className}`} aria-hidden="true" data-seedling="true" />;
	}
	return (
		<span
			className={`asset-avatar ${size}${shape}${ready ? ' ready' : ''} ${className}`}
			aria-hidden="true"
			data-ink={spec.ink}
			style={{
				'--av-h1': spec.hue1,
				'--av-h2': spec.hue2,
				'--av-angle': `${spec.angle}deg`,
				'--av-k1': `${spec.shift1}%`,
				'--av-k2': `${spec.shift2}%`
			}}
		>
			<svg viewBox="0 0 7 7" focusable="false">
				{spec.cells.map(([col, row]) => (
					<circle key={`${col}-${row}`} cx={col + 1.5} cy={row + 1.5} r=".42" fill={AVATAR_INK[spec.ink]} />
				))}
			</svg>
		</span>
	);
}
