/**
 * Asset amounts: reading them, writing them, and never rounding them.
 *
 * A Taproot Asset is counted in whole units on the network, up to 2^64 - 1 of
 * them, and an asset's "decimal places" only say where to draw the point when
 * an amount is shown. Two things follow, and everything here is built on them.
 *
 * An amount does not fit in a JavaScript number. Past 2^53 a number skips
 * integers, so 9007199254740993 units would be shown, sent and burned as
 * 9007199254740992. Amounts therefore travel as decimal strings and are
 * worked on as BigInt, and nothing in this file calls Number() or parseInt()
 * on one.
 *
 * The point is drawn on the digits. Dividing by a power of ten would be a
 * float again, so the string is sliced instead.
 */

/** The most units one asset can hold: 2^64 - 1. */
export const MAX_UNITS = 18446744073709551615n;

const DIGITS = /^\d+$/;

/** How many decimal places an asset shows. Missing means none. */
export function decimalsOf(asset) {
	const d = asset && asset.decimalDisplay;
	return Number.isInteger(d) && d > 0 ? Math.min(d, 19) : 0;
}

/**
 * Whatever an amount arrived as, as a BigInt, or null when it is not one.
 *
 * A JS number is taken only while it is still an exact integer. One that has
 * already lost its low digits cannot be trusted to say what the amount was.
 */
export function toUnits(value) {
	if (typeof value === 'bigint') return value >= 0n ? value : null;
	if (typeof value === 'string') return DIGITS.test(value) ? BigInt(value) : null;
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
	return null;
}

