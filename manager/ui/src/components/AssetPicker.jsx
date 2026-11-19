import { useEffect, useId, useRef, useState } from 'react';
import AssetAvatar from './AssetAvatar.jsx';
import { decimalsOf, fmtUnits, unitOf } from '../lib/asset-amount.js';
import { shortId } from '../lib/format.js';

/** Past this many, a row of chips is a wall, and a list reads better. */
const CHIP_LIMIT = 8;
const OTHER = '__other__';
const LOOKUP_DELAY_MS = 400;

/** An empty selection, for a caller's initial state. */
export const NO_ASSET = { key: null, other: false, text: '', found: null };

/** The asset a picker's value stands for, or null while it stands for none. */
export function pickedAsset(value, assets) {
	if (!value) return null;
	if (value.other) return value.found || null;
	return (assets || []).find((a) => a.key === value.key) || null;
}

/** 64 hex characters is an asset ID, 66 a group key. Anything else is neither yet. */
export function looksLikeAssetId(text) {
	const t = String(text || '').trim().toLowerCase();
	return /^[0-9a-f]+$/.test(t) && (t.length === 64 || t.length === 66);
}

/** "BUSD · asset · 2 decimal places · 1,000,000.00 issued" */
export function describeFound(asset) {
	const d = decimalsOf(asset);
	const parts = [asset.name, asset.type === 'collectible' ? 'collectible' : 'asset'];
	if (asset.type !== 'collectible') parts.push(d === 0 ? 'no decimal places' : `${d} decimal place${d === 1 ? '' : 's'}`);
	if (asset.supply?.known && asset.supply.issued != null && asset.type !== 'collectible') {
		parts.push(`${fmtUnits(asset.supply.issued, d)} issued`);
	}
	return parts.join(' · ');
}

/**
 * Choosing which asset a form is about.
 *
 * Held assets are chips, each with its face, in a radio group: one is chosen,
 * and the arrow keys move between them as they do between radio buttons. Past
 * eight a native list takes over. `allowOther` adds "Another asset", which
 * opens a box for an asset ID or group key this wallet has never seen and
 * looks it up through `lookup(id)` as it is typed.
 *
 * `value` is { key, other, text, found } and lives with the caller, so the
 * choice survives the form being put away and brought back.
 */
