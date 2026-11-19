/**
 * An asset's face: a small picture drawn from its ID and from nothing else.
 *
 * Anyone can mint an asset called BUSD. What they cannot choose is its ID, so
 * the picture beside a name is drawn from the ID, and two assets that share a
 * name do not share a face. The name is deliberately left out of it: a
 * monogram would be the one part of the picture an impostor controls.
 *
 * The picture is two hues, the angle between them, and a five by five pattern
 * of dots mirrored left to right. All of it is plain arithmetic on the bytes,
 * so the same ID draws the same face on every device and in both themes.
 */

// The colour recipe, shared with styles/tokens.css (--av-s, --av-l1, --av-l2).
// A test holds the two to each other.
export const AVATAR_TONES = {
	saturation: 72,
	dark: { l1: 64, l2: 46 },
	light: { l1: 56, l2: 40 }
};

// The two inks a pattern is drawn in, and how bright each is.
export const AVATAR_INK = { light: '#ffffff', dark: '#0d1017' };
const INK_LUMINANCE = { light: 1, dark: 0.0052 };

// A pattern has to stand 3:1 against the colour under it. For white ink that
// caps how bright a stop may be, for dark ink it sets how dim. Both are held
// with a little room to spare.
const LIGHT_INK_MAX_Y = 0.28;
const DARK_INK_MIN_Y = 0.13;

const HEX = /^[0-9a-f]+$/;

/**
 * The 32 bytes a face is drawn from: the group key when the asset has one, so
 * every issuance of a group wears the same face, and the asset ID otherwise.
 * A group key is 33 bytes with a parity byte in front, which says nothing
 * about the asset and is dropped.
 */
export function avatarSeed(asset) {
	if (!asset) return null;
	// `key` is the group key when there is one (lib/assets-api.js), which is
	// how a row that names an asset without its group key still gets the
	// group's face.
	const raw = String(asset.groupKey || asset.key || asset.assetId || '').toLowerCase();
	if (!HEX.test(raw)) return null;
	if (raw.length === 66) return raw.slice(2);
	return raw.length === 64 ? raw : null;
}

function bytesOf(hex) {
	const out = [];
	for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
	return out;
}

/**
 * Eight bytes that depend on all thirty two.
 *
 * Reading the first eight bytes straight off the ID would leave twenty four
 * that change nothing on screen. Folding every byte in means two IDs that
 * differ anywhere draw differently.
 */
function digest(bytes) {
	let a = 0x811c9dc5;
	let b = 0x9e3779b9;
	for (let i = 0; i < bytes.length; i++) {
		a = Math.imul(a ^ bytes[i], 0x01000193) >>> 0;
		b = Math.imul((b ^ bytes[i]) + i, 0x85ebca6b) >>> 0;
		b = ((b << 13) | (b >>> 19)) >>> 0;
	}
	// A last stir, so a change in the final byte reaches every output bit.
	a = Math.imul(a ^ (a >>> 15), 0x2c1b3c6d) >>> 0;
	a = (a ^ (a >>> 12)) >>> 0;
	b = Math.imul(b ^ (b >>> 16), 0x297a2d39) >>> 0;
	b = (b ^ (b >>> 15)) >>> 0;
	return [a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 255, b >>> 24, (b >>> 16) & 255, (b >>> 8) & 255, b & 255];
}

