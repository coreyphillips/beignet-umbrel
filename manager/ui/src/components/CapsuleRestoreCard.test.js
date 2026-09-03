/**
 * Run with: npm test (from manager/ui).
 *
 * The checkpoint card: the checkpoint is described honestly (resume held, or
 * funds return on-chain), one click hands the checkpoint's embedded SCB to
 * the SCB restore and the other runs the daemon's exact restore, a checkpoint that names guardians points
 * at the guardian path, and a refusal shows the daemon's reason.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, settle, click } from '../../test/render.mjs';
import { ToastProvider } from './Toast.jsx';
import CapsuleRestoreCard from './CapsuleRestoreCard.jsx';

const offer = (extra = {}) => ({
	channelCount: 2,
	sequence: '412',
	epoch: '1',
	inline: true,
	fromPeer: '02' + 'a'.repeat(64),
	guardians: [],
	candidates: 1,
	...extra
});

function stubApi({ scb = 'beignet-scb-v1:abc', answer } = {}) {
	const api = {
		calls: [],
		get: async (path) => {
			api.calls.push(['GET', path]);
			if (path === '/backup/peer-retrieved') return { encoded: scb, createdAt: 1, fromPeer: 'x' };
			throw new Error('unexpected ' + path);
		},
		post: async (path, body) => {
			api.calls.push(['POST', path, body]);
			if (answer instanceof Error) throw answer;
			return answer;
		}
	};
	return api;
}

const mount = (api, o) =>
	render(ToastProvider, { children: createElement(CapsuleRestoreCard, { api, offer: o, onRestored: () => {} }) });

test('the checkpoint is described honestly and the click runs the SCB recovery', async () => {
	const api = stubApi({ answer: { recovering: ['c1', 'c2'], skipped: [], channelCount: 2 } });
	const r = await mount(api, offer());
	try {
		assert.match(r.text(), /2 channels, sequence 412/);
		assert.match(r.text(), /closes those channels safely and returns the funds on-chain/);
		assert.match(r.text(), /brings them back where the checkpoint left them, held/);
		await click(r.$$('button').find((b) => b.textContent.trim() === 'Recover channel funds'));
		await settle(20);
		assert.deepEqual(api.calls, [
			['GET', '/backup/peer-retrieved'],
			['POST', '/restore/scb', { encoded: 'beignet-scb-v1:abc' }]
		]);
		assert.match(r.text(), /2 channels recovering/);
		assert.equal(r.$$('.error-note').length, 0);
	} finally {
		await r.unmount();
	}
});

test('a checkpoint naming guardians points at the guardian path, with the set listed', async () => {
	const g = { guardianId: 'b'.repeat(64), transports: [{ type: 'https', url: 'https://g.example' }] };
	const r = await mount(stubApi({ answer: {} }), offer({ guardians: [g] }));
	try {
		assert.match(r.text(), /names 1 guardians/);
		assert.ok(r.$('.guardian-list code').textContent.includes('https://g.example'));
	} finally {
		await r.unmount();
	}
});

test('a refusal shows the reason and keeps the button', async () => {
	const api = stubApi({ answer: Object.assign(new Error('SCB decode failed'), { code: 'INVALID_PARAMS' }) });
	const r = await mount(api, offer());
	try {
		await click(r.$$('button').find((b) => b.textContent.trim() === 'Recover channel funds'));
		await settle(20);
		assert.match(r.text(), /refused: SCB decode failed/);
		assert.ok(r.$$('button').find((b) => b.textContent.trim() === 'Recover channel funds'));
	} finally {
		await r.unmount();
	}
});

test('Resume channels runs the exact restore with the confirmation, and says the wallet restarts held', async () => {
	const api = stubApi({ answer: { tier: 2, restartRequired: true, channelCount: 2, writerEpoch: '1', latestSequence: '412' } });
	const r = await mount(api, offer());
	try {
		await click(r.$$('button').find((b) => b.textContent.trim() === 'Resume channels'));
		await settle(20);
		assert.deepEqual(api.calls, [['POST', '/recovery/restore-capsule', { confirm: true }]], 'nothing but the confirmed restore');
		assert.match(r.text(), /Checkpoint installed/);
		assert.match(r.text(), /2 channels come back from the checkpoint, held/);
		assert.match(r.text(), /restarts on the restored state by itself/);
	} finally {
		await r.unmount();
	}
	// A checkpoint that carried only the channel list falls back to the SCB path.
	const tier1 = await mount(stubApi({ answer: { tier: 1, restartRequired: false, channelCount: 2 } }), offer({ inline: false }));
	try {
		await click(tier1.$$('button').find((b) => b.textContent.trim() === 'Resume channels'));
		await settle(20);
		assert.match(tier1.text(), /carried only the channel list/);
	} finally {
		await tier1.unmount();
	}
	const refused = await mount(stubApi({ answer: Object.assign(new Error('The database already holds channels'), { code: 'CAPSULE_RESTORE_TARGET_DIRTY' }) }), offer());
	try {
		await click(refused.$$('button').find((b) => b.textContent.trim() === 'Resume channels'));
		await settle(20);
		assert.match(refused.text(), /refused: The database already holds channels/);
		assert.ok(refused.$$('button').find((b) => b.textContent.trim() === 'Resume channels'), 'both buttons stay');
		assert.ok(refused.$$('button').find((b) => b.textContent.trim() === 'Recover channel funds'));
	} finally {
		await refused.unmount();
	}
});
