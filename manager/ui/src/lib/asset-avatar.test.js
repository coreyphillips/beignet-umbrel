/**
 * Run with: npm test (from manager/ui).
 *
 * An asset's face is the one thing beside its name that an impostor cannot
 * choose, so it has to be worth trusting: the same for the same ID wherever
 * it is drawn, different for a different ID however close, and legible in
 * both themes whatever two hues the ID happens to pick.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AVATAR_INK, AVATAR_TONES, avatarOf, avatarSeed, avatarSpec, inkContrast } from './asset-avatar.js';

// A reproducible run of IDs: the test must fail the same way twice.
function seeds(count, start = 1) {
	const out = [];
	let x = start >>> 0;
	for (let i = 0; i < count; i++) {
		let hex = '';
		while (hex.length < 64) {
			x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
			hex += x.toString(16).padStart(8, '0');
		}
		out.push(hex);
	}
	return out;
}

const picture = (spec) => JSON.stringify([spec.hue1, spec.hue2, spec.angle, spec.cells, spec.ink]);
const ID = '1f2268a697ea670ea842ec7e8f923c76d3b30860581a79731acc22243e2a06db';

test('the same ID always draws the same face', () => {
	const first = avatarSpec(ID);
	assert.deepEqual(avatarSpec(ID), first);
	assert.deepEqual(avatarSpec(ID.toUpperCase()), first, 'however the ID was written down');
	assert.equal(typeof first.hue1, 'number');
	assert.ok(first.hue1 >= 0 && first.hue1 < 360 && first.hue2 >= 0 && first.hue2 < 360);
	assert.equal(first.angle % 45, 0);
	assert.equal(avatarSpec('not an id'), null, 'and nothing is drawn from something that is not one');
	assert.equal(avatarSpec(ID.slice(2)), null);
	assert.equal(avatarOf(null), null, 'an asset with no ID yet has no face yet');
	assert.equal(avatarOf({ name: 'BUSD' }), null, 'a name is never enough to draw one');
});

test("a group's issuances share one face", () => {
	const groupKey = `02${'964a6357021488ec658821c10a46da0f9f1ecd420b8e89d9edc5b52ce1ca8114'}`;
	const first = { assetId: ID, groupKey };
	const second = { assetId: '25882e0000000000000000000000000000000000000000000000000000009eba', groupKey };
	assert.deepEqual(avatarOf(second), avatarOf(first));
	assert.equal(avatarSeed(first), groupKey.slice(2), 'the parity byte says nothing about the asset and is left out');
	assert.deepEqual(avatarOf({ ...first, groupKey: `03${groupKey.slice(2)}` }), avatarOf(first));
	// A row names an asset by its key, which is the group key when there is one.
	assert.deepEqual(avatarOf({ key: groupKey, assetId: second.assetId }), avatarOf(first), 'a row that only carries the key');
	assert.notDeepEqual(avatarOf({ assetId: ID }), avatarOf(first), 'the same ID outside a group is another asset');
});

test('no face is empty or solid', () => {
	for (const seed of seeds(2000)) {
		const { cells } = avatarSpec(seed);
		assert.ok(cells.length >= 5 && cells.length <= 19, `${seed} lights ${cells.length} of 25 cells`);
		for (const [col, row] of cells) {
			assert.ok(col >= 0 && col <= 4 && row >= 0 && row <= 4);
			assert.ok(cells.some(([c, r]) => c === 4 - col && r === row), 'and every one is mirrored left to right');
		}
	}
});

test('the ink keeps 3:1 against both stops in both themes', () => {
	let worst = Infinity;
	for (const seed of seeds(2000, 7)) {
		const spec = avatarSpec(seed);
		for (const theme of ['dark', 'light']) {
			const tones = AVATAR_TONES[theme];
			const c1 = inkContrast(spec.ink, spec.hue1, tones.l1 + spec.shift1);
			const c2 = inkContrast(spec.ink, spec.hue2, tones.l2 + spec.shift2);
			worst = Math.min(worst, c1, c2);
			assert.ok(c1 >= 3 && c2 >= 3, `${seed} in ${theme}: ${c1.toFixed(2)} and ${c2.toFixed(2)}`);
		}
	}
	assert.ok(worst >= 3, `the closest call was ${worst.toFixed(2)}:1`);
});

test('the stylesheet draws with the tones the ink was worked out from', () => {
	const css = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8');
	const [dark, light] = css.split(":root[data-theme='light']");
	const token = (block, name) => (new RegExp(`${name}:\\s*([^;]+);`).exec(block) || [])[1];
	assert.equal(token(dark, '--av-s'), `${AVATAR_TONES.saturation}%`);
	assert.equal(token(dark, '--av-l1'), `${AVATAR_TONES.dark.l1}%`);
	assert.equal(token(dark, '--av-l2'), `${AVATAR_TONES.dark.l2}%`);
	assert.equal(token(light, '--av-l1'), `${AVATAR_TONES.light.l1}%`);
	assert.equal(token(light, '--av-l2'), `${AVATAR_TONES.light.l2}%`);
	assert.equal(token(dark, '--av-ink-light'), AVATAR_INK.light);
	assert.equal(token(dark, '--av-ink-dark'), AVATAR_INK.dark);
});

test('two IDs differing in one byte differ on screen', () => {
	for (const seed of seeds(40, 99)) {
		const base = picture(avatarSpec(seed));
		for (let byte = 0; byte < 32; byte++) {
			const at = byte * 2;
			const flipped = (parseInt(seed.slice(at, at + 2), 16) ^ 0x01).toString(16).padStart(2, '0');
			const near = seed.slice(0, at) + flipped + seed.slice(at + 2);
			assert.notEqual(picture(avatarSpec(near)), base, `${seed} with byte ${byte} changed`);
		}
	}
});