function channel(v) {
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance (WCAG) of an hsl colour, lightness and saturation in percent. */
export function luminance(hue, saturation, lightness) {
	const s = saturation / 100;
	const l = Math.max(0, Math.min(100, lightness)) / 100;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const h = (((hue % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((h % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
	return 0.2126 * channel(r + m) + 0.7152 * channel(g + m) + 0.0722 * channel(b + m);
}

/** Contrast ratio between an ink and an hsl colour. */
export function inkContrast(ink, hue, lightness) {
	const y = luminance(hue, AVATAR_TONES.saturation, lightness);
	const i = INK_LUMINANCE[ink];
	return (Math.max(y, i) + 0.05) / (Math.min(y, i) + 0.05);
}

/**
 * How far a stop's lightness has to move, in points, for an ink to read on it
 * in both themes. Zero for most hues. Yellow under white ink has to come down
 * a long way, and blue under dark ink has to come up.
 */
function shiftFor(ink, hue, darkL, lightL) {
	const s = AVATAR_TONES.saturation;
	if (ink === 'light') {
		// The brighter of the two themes is the one white ink struggles on.
		const top = Math.max(darkL, lightL);
		let k = 0;
		while (k > -60 && luminance(hue, s, top + k) > LIGHT_INK_MAX_Y) k--;
		return k;
	}
	const bottom = Math.min(darkL, lightL);
	let k = 0;
	while (k < 60 && luminance(hue, s, bottom + k) < DARK_INK_MIN_Y) k++;
	return k;
}

// Columns 0 to 2 of the grid, five rows each, one bit per cell: fifteen bits.
const bitCount = (n) => {
	let c = 0;
	for (let v = n; v; v >>>= 1) c += v & 1;
	return c;
};
const bitAt = (col, row) => 1 << (col * 5 + row);
// How many of the 25 cells a half pattern lights once it is mirrored: the
// two outer columns count twice, the middle one once.
const OUTER = 0x3ff;
const litCells = (bits) => 2 * bitCount(bits & OUTER) + bitCount(bits & ~OUTER);
// A plus in the middle of the grid, for a pattern that came out nearly empty.
const CENTRE_CROSS = bitAt(2, 1) | bitAt(2, 2) | bitAt(2, 3) | bitAt(1, 2);
// The corners and the middle, taken back out of one that came out nearly solid.
const OPENINGS = bitAt(0, 0) | bitAt(0, 4) | bitAt(2, 2) | bitAt(1, 1) | bitAt(1, 3);

/**
 * Everything needed to draw a face.
 *
 * Returns null for a seed that is not 32 bytes of hex, which the avatar draws
 * as an empty ring: an asset that has no ID yet has no face yet.
 *
 *   hue1, hue2   the two stops of the gradient, in degrees
 *   angle        the gradient's direction, in degrees
 *   shift1/2     lightness corrections, in points, so the ink reads on each stop
 *   cells        the lit cells of the 5x5 grid, as [column, row]
 *   ink          'light' or 'dark', whichever keeps the hues closest to true
 */
export function avatarSpec(seedHex) {
	const seed = String(seedHex || '').toLowerCase();
	if (seed.length !== 64 || !HEX.test(seed)) return null;
	const b = digest(bytesOf(seed));

	const hue1 = ((b[0] << 8) | b[1]) % 360;
	const hue2 = (hue1 + 40 + (b[2] % 81)) % 360;
	const angle = (b[3] % 8) * 45;

	// Too sparse or too full on the first draw, the second is folded in; what
	// is still nearly empty gets the cross, what is still nearly solid gets
	// its openings. Every face ends up with 5 to 19 of its 25 cells lit.
	let bits = ((b[4] << 8) | b[5]) & 0x7fff;
	if (litCells(bits) < 7 || litCells(bits) > 18) bits ^= ((b[6] << 8) | b[7]) & 0x7fff;
	if (litCells(bits) < 6) bits |= CENTRE_CROSS;
	if (litCells(bits) > 19) bits &= ~OPENINGS;
	const cells = [];
	for (let col = 0; col < 3; col++) {
		for (let row = 0; row < 5; row++) {
			if (!(bits & bitAt(col, row))) continue;
			cells.push([col, row]);
			if (col < 2) cells.push([4 - col, row]);
		}
	}

	// Each ink is tried, and the one that moves the colours least is kept: a
	// face should be as close to its own two hues as legibility allows.
	const { dark, light } = AVATAR_TONES;
	const tries = ['light', 'dark'].map((ink) => {
		const shift1 = shiftFor(ink, hue1, dark.l1, light.l1);
		const shift2 = shiftFor(ink, hue2, dark.l2, light.l2);
		return { ink, shift1, shift2, cost: Math.abs(shift1) + Math.abs(shift2) };
	});
	// On a tie the first stop decides, as the eye does: a bright face takes
	// dark dots.
	const firstIsBright = luminance(hue1, AVATAR_TONES.saturation, dark.l1) > 0.42;
	tries.sort((x, y) => x.cost - y.cost || (x.ink === (firstIsBright ? 'dark' : 'light') ? -1 : 1));
	const { ink, shift1, shift2 } = tries[0];

	return { hue1, hue2, angle, shift1, shift2, cells, ink };
}

/** The face of an asset, or null while it has no ID. */
export function avatarOf(asset) {
	const seed = avatarSeed(asset);
	return seed ? avatarSpec(seed) : null;
}
