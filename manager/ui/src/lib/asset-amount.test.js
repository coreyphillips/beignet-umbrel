/**
 * Run with: npm test (from manager/ui).
 *
 * Amounts of an asset. An asset can hold 2^64 - 1 units and a JS number is
 * exact only to 2^53, so every figure here is a decimal string that never
 * passes through a number. These pin that, and the rules of the amount box:
 * decimal places move the point and nothing else, and a digit the asset
 * cannot represent is refused, never rounded.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_UNITS,
	SLIDER_STEPS,
	addUnits,
	cmpUnits,
	fmtAsset,
	fmtUnits,
	fromRatio,
	isSafeToAnimate,
	isZero,
	parseAmountInput,
	ratio,
	smallestAmount,
	subUnits,
	toUnits,
	unitOf,
	unitsToInput
} from './asset-amount.js';

test('an amount above 2^53 formats to the digit', () => {
	// 2^53 + 1, the first whole number a JS number cannot hold.
	assert.equal(fmtUnits('9007199254740993', 0), '9,007,199,254,740,993');
	assert.equal(fmtUnits('9007199254740993', 8), '90,071,992.54740993');
	assert.equal(Number('9007199254740993').toString(), '9007199254740992', 'which is why it never goes through Number');
	assert.equal(fmtAsset('9007199254740993', { name: 'Pico', decimalDisplay: 8 }), '90,071,992.54740993 Pico');
	assert.equal(isSafeToAnimate('9007199254740993'), false, 'and why a count-up spring is not run on it');
	assert.equal(isSafeToAnimate('9007199254740991'), true);
});

test('the largest amount an asset can hold survives a round trip', () => {
	const max = MAX_UNITS.toString();
	assert.equal(max, '18446744073709551615');
	for (const decimals of [0, 2, 8]) {
		const typed = unitsToInput(max, decimals);
		assert.deepEqual(parseAmountInput(typed, decimals), { text: typed, units: max, error: null }, `at ${decimals} places`);
	}
	assert.equal(fmtUnits(max, 0), '18,446,744,073,709,551,615');
	assert.equal(parseAmountInput('18446744073709551616', 0).error, 'TOO_LARGE', 'one more is refused');
	assert.equal(parseAmountInput('184467440737095516.16', 2).error, 'TOO_LARGE');
});

test('decimal places only move the point', () => {
	assert.equal(fmtUnits('100000', 0), '100,000');
	assert.equal(fmtUnits('100000', 2), '1,000.00');
	assert.equal(fmtUnits('100000', 8), '0.00100000');
	assert.equal(fmtUnits('5', 2), '0.05', 'an amount smaller than one whole unit keeps its leading zero');
	assert.equal(fmtUnits('0', 2), '0.00');
	assert.equal(parseAmountInput('1000', 2).units, '100000');
	assert.equal(parseAmountInput('1,000.5', 2).units, '100050', 'a pasted figure keeps its meaning through its separators');
	assert.equal(parseAmountInput('.5', 2).units, '50');
	assert.equal(unitsToInput('100050', 2), '1000.5', 'and back, without the zeros nobody typed');
	assert.equal(smallestAmount(2), '0.01');
	assert.equal(smallestAmount(0), '1');
});

test("a digit past the asset's precision is refused, not rounded", () => {
	assert.deepEqual(parseAmountInput('0.005', 2), { text: '0.005', units: null, error: 'PRECISION' });
	assert.deepEqual(parseAmountInput('1.5', 0), { text: '1.5', units: null, error: 'PRECISION' }, 'no places means no point at all');
	assert.equal(parseAmountInput('12abc', 2).error, 'NOT_A_NUMBER');
	assert.equal(parseAmountInput('-5', 2).error, 'NOT_A_NUMBER', 'there is no negative amount of an asset');
	assert.deepEqual(parseAmountInput('', 2), { text: '', units: null, error: null }, 'an empty box is not a mistake');
	assert.deepEqual(parseAmountInput('.', 2), { text: '.', units: null, error: null }, 'nor is the start of a fraction');
});

test('the slider reaches exactly the maximum', () => {
	const max = '18446744073709551615';
	assert.equal(fromRatio(SLIDER_STEPS, max), max, 'the last step is the whole balance, not a rounding of it');
	assert.equal(fromRatio(0, max), '0');
	assert.equal(fromRatio(SLIDER_STEPS / 2, '1000'), '500');
	assert.equal(ratio(max, max), SLIDER_STEPS);
	assert.equal(ratio('0', max), 0);
	assert.equal(ratio('500', '1000'), SLIDER_STEPS / 2);
	assert.equal(ratio('5', '0'), 0, 'nothing to slide over is the start, not a division by zero');
});

test('an asset named sats is not shown as sats', () => {
	assert.equal(unitOf({ name: 'sats' }), '"sats" asset');
	assert.equal(unitOf({ name: ' BTC ' }), '"BTC" asset');
	assert.equal(fmtAsset('500', { name: 'sats', decimalDisplay: 0 }), '500 "sats" asset');
	assert.equal(unitOf({ name: 'BUSD' }), 'BUSD');
	assert.equal(unitOf({}), 'units', 'a nameless asset is counted in units');
	assert.equal(unitOf({ name: 'A very long asset name indeed' }), 'A very long a…', 'a long name is cut, with a mark that it was');
});

test('a collectible is named, not counted', () => {
	const ticket = { name: 'Genesis Ticket #7', type: 'collectible', decimalDisplay: null };
	assert.equal(fmtAsset('1', ticket), 'Genesis Ticket #7');
});

test('amounts are compared, added and taken away without leaving strings', () => {
	const big = '18446744073709551614';
	assert.equal(addUnits(big, '1'), '18446744073709551615');
	assert.equal(subUnits('18446744073709551615', '1'), big);
	assert.equal(subUnits('5', '9'), '0', 'a balance does not go below nothing');
	assert.equal(cmpUnits('9007199254740993', '9007199254740992'), 1, 'two figures a number would call equal');
	assert.equal(cmpUnits('10', '9'), 1, 'compared as amounts, not as text');
	assert.equal(cmpUnits('7', '7'), 0);
	assert.equal(isZero('0'), true);
	assert.equal(isZero(null), true);
	assert.equal(isZero('1'), false);
	assert.equal(toUnits('12.5'), null, 'a figure with a point in it is not units');
	assert.equal(toUnits(12), 12n);
});
