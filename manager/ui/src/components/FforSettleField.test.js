/**
 * Run with: npm test (from manager/ui).
 *
 * The per-wallet FFOR roles: settle, witness and issuer toggles, the copy
 * on both sides of each, the issuer riding the witness, the limits behind
 * their disclosure, and the change reaching the form as one block.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { click, render } from '../../test/render.mjs';
import FforSettleField from './FforSettleField.jsx';

function Harness({ initial, log }) {
	const [value, setValue] = useState(initial);
	return createElement(FforSettleField, {
		value,
		onChange: (v) => {
			log.push(v);
			setValue(v);
		}
	});
}

test('off explains the choice; on explains the lock and offers the limits', async () => {
	const log = [];
	const r = await render(Harness, { initial: { settle: { enabled: false } }, log });
	try {
		const box = r.$('[data-testid="ffor-settle"]');
		assert.equal(box.checked, false);
		assert.match(r.text(), /settles no offline receives for anyone/);
		await click(box);
		assert.deepEqual(log[0].settle, { enabled: true });
		assert.match(r.text(), /locks its whole amount on this side of the channel/);
		const toggle = r.$$('button').find((b) => /Limits and fees/.test(b.textContent));
		await click(toggle);
		assert.match(r.text(), /Largest book/);
		assert.match(r.text(), /Fee floor \(ppm\)/);
	} finally {
		await r.unmount();
	}
});

test('the issuer rides the witness: disabled until the witness is on, dropped when it goes off', async () => {
	const log = [];
	const r = await render(Harness, { initial: { settle: { enabled: false } }, log });
	try {
		assert.equal(r.$('[data-testid="ffor-issuer"]').disabled, true);
		assert.match(r.text(), /turn the witness on first/);
		await click(r.$('[data-testid="ffor-witness"]'));
		assert.equal(r.$('[data-testid="ffor-issuer"]').disabled, false);
		assert.match(r.text(), /stores an encrypted receipt/);
		await click(r.$('[data-testid="ffor-issuer"]'));
		assert.equal(log.at(-1).issuer.enabled, true);
		assert.match(r.text(), /next unused voucher of the book/);
		await click(r.$('[data-testid="ffor-witness"]'));
		assert.equal(log.at(-1).witness.enabled, false);
		assert.equal(log.at(-1).issuer.enabled, false, 'the issuer cannot outlive the witness');
	} finally {
		await r.unmount();
	}
});
