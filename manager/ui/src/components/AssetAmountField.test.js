/**
 * Run with: npm test (from manager/ui).
 *
 * The amount box for an asset. It counts in the asset's own units, hands its
 * caller the exact amount as a string, and will not hold a figure the asset
 * cannot represent: a letter, or a digit past its decimal places, is not
 * accepted in the first place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useState } from 'react';
import { click, render, settle, type } from '../../test/render.mjs';
import AssetAmountField from './AssetAmountField.jsx';
import { AnimatedAssetAmount, AssetAmount } from './AssetAmount.jsx';
import AssetAvatar from './AssetAvatar.jsx';

const BUSD = { name: 'BUSD', type: 'normal', decimalDisplay: 2 };

/** The field with the state a caller keeps for it, and a record of what it was handed. */
function Held({ log, initial = '', ...props }) {
	const [text, setText] = useState(initial);
	const [units, setUnits] = useState(null);
	return createElement(AssetAmountField, {
		label: 'Amount',
		asset: BUSD,
		value: text,
		testId: 'amount',
		onChange: (t, u) => {
			log.push([t, u]);
			setText(t);
			setUnits(u);
		},
		isMax: !!props.max && units === props.max,
		onMax: () => {
			log.push(['max']);
			setText('12500');
			setUnits(props.max);
		},
		...props
	});
}

test('typing hands back the text and the exact units', async () => {
	const log = [];
	const r = await render(Held, { log });
	try {
		const box = r.$('[data-testid="amount"]');
		assert.equal(box.getAttribute('inputmode'), 'decimal');
		assert.equal(r.$('.amount-unit').textContent, 'BUSD', 'the box says what it is counting in');
		assert.equal(r.$('label').getAttribute('for'), box.id, 'and the label points at it');
		await type(box, '1000.5');
		assert.deepEqual(log.at(-1), ['1000.5', '100050']);
		await type(box, '1,000,000');
		assert.deepEqual(log.at(-1), ['1000000', '100000000'], 'a pasted figure loses its separators and keeps its meaning');
		assert.equal(r.$('input[type="range"]'), null, 'with no maximum there is no slider and no Max');
		assert.doesNotMatch(r.text(), /Max/);
	} finally {
		await r.unmount();
	}
});

test('a digit past the precision, or a letter, is not accepted', async () => {
	const log = [];
	const r = await render(Held, { log, initial: '0.01' });
	try {
		const box = r.$('[data-testid="amount"]');
		await type(box, '0.015');
		assert.deepEqual(log, [], 'the caller is never handed it');
		assert.equal(box.value, '0.01', 'and the box keeps what it held');
		await type(box, '0.01x');
		assert.deepEqual(log, []);
		await type(box, '0.02');
		assert.deepEqual(log, [['0.02', '2']]);
	} finally {
		await r.unmount();
	}
});

test('more than an asset can hold is said, with the limit', async () => {
	const log = [];
	const r = await render(Held, { log, asset: { name: 'Pico', decimalDisplay: 0 } });
	try {
		await type(r.$('[data-testid="amount"]'), '18446744073709551616');
		assert.deepEqual(log.at(-1), ['18446744073709551616', null], 'it stays in the box and is not an amount');
		const refusal = r.$('.field-hint.refusal');
		assert.equal(refusal.getAttribute('role'), 'alert');
		assert.equal(refusal.textContent, 'That is more than an asset can hold (18,446,744,073,709,551,615 units).');
	} finally {
		await r.unmount();
	}
});

test('with decimal places the figure on the network is shown beside the one typed', async () => {
	const log = [];
	const r = await render(Held, { log, showUnits: true });
	try {
		assert.equal(r.$('[data-testid="amount-units"]'), null);
		await type(r.$('[data-testid="amount"]'), '1000000');
		assert.equal(r.$('[data-testid="amount-units"]').textContent, '= 100,000,000 units on the network');
	} finally {
		await r.unmount();
	}
});

