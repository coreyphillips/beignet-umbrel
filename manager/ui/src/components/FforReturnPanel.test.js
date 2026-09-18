/**
 * Run with: npm test (from manager/ui).
 *
 * The return panel above the tabs: what a return came to, and Enforce
 * through the manager, so a refusal the daemon answers inside a 200 is
 * shown as the refusal it is rather than as a broadcast.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle } from '../../test/render.mjs';
import { ToastProvider } from './Toast.jsx';
import FforReturnPanel from './FforReturnPanel.jsx';

const CH = 'ab'.repeat(32);
const ret = (extra) => ({
	at: Date.now(),
	channelId: CH,
	action: 'nothing',
	preimagesKnown: [],
	witnesses: [],
	epoch: { state: 'ACTIVE', epochId: 'e1', slots: [{ k: 1, state: 'exposed' }], activationMismatch: false },
	error: null,
	...extra
});

function stubManager(answer) {
	globalThis.fetch = async (url, opts) => {
		if (/ffor\/enforce$/.test(url) && opts && opts.method === 'POST') {
			if (answer instanceof Error) return { ok: false, status: 502, json: async () => ({ ok: false, error: { code: 'FFOR_ENFORCE_REFUSED', message: answer.message } }) };
			return { ok: true, status: 200, json: async () => ({ ok: true, result: answer }) };
		}
		return { ok: true, status: 200, json: async () => ({ ok: true, result: null }) };
	};
}

async function mount(rec) {
	sessionStorage.clear();
	const view = await render(ToastProvider, {
		children: createElement(FforReturnPanel, { id: 'w1', api: { post: async () => ({}) }, rec, onChanged: () => {} })
	});
	await settle(100);
	return view;
}

test('an unreachable peer offers Try again and Enforce; a refused enforce is shown as the refusal', async () => {
	stubManager(new Error('channel restored from a capsule: pass acceptStaleStateRisk'));
	const view = await mount({ fforReturn: ret() });
	try {
		assert.match(view.text(), /not reachable/);
		assert.ok(view.$$('button').find((b) => /Try again/.test(b.textContent)));
		await click(view.$$('button').find((b) => /Enforce on-chain/.test(b.textContent)));
		await settle(100);
		await click(view.$$('button').find((b) => /Force close and claim/.test(b.textContent)));
		await settle(300);
		assert.match(view.text(), /pass acceptStaleStateRisk/);
		assert.doesNotMatch(view.text(), /Force close broadcast/);
	} finally {
		await view.unmount();
	}
});

test('a drain in progress and an epoch closed on-chain offer neither', async () => {
	stubManager({});
	const draining = await mount({ fforReturn: ret({ outcome: 'draining', epoch: { state: 'DRAINING', epochId: 'e1', slots: [{ k: 1, state: 'settled' }] } }) });
	try {
		assert.match(draining.text(), /Closing the book/);
		assert.equal(draining.$$('button').filter((b) => /Enforce|Try again/.test(b.textContent)).length, 0);
	} finally {
		await draining.unmount();
	}
	const enforced = await mount({ fforReturn: ret({ at: 5 }), fforEnforce: null, fforEnforced: { at: Date.now(), channelId: CH, commitmentTxid: 'cd'.repeat(32) } });
	try {
		assert.match(enforced.text(), /Enforced on-chain/);
		assert.match(enforced.text(), /cdcdcdcdcdcd/);
		assert.equal(enforced.$$('button').filter((b) => /Enforce on-chain|Try again/.test(b.textContent)).length, 0);
	} finally {
		await enforced.unmount();
	}
});