export default function AssetPicker({ label, assets, value, onChange, allowOther = false, lookup, host, testId = 'asset-picker' }) {
	const list = assets || [];
	const groupId = useId();
	const chipRefs = useRef({});
	const latest = useRef(value);
	latest.current = value;
	const [looking, setLooking] = useState({ status: 'idle', message: '' });
	const selected = value.other ? OTHER : value.key;
	const keys = list.map((a) => a.key).concat(allowOther ? [OTHER] : []);

	const choose = (key) => {
		if (key === OTHER) onChange({ ...latest.current, key: null, other: true });
		else onChange({ ...latest.current, key, other: false });
	};

	// The lookup, a beat after the typing stops, and only the newest may answer.
	const text = value.other ? value.text.trim().toLowerCase() : '';
	const foundId = value.found ? [value.found.assetId, value.found.groupKey, value.found.key] : [];
	const alreadyFound = value.other && value.found && foundId.includes(text);
	useEffect(() => {
		if (!value.other || !lookup) return () => {};
		if (alreadyFound) {
			setLooking({ status: 'found', message: '' });
			return () => {};
		}
		if (!looksLikeAssetId(text)) {
			setLooking({ status: 'idle', message: '' });
			if (latest.current.found) onChange({ ...latest.current, found: null });
			return () => {};
		}
		let alive = true;
		setLooking({ status: 'looking', message: '' });
		const timer = setTimeout(async () => {
			try {
				const answer = await lookup(text);
				if (!alive) return;
				onChange({ ...latest.current, found: answer?.asset || answer || null });
				setLooking({ status: 'found', message: '' });
			} catch (e) {
				if (!alive) return;
				if (latest.current.found) onChange({ ...latest.current, found: null });
				setLooking(
					e?.code === 'ASSET_NOT_FOUND' || e?.status === 404
						? { status: 'missing', message: '' }
						: { status: 'error', message: e?.message || 'no answer' }
				);
			}
		}, LOOKUP_DELAY_MS);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value.other, text, alreadyFound]);

	const onKeyDown = (e) => {
		const at = keys.indexOf(selected);
		let next = null;
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = keys[(at + 1 + keys.length) % keys.length];
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = keys[(at - 1 + keys.length) % keys.length];
		else if (e.key === 'Home') next = keys[0];
		else if (e.key === 'End') next = keys[keys.length - 1];
		if (next === null || next === undefined) return;
		e.preventDefault();
		choose(next);
		chipRefs.current[next]?.focus();
	};

	// One chip takes Tab: the chosen one, or the first while nothing is chosen.
	const tabStop = keys.includes(selected) ? selected : keys[0];
	const current = pickedAsset(value, list);
	const where = host || 'the proof server';

	return (
		<div className="field asset-picker" data-testid={testId}>
			{label && (
				<span className="field-label" id={groupId}>
					{label}
				</span>
			)}
			{list.length <= CHIP_LIMIT ? (
				<div className="asset-chips" role="radiogroup" aria-labelledby={label ? groupId : undefined} onKeyDown={onKeyDown}>
					{list.map((a) => (
						<button
							key={a.key}
							type="button"
							role="radio"
							aria-checked={selected === a.key}
							tabIndex={tabStop === a.key ? 0 : -1}
							ref={(el) => (chipRefs.current[a.key] = el)}
							className={`asset-chip${selected === a.key ? ' active' : ''}`}
							data-testid={`asset-chip-${a.key.slice(0, 8)}`}
							title={`${a.name} · ${shortId(a.assetId)}`}
							onClick={() => choose(a.key)}
						>
							<AssetAvatar asset={a} size="xs" />
							<span className="asset-chip-name">{unitOf(a, 22)}</span>
						</button>
					))}
					{allowOther && (
						<button
							type="button"
							role="radio"
							aria-checked={selected === OTHER}
							tabIndex={tabStop === OTHER ? 0 : -1}
							ref={(el) => (chipRefs.current[OTHER] = el)}
							className={`asset-chip other${selected === OTHER ? ' active' : ''}`}
							data-testid="asset-chip-other"
							onClick={() => choose(OTHER)}
						>
							<AssetAvatar size="xs" />
							<span className="asset-chip-name">Another asset</span>
						</button>
					)}
				</div>
			) : (
				<div className="asset-select-row">
					<AssetAvatar asset={current} size="sm" />
					<select aria-labelledby={label ? groupId : undefined} value={selected || ''} onChange={(e) => choose(e.target.value)}>
						<option value="" disabled>
							Choose an asset
						</option>
						{list.map((a) => (
							<option key={a.key} value={a.key}>
								{a.name} · {shortId(a.assetId)}
							</option>
						))}
						{allowOther && <option value={OTHER}>Another asset…</option>}
					</select>
				</div>
			)}

			{value.other && (
				<div className="asset-other">
					<input
						className="mono"
						aria-label="Asset ID or group key"
						placeholder="Asset ID or group key"
						autoComplete="off"
						spellCheck={false}
						value={value.text}
						data-testid="asset-other-input"
						onChange={(e) => onChange({ ...latest.current, text: e.target.value.replace(/\s+/g, '') })}
					/>
					<div className="asset-lookup" role="status" aria-live="polite" data-testid="asset-lookup" data-state={looking.status}>
						{looking.status === 'idle' && text === '' && (
							<span className="field-hint">
								Paste the asset ID (64 characters) or the group key (66) from whoever is sending it.
							</span>
						)}
						{looking.status === 'idle' && text !== '' && (
							<span className="field-hint">
								An asset ID is 64 characters of 0 to 9 and a to f, and a group key is 66. This is {text.length}.
							</span>
						)}
						{looking.status === 'looking' && (
							<span className="field-hint">
								Looking this up on <code>{where}</code>…
							</span>
						)}
						{looking.status === 'found' && value.found && (
							<div className="asset-found">
								<AssetAvatar asset={value.found} size="md" />
								<div>
									<div className="asset-name">{describeFound(value.found)}</div>
									<div className="field-hint">
										Found on <code>{where}</code>. Check the ID with whoever is sending it: a name proves
										nothing.
									</div>
								</div>
							</div>
						)}
						{looking.status === 'missing' && (
							<span className="field-hint refusal">
								No asset with this ID was found on <code>{where}</code>. Check the ID, or set the proof server
								its issuer uses in Settings.
							</span>
						)}
						{looking.status === 'error' && (
							<span className="field-hint refusal">The lookup could not be made: {looking.message}.</span>
						)}
					</div>
				</div>
			)}
		</div>
	);
}
