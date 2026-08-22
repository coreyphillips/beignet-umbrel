/**
 * Run with: npm test (from manager/ui).
 *
 * The guardian restore panel, driven by a stub whose /recovery/status answer
 * the test swaps: the hold offers the restore, progress follows the latest
 * event, and the channel phase never reads complete while a channel is still
 * reconciling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, settle, click } from '../../test/render.mjs';
import { ToastProvider } from './Toast.jsx';
import RestorePanel from './RestorePanel.jsx';

function stubApi(initial) {
	const api = {
		status: initial,
		calls: [],
		get: async (path) => {
			api.calls.push(['GET', path]);
			if (path === '/recovery/status') return api.status;
			throw Object.assign(new Error('NODE_RESTORE_PENDING'), { code: 'NODE_RESTORE_PENDING' });
		},
		post: async (path, body) => {
			api.calls.push(['POST', path, body]);
			if (api.postError) throw api.postError;
			return { exact: true, framesApplied: 9, guardiansRepaired: 0, epoch: '3' };
		}
	};
	return api;
}

const node = (extra = {}) => ({
	gate: 'confirmed',
	durability: 'quorum',
	startupRepairPending: false,
	lastDurableSequence: '1291',
	awaitingDurabilityCount: 0,
	fenced: false,
	backfillLost: false,
	channels: [],
	...extra
});
const ch = (status, i) => ({ channelId: String(i).repeat(64), status, awaitingDurability: false });
const GUARDIANS = [{ guardianId: 'a'.repeat(64), url: 'http://127.0.0.1:8701' }];

const mount = (api, extra = {}) =>
	render(ToastProvider, {
		children: createElement(RestorePanel, { id: 'w1', api, rec: {}, tick: 0, onDone: () => {}, ...extra })
	});

test('the hold offers the restore and the click posts the confirmation', async () => {
	const api = stubApi({ mode: 'quorum', profile: 'crash-v1', guardians: GUARDIANS, state: 'restore-required', node: null, restore: { inProgress: false } });
	const r = await mount(api);
	try {
		await settle(20);
		assert.match(r.text(), /fenced off and can never use these channels again/);
		const btn = r.$$('button').find((b) => b.textContent.trim() === 'Restore channels');
		assert.ok(btn, 'the restore button is offered');
		await click(btn);
		await settle(20);
		const posted = api.calls.find(([m, p]) => m === 'POST' && p === '/recovery/restore');
		assert.deepEqual(posted[2], { confirm: true });
	} finally {
		await r.unmount();
	}
});

test('progress marks the steps before the latest event done and the one holding it current', async () => {
	const api = stubApi({
		mode: 'quorum',
		profile: 'crash-v1',
		guardians: GUARDIANS,
		state: 'restoring',
		node: null,
		restore: { inProgress: true, lastEvent: { type: 'frames:downloaded', detail: '9 records through sequence 1291' } }
	});
	const r = await mount(api);
	try {
		await settle(20);
		const classes = r.$$('.restore-steps li').map((li) => li.className);
		assert.deepEqual(classes, ['done', 'done', 'done', 'current', 'todo', 'todo']);
		assert.match(r.text(), /9 records through sequence 1291/);
		assert.equal(r.$$('button').find((b) => b.textContent.trim() === 'Restore channels'), undefined, 'no button mid-restore');
	} finally {
		await r.unmount();
	}
});

test('a restore already running elsewhere is not an error', async () => {
	const api = stubApi({ mode: 'quorum', profile: 'crash-v1', guardians: GUARDIANS, state: 'restore-required', node: null, restore: { inProgress: false } });
	api.postError = Object.assign(new Error('already running'), { code: 'RESTORE_IN_PROGRESS' });
	const r = await mount(api);
	try {
		await settle(20);
		await click(r.$$('button').find((b) => b.textContent.trim() === 'Restore channels'));
		await settle(20);
		assert.doesNotMatch(r.text(), /refused/);
	} finally {
		await r.unmount();
	}
});

test('a refusal shows the daemon\'s reason and keeps the button', async () => {
	const api = stubApi({ mode: 'quorum', profile: 'crash-v1', guardians: GUARDIANS, state: 'restore-required', node: null, restore: { inProgress: false } });
	api.postError = Object.assign(new Error('only 1 of 3 guardians answered; deciding ownership needs 2'), { code: 'RESTORE_NO_QUORUM' });
	const r = await mount(api);
	try {
		await settle(20);
		await click(r.$$('button').find((b) => b.textContent.trim() === 'Restore channels'));
		await settle(20);
		assert.match(r.text(), /refused the restore: only 1 of 3 guardians answered/);
		assert.ok(r.$$('button').find((b) => b.textContent.trim() === 'Restore channels'), 'try again is offered');
	} finally {
		await r.unmount();
	}
});

test('the channel phase counts landed channels, words the DLP path safely, and is not complete early', async () => {
	const api = stubApi({
		mode: 'quorum',
		profile: 'crash-v1',
		guardians: GUARDIANS,
		state: 'running',
		node: node({ channels: [ch('active', 1), ch('reestablishing', 2), ch('local_data_loss', 3)] })
	});
	const r = await mount(api);
	try {
		await settle(20);
		assert.match(r.text(), /Channels resuming: 2 of 3 \(1 closing safely, funds return on-chain\)/);
		assert.match(r.text(), /closing safely, funds return on-chain/);
		assert.doesNotMatch(r.text(), /Restore complete/);
		assert.equal(r.$$('.error-note').length, 0, 'a channel closing safely is never styled as an error');
		assert.ok(r.$$('button').find((b) => b.textContent.trim() === 'Leave this for now'));
	} finally {
		await r.unmount();
	}
});

test('every channel landed and the gate open reads complete', async () => {
	const api = stubApi({
		mode: 'quorum',
		profile: 'crash-v1',
		guardians: GUARDIANS,
		state: 'running',
		node: node({ channels: [ch('active', 1), ch('active', 2), ch('force_closing', 3)] })
	});
	let done = false;
	const r = await mount(api, { onDone: () => (done = true) });
	try {
		await settle(20);
		assert.match(r.text(), /Restore complete/);
		const btn = r.$$('button').find((b) => b.textContent.trim() === 'Go to overview');
		assert.ok(btn);
		await click(btn);
		assert.equal(done, true);
	} finally {
		await r.unmount();
	}
});
