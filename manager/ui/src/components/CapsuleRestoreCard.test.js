/**
 * Run with: npm test (from manager/ui).
 *
 * The checkpoint card: the checkpoint is described honestly (funds return
 * on-chain; no resume with this engine), the click hands the checkpoint's
 * embedded SCB to the SCB restore, a checkpoint that names guardians points
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
		assert.match(r.text(), /cannot yet resume them/);
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
