/**
 * Run with: npm test (from manager/ui).
 *
 * A direct funding that took 71 s showed three lines in the wallet log and
 * nothing on the payment. The steps are what say where the time went, so they
 * have to read in order, each with its time (umbrel #147).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, settle } from '../../test/render.mjs';
import { FundingSteps, LiveFundingSteps } from './FundingSteps.jsx';

const REQUEST = 'd'.repeat(32);
const T0 = new Date('2026-09-14T10:00:00Z').getTime();

const STEPS = [
	{ timestamp: T0, action: 'df_send_started', data: { requestId: REQUEST } },
	{ timestamp: T0 + 30_100, action: 'df_lane_skipped', data: { transportType: 2, reason: 'lane_not_established', error: 'dial timed out' } },
	{ timestamp: T0 + 71_500, action: 'df_send_committed', data: { requestId: REQUEST } },
	{ timestamp: T0 + 73_800, action: 'df_send_completed', data: { requestId: REQUEST } }
];

const rows = (view) => view.$$('li').map((li) => li.textContent.replace(/\s+/g, ' ').trim());

test('a direct funding\'s steps render in order, each with its time and its distance from the offer', async () => {
	const view = await render(FundingSteps, { steps: STEPS });
	const at = (ms) => new Date(T0 + ms).toLocaleTimeString();
	assert.deepEqual(rows(view), [
		`${at(0)} +0.0 s Offer sent`,
		`${at(30_100)} +30.1 s Route skipped: onion message (could not connect: dial timed out)`,
		`${at(71_500)} +71.5 s Recipient accepted, funding signed`,
		`${at(73_800)} +73.8 s Receipt received`
	]);
	await view.unmount();
});

test('no steps render nothing, not an empty heading', async () => {
	for (const steps of [null, []]) {
		const view = await render(FundingSteps, { steps });
		assert.equal(view.text(), '');
		await view.unmount();
	}
});

test('the live list asks the manager until the attempt ends, then stops asking', async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	const asked = [];
	globalThis.fetch = async (url) => {
		asked.push(String(url));
		// The receipt lands between the first and the second ask.
		const steps = asked.length === 1 ? STEPS.slice(0, 3) : STEPS;
		return { ok: true, status: 200, json: async () => ({ ok: true, result: steps }) };
	};
	const view = await render(LiveFundingSteps, { walletId: 'w1', requestId: REQUEST });
	await settle(50);
	assert.equal(asked[0], `/api/wallets/w1/direct-funding/steps?requestId=${REQUEST}`);
	assert.equal(rows(view).length, 3);
	assert.doesNotMatch(view.text(), /Receipt received/);

	await settle(3100);
	assert.match(view.text(), /Receipt received/);
	const settled = asked.length;
	await settle(3100);
	assert.equal(asked.length, settled, 'an attempt that has ended is not asked about again');
	await view.unmount();
});

test('the live list survives the manager not answering', async (t) => {
	const realFetch = globalThis.fetch;
	t.after(() => {
		globalThis.fetch = realFetch;
	});
	globalThis.fetch = async () => {
		throw new TypeError('Failed to fetch');
	};
	const view = await render(LiveFundingSteps, { walletId: 'w1', requestId: REQUEST });
	await settle(50);
	assert.equal(view.text(), '');
	await view.unmount();
});
