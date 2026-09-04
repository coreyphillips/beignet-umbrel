/**
 * Run with: npm test (from manager/ui).
 *
 * The per-wallet "serve as guardian" toggle: the checkbox, the copy on both
 * sides of it, the reachability hint, and the change reaching the form.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { click, render } from '../../test/render.mjs';
import GuardianServeField from './GuardianServeField.jsx';

function Harness({ initial, log, announce }) {
	const [value, setValue] = useState(initial);
	return createElement(GuardianServeField, {
		value,
		announce,
		onChange: (v) => {
			log.push(v);
			setValue(v);
		}
	});
}

test('off explains the choice; on explains the obligation and where the address is', async () => {
	const log = [];
	const r = await render(Harness, { initial: false, log, announce: false });
	try {
		const box = r.$('[data-testid="guardian-serve"]');
		assert.equal(box.checked, false);
		assert.match(r.text(), /Serve as a guardian for other beignet nodes/);
		assert.match(r.text(), /this node holds no channel state for anyone else/);
		await click(box);
		assert.deepEqual(log, [true]);
		assert.equal(r.$('[data-testid="guardian-serve"]').checked, true);
		assert.match(r.text(), /pin this node as one of their three guardians/);
		assert.match(r.text(), /refuses new writes rather than deleting/);
		// Without a Tor address nobody off this Umbrel can reach it: say so.
		assert.match(r.text(), /Turn on the Tor address below/);
	} finally {
		await r.unmount();
	}
});

test('with the Tor address on, it points at the Overview tab for the address to share', async () => {
	const r = await render(Harness, { initial: true, log: [], announce: true });
	try {
		assert.match(r.text(), /The address to share is on the Overview tab/);
		assert.doesNotMatch(r.text(), /Turn on the Tor address below/);
	} finally {
		await r.unmount();
	}
});
