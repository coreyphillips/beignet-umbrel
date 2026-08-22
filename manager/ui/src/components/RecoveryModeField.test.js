/**
 * Run with: npm test (from manager/ui).
 *
 * The channel backup selector shared by the create form and the edit
 * dialog: guardian modes are offered only with a guardian set to register
 * with, the selected mode explains itself, and a pinned set is shown as the
 * wallet's own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, select } from '../../test/render.mjs';
import RecoveryModeField from './RecoveryModeField.jsx';

const G = ['a'.repeat(64) + '@http://127.0.0.1:8101', 'b'.repeat(64) + '@http://127.0.0.1:8102', 'c'.repeat(64) + '@https://g.example'];

function Harness(props) {
	return createElement(RecoveryModeField, props);
}

test('without a guardian set the guardian modes are listed but disabled, with directions', async () => {
	const r = await render(Harness, { value: 'off', onChange: () => {}, guardiansConfigured: false });
	try {
		const options = r.$$('option');
		assert.equal(options.length, 4);
		assert.equal(options.find((o) => o.value === 'quorum').disabled, true);
		assert.equal(options.find((o) => o.value === 'async-remote').disabled, true);
		assert.equal(options.find((o) => o.value === 'peer-storage').disabled, false);
		assert.match(r.text(), /Set three guardians in Settings/);
	} finally {
		await r.unmount();
	}
});

test('the selected mode explains itself, and quorum says it is permanent', async () => {
	let value = 'off';
	const r = await render(Harness, { value, onChange: (v) => (value = v), guardiansConfigured: true });
	try {
		assert.match(r.text(), /Nothing is kept beyond the seed/);
		await select(r.$('select'), 'quorum');
		assert.equal(value, 'quorum');
	} finally {
		await r.unmount();
	}
	const q = await render(Harness, { value: 'quorum', onChange: () => {}, guardiansConfigured: true });
	try {
		assert.match(q.text(), /cannot go back to a weaker setting/);
		assert.doesNotMatch(q.text(), /Set three guardians in Settings/);
	} finally {
		await q.unmount();
	}
});

test('peer storage says how its restore is reached and that nothing fences the old device', async () => {
	const r = await render(Harness, { value: 'peer-storage', onChange: () => {}, guardiansConfigured: false });
	try {
		assert.match(r.text(), /recover from the newest checkpoint/);
		assert.match(r.text(), /Nothing fences the old device/);
	} finally {
		await r.unmount();
	}
});

test('a pinned set keeps the guardian modes usable and is shown as the wallet\'s own', async () => {
	const r = await render(Harness, {
		value: 'async-remote',
		onChange: () => {},
		guardiansConfigured: false,
		pinnedGuardians: G,
		settingsGuardians: []
	});
	try {
		assert.equal(r.$$('option').find((o) => o.value === 'quorum').disabled, false, 'the pinned set is a set');
		assert.match(r.text(), /fixed to the set it first registered with/);
		assert.equal(r.$$('.guardian-list li').length, 3);
		assert.doesNotMatch(r.text(), /Settings now lists a different set/);
	} finally {
		await r.unmount();
	}
	const other = [G[1], G[2], 'd'.repeat(64) + '@http://x'];
	const d = await render(Harness, {
		value: 'quorum',
		onChange: () => {},
		guardiansConfigured: true,
		pinnedGuardians: G,
		settingsGuardians: other
	});
	try {
		assert.match(d.text(), /Settings now lists a different set; this wallet keeps its own/);
	} finally {
		await d.unmount();
	}
});

test('a wallet locked to quorum has every weaker option disabled', async () => {
	const r = await render(Harness, { value: 'quorum', onChange: () => {}, guardiansConfigured: true, lockedToQuorum: true });
	try {
		const options = r.$$('option');
		assert.equal(options.find((o) => o.value === 'quorum').disabled, false);
		for (const v of ['off', 'peer-storage', 'async-remote']) {
			assert.equal(options.find((o) => o.value === v).disabled, true, v);
		}
	} finally {
		await r.unmount();
	}
});

test('the import tab says how a guardian restore is reached', async () => {
	const r = await render(Harness, { value: 'quorum', onChange: () => {}, guardiansConfigured: true, importing: true });
	try {
		assert.match(r.text(), /the next page offers the restore/);
	} finally {
		await r.unmount();
	}
});