test('with a maximum, the slider and Max reach exactly the balance', async () => {
	const log = [];
	const max = '1250000';
	const r = await render(Held, { log, max });
	try {
		const slider = r.$('input[type="range"]');
		assert.equal(slider.getAttribute('aria-label'), 'Amount slider');
		assert.equal(r.$('.amount-scale').textContent, '00%12,500.00');
		await type(slider, '1000');
		assert.deepEqual(log.at(-1), ['12500', max], 'the last step is the whole balance');
		await type(slider, '500');
		assert.deepEqual(log.at(-1), ['6250', '625000']);
		await type(slider, '0');
		assert.deepEqual(log.at(-1), ['', null], 'and the first step is an empty box, not a zero');
		const maxButton = [...r.$$('button')].find((b) => b.textContent === 'Max');
		assert.equal(maxButton.getAttribute('aria-pressed'), 'false');
		await click(maxButton);
		assert.deepEqual(log.at(-1), ['max']);
		assert.equal(maxButton.getAttribute('aria-pressed'), 'true');
	} finally {
		await r.unmount();
	}
});

test("a caller's refusal is announced under the box", async () => {
	const r = await render(Held, { log: [], refusal: 'Say how many to create.' });
	try {
		const refusal = r.$('[data-testid="amount-refusal"]');
		assert.equal(refusal.getAttribute('role'), 'alert');
		assert.equal(refusal.textContent, 'Say how many to create.');
	} finally {
		await r.unmount();
	}
});

test('an amount is drawn digit for digit, with the name small beside it', async () => {
	const r = await render(AssetAmount, { value: '9007199254740993', asset: { name: 'Pico', decimalDisplay: 8 } });
	try {
		assert.equal(r.$('.asset-amount').firstChild.textContent, '90,071,992.54740993');
		assert.equal(r.$('.asset-unit').textContent, 'Pico');
	} finally {
		await r.unmount();
	}
	const ticket = await render(AssetAmount, { value: '1', asset: { name: 'Genesis Ticket #7', type: 'collectible' } });
	try {
		assert.equal(ticket.text(), 'Genesis Ticket #7', 'a collectible is named, not counted');
	} finally {
		await ticket.unmount();
	}
});

test('a balance that changes counts to the new figure and lands on it exactly', async () => {
	let set;
	function Balance({ asset }) {
		const [value, setValue] = useState('1250000');
		set = setValue;
		return createElement(AnimatedAssetAmount, { value, asset });
	}
	const figure = (r) => r.$('.asset-amount').firstChild.textContent;
	const r = await render(Balance, { asset: BUSD });
	try {
		assert.equal(figure(r), '12,500.00', 'the first figure is simply shown');
		await act(async () => set('100001250000'));
		await settle(250);
		const midway = figure(r);
		assert.notEqual(midway, '12,500.00');
		assert.notEqual(midway, '1,000,012,500.00', `part way there after a quarter of a second: ${midway}`);
		assert.match(midway, /^[\d,]+\.\d\d$/, 'and what it passes through is still an amount of the asset');
		// A hundred billion units away, and no longer about it than ten would be.
		await settle(700);
		assert.equal(figure(r), '1,000,012,500.00');
	} finally {
		await r.unmount();
	}

	// Past 2^53 a number cannot hold the amount, so it is not counted to: it is shown.
	const big = await render(Balance, { asset: { name: 'Pico', decimalDisplay: 8 } });
	try {
		await act(async () => set('9007199254740993'));
		assert.equal(figure(big), '90,071,992.54740993', 'at once, and to the digit');
	} finally {
		await big.unmount();
	}
});

test('a face is decoration: hidden from a screen reader, and empty until there is an ID', async () => {
	const id = '1f2268a697ea670ea842ec7e8f923c76d3b30860581a79731acc22243e2a06db';
	const r = await render(AssetAvatar, { asset: { assetId: id, type: 'collectible' }, size: 'lg' });
	try {
		const face = r.$('.asset-avatar');
		assert.equal(face.getAttribute('aria-hidden'), 'true');
		assert.ok(face.classList.contains('collectible') && face.classList.contains('lg'), 'a collectible is a rounded square');
		assert.ok(r.$$('circle').length >= 5);
		assert.ok(['light', 'dark'].includes(face.getAttribute('data-ink')));
		assert.match(face.getAttribute('style'), /--av-h1/);
	} finally {
		await r.unmount();
	}
	const none = await render(AssetAvatar, { asset: null });
	try {
		assert.equal(none.$('.asset-avatar').getAttribute('data-seedling'), 'true');
		assert.equal(none.$('svg'), null);
	} finally {
		await none.unmount();
	}
});