function group(digits) {
	return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Units as the figure a person reads: grouped in thousands, with the asset's
 * decimal places all shown. "100000" at two places is "1,000.00".
 */
export function fmtUnits(value, decimals = 0) {
	const units = toUnits(value);
	if (units === null) return '-';
	const d = Number.isInteger(decimals) && decimals > 0 ? decimals : 0;
	const digits = units.toString();
	if (d === 0) return group(digits);
	const padded = digits.padStart(d + 1, '0');
	return `${group(padded.slice(0, -d))}.${padded.slice(-d)}`;
}

// Names that would make an asset's amount read as an amount of bitcoin.
const BITCOIN_WORDS = new Set(['sat', 'sats', 'satoshi', 'satoshis', 'btc', 'bitcoin', 'bitcoins', 'msat', 'msats', '₿']);

/** Whether a name is one of bitcoin's own units. */
export function readsAsBitcoin(name) {
	return BITCOIN_WORDS.has(String(name || '').trim().toLowerCase());
}

/**
 * The word shown beside an amount of this asset.
 *
 * It is the asset's name, cut to a length a table cell can hold. A name that
 * is one of bitcoin's units is quoted and marked, because "500 sats" beside a
 * real sats figure is exactly the confusion an impostor asset is named for.
 */
export function unitOf(asset, max = 14) {
	const name = String((asset && asset.name) || '').trim();
	if (!name) return 'units';
	const cut = [...name];
	const short = cut.length > max ? `${cut.slice(0, max - 1).join('')}…` : name;
	return readsAsBitcoin(name) ? `"${short}" asset` : short;
}

/** An amount with its unit: "1,000.00 BUSD". A collectible is named, not counted. */
export function fmtAsset(value, asset, { unit = true } = {}) {
	if (asset && asset.type === 'collectible' && toUnits(value) === 1n) return unitOf(asset, 40);
	const figure = fmtUnits(value, decimalsOf(asset));
	return unit ? `${figure} ${unitOf(asset)}` : figure;
}

/**
 * What was typed into an amount field, as units.
 *
 * Returns { text, units, error }. `text` is what the field should hold,
 * `units` the amount as a decimal string (null while there is none), and
 * `error` one of:
 *   NOT_A_NUMBER  something that is not a figure was typed
 *   PRECISION     a digit past the asset's decimal places
 *   TOO_LARGE     more than an asset can hold
 *
 * A digit past the precision is refused rather than rounded: 0.005 of an
 * asset with two places is not an amount, and turning it into 0.00 or 0.01
 * would be choosing for the person which they meant.
 */
export function parseAmountInput(text, decimals = 0) {
	const d = Number.isInteger(decimals) && decimals > 0 ? decimals : 0;
	// Thousands separators and spaces are how a copied figure arrives.
	const clean = String(text ?? '').replace(/[,\s_]/g, '');
	if (clean === '') return { text: '', units: null, error: null };
	if (!/^\d*\.?\d*$/.test(clean)) return { text: clean, units: null, error: 'NOT_A_NUMBER' };
	const dot = clean.indexOf('.');
	const whole = dot === -1 ? clean : clean.slice(0, dot);
	const frac = dot === -1 ? '' : clean.slice(dot + 1);
	if (dot !== -1 && d === 0) return { text: clean, units: null, error: 'PRECISION' };
	if (frac.length > d) return { text: clean, units: null, error: 'PRECISION' };
	// A lone point is the start of a fraction, not yet an amount.
	if (whole === '' && frac === '') return { text: clean, units: null, error: null };
	const units = BigInt((whole || '0') + frac.padEnd(d, '0'));
	if (units > MAX_UNITS) return { text: clean, units: null, error: 'TOO_LARGE' };
	return { text: clean, units: units.toString(), error: null };
}

/** Units as the plain text an amount field holds: no grouping, no trailing zeros. */
export function unitsToInput(value, decimals = 0) {
	const units = toUnits(value);
	if (units === null) return '';
	const d = Number.isInteger(decimals) && decimals > 0 ? decimals : 0;
	const digits = units.toString();
	if (d === 0) return digits;
	const padded = digits.padStart(d + 1, '0');
	const frac = padded.slice(-d).replace(/0+$/, '');
	return frac ? `${padded.slice(0, -d)}.${frac}` : padded.slice(0, -d);
}

/** -1, 0 or 1, as a sort wants. Anything unreadable counts as zero. */
export function cmpUnits(a, b) {
	const x = toUnits(a) ?? 0n;
	const y = toUnits(b) ?? 0n;
	return x < y ? -1 : x > y ? 1 : 0;
}

export function addUnits(a, b) {
	return ((toUnits(a) ?? 0n) + (toUnits(b) ?? 0n)).toString();
}

/** a - b, and never below zero: a balance cannot be owed. */
export function subUnits(a, b) {
	const out = (toUnits(a) ?? 0n) - (toUnits(b) ?? 0n);
	return (out < 0n ? 0n : out).toString();
}

export function isZero(value) {
	return (toUnits(value) ?? 0n) === 0n;
}

// A slider is a thousand steps wide. That is finer than a hand can place it
// and coarse enough for the arithmetic to stay in integers.
export const SLIDER_STEPS = 1000;

/** Where `value` sits between zero and `max`, as a slider position. */
export function ratio(value, max) {
	const v = toUnits(value) ?? 0n;
	const m = toUnits(max) ?? 0n;
	if (m === 0n) return 0;
	if (v >= m) return SLIDER_STEPS;
	return Number((v * BigInt(SLIDER_STEPS)) / m);
}

/**
 * The amount a slider position stands for. The last step is the maximum
 * itself, to the unit: a slider that stops a few units short of everything
 * leaves dust nobody asked to keep.
 */
export function fromRatio(position, max) {
	const m = toUnits(max) ?? 0n;
	const step = Math.max(0, Math.min(SLIDER_STEPS, Math.round(Number(position) || 0)));
	if (step >= SLIDER_STEPS) return m.toString();
	return ((m * BigInt(step)) / BigInt(SLIDER_STEPS)).toString();
}

/** The smallest amount of an asset that can be shown: "0.01" at two places. */
export function smallestAmount(decimals = 0) {
	return fmtUnits(1n, decimals);
}

/** Whether an amount is small enough to animate as a number without losing digits. */
export function isSafeToAnimate(value) {
	const units = toUnits(value);
	return units !== null && units <= BigInt(Number.MAX_SAFE_INTEGER);
}
