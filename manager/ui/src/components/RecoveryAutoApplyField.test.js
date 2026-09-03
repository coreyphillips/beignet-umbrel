/**
 * Run with: npm test (from manager/ui).
 *
 * The one-time question a peer-storage import asks: the checkbox, the
 * honest copy on both sides of it, and the change reaching the form.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { click, render } from '../../test/render.mjs';
import RecoveryAutoApplyField from './RecoveryAutoApplyField.jsx';

function Harness({ initial, log }) {
	const [value, setValue] = useState(initial);
	return createElement(RecoveryAutoApplyField, {
		value,
		onChange: (v) => {
			log.push(v);
			setValue(v);
		}
	});
}

test('off says when to leave it off; on says what happens and that nothing fences the old device', async () => {
	const log = [];
	const r = await render(Harness, { initial: false, log });
	try {
		const box = r.$('[data-testid="recovery-auto-apply"]');
		assert.equal(box.checked, false);
		assert.match(r.text(), /The previous device is stopped\. Restore my channels from my peers' copies automatically\./);
		assert.match(r.text(), /Leave this off if the previous device may still be running/);
		await click(box);
		assert.deepEqual(log, [true]);
		assert.equal(r.$('[data-testid="recovery-auto-apply"]').checked, true);
		assert.match(r.text(), /the newest one is applied by itself and the channels come back held/);
		assert.match(r.text(), /Nothing fences the old device in this mode/);
		assert.match(r.text(), /if the previous device is still running, both act on the same channels/);
	} finally {
		await r.unmount();
	}
});
