/**
 * Run with: npm test (from manager/ui).
 *
 * The per-wallet "settle offline receives" toggle: the checkbox, the copy on
 * both sides of it, the limits behind their disclosure, and the change
 * reaching the form.
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
	const r = await render(Harness, { initial: { enabled: false }, log });
	try {
		const box = r.$('[data-testid="ffor-settle"]');
		assert.equal(box.checked, false);
		assert.match(r.text(), /settles no offline receives for anyone/);
		await click(box);
		assert.deepEqual(log, [{ enabled: true }]);
		assert.match(r.text(), /locks its whole amount on this side of the channel/);
		const toggle = r.$$('button').find((b) => /Limits and fees/.test(b.textContent));
		await click(toggle);
		assert.match(r.text(), /Largest book/);
		assert.match(r.text(), /Fee floor \(ppm\)/);
	} finally {
		await r.unmount();
	}
});
