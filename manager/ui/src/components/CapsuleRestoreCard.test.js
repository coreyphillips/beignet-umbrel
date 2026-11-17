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

import { type as typeInto } from '../../test/render.mjs';

const ASSET_CHANNELS = [
	{ channelId: 'aa'.repeat(32), peerPubkey: '02' + 'b'.repeat(64), capacitySats: 100000 },
	{ channelId: 'cc'.repeat(32), peerPubkey: '03' + 'd'.repeat(64), capacitySats: 250000 }
];
const refusedOver = (code, channels = ASSET_CHANNELS) =>
	Object.assign(new Error('the capsule holds asset channels'), { code, status: 409, details: channels ? { assetChannels: channels } : null });

/** An api whose restore answers in turn: an Error is thrown, anything else returned. */
function restoreApi(answers) {
	const api = {
		calls: [],
		get: async (path) => {
			throw new Error('unexpected ' + path);
		},
		post: async (path, body) => {
			api.calls.push(['POST', path, body]);
			const answer = answers.shift();
			if (answer instanceof Error) throw answer;
			return answer;
		}
	};
	return api;
}
const by = (r, id) => r.$(`[data-testid="${id}"]`);

test('a checkpoint that holds asset channels: the refusal lists them, and the restore without them waits for the typed phrase', async () => {
	const api = restoreApi([refusedOver('ASSET_RESTORE_REFUSED'), { tier: 2, restartRequired: true, channelCount: 2, omittedAssetChannels: ASSET_CHANNELS, unresolvedPayments: ['a1'.repeat(32), 'b2'.repeat(32), 'c3'.repeat(32)] }]);
	let dismissed = 0;
	const r = await render(ToastProvider, { children: createElement(CapsuleRestoreCard, { api, offer: offer(), onRestored: () => {}, onDismiss: () => (dismissed += 1) }) });
	try {
		assert.equal(by(r, 'capsule-asset-channels'), null, 'nothing about asset channels until the daemon names them');
		await click(r.$$('button').find((b) => b.textContent.trim() === 'Resume channels'));
		await settle(20);
		assert.deepEqual(api.calls, [['POST', '/recovery/restore-capsule', { confirm: true }]], 'the first call asks for nothing to be left out');

		const panel = by(r, 'capsule-asset-channels');
		assert.equal(panel.getAttribute('data-code'), 'ASSET_RESTORE_REFUSED');
		const listed = [...by(r, 'capsule-asset-channel-list').querySelectorAll('li')].map((li) => li.textContent);
		assert.equal(listed.length, 2);
		assert.match(listed[0], /^with 02b\S+, 100,000 sats$/, 'the peer and the capacity');
		assert.match(listed[1], /^with 03d\S+, 250,000 sats$/);
		assert.match(panel.textContent, /nothing was restored and nothing was written: the checkpoint holds 2 asset channels/);
		assert.match(panel.textContent, /The bitcoin channels then come back, held as said above, and\s+payments and invoices are kept\./);
		assert.match(panel.textContent, /The asset channels do not come back: this wallet will have no\s+record of them and cannot bring the assets in them back by\s+itself afterwards\. The peer of each can still close its channel\./);

		// Not without the phrase, and not with another one.
		const confirm = by(r, 'capsule-omit-confirm');
		assert.equal(confirm.textContent.trim(), 'Restore without the asset channels');
		assert.equal(confirm.disabled, true);
		await typeInto(by(r, 'capsule-omit-typed'), 'leave them');
		assert.equal(by(r, 'capsule-omit-confirm').disabled, true);
		assert.equal(api.calls.length, 1);
		await typeInto(by(r, 'capsule-omit-typed'), 'Leave them out ');
		assert.equal(by(r, 'capsule-omit-confirm').disabled, false);
		await click(by(r, 'capsule-omit-confirm'));
		await settle(20);
		assert.deepEqual(api.calls[1], ['POST', '/recovery/restore-capsule', { confirm: true, omitAssetChannels: true }], 'the confirmed call, and only it, leaves them out');
		assert.equal(api.calls.length, 2);

		// The result says what was left out, from the answer.
		assert.match(r.text(), /Checkpoint installed/);
		const left = by(r, 'capsule-omitted');
		assert.match(left.textContent, /^2 asset channels were left out of the restore, as asked\. This wallet has no record\s+of them and cannot bring the assets in them back by itself\. The peer of each\s+can still close its channel\./);
		assert.equal(by(r, 'capsule-omitted-list').querySelectorAll('li').length, 2);
		// And how many payments that leaves with no end this wallet can learn of.
		const unresolved = by(r, 'capsule-unresolved');
		assert.equal(unresolved.getAttribute('data-count'), '3');
		assert.equal(
			unresolved.textContent.replace(/\s+/g, ' ').trim(),
			'3 payments that were under way on those channels are left unresolved. This wallet no longer holds the channels that would say how they ended, so each stays pending for good: it is not counted as paid or as failed, and it cannot be cancelled or tried again from here.'
		);
		await click(by(r, 'capsule-omitted-done'));
		assert.equal(dismissed, 1);
	} finally {
		await r.unmount();
	}
});

test('a restore that left nothing out says nothing of asset channels, and one refused without a list has no way round', async () => {
	const plain = await mount(restoreApi([{ tier: 2, restartRequired: true, channelCount: 2 }]), offer());
	try {
		await click(plain.$$('button').find((b) => b.textContent.trim() === 'Resume channels'));
		await settle(20);
		assert.match(plain.text(), /Checkpoint installed/);
		assert.equal(by(plain, 'capsule-omitted'), null);
		assert.equal(by(plain, 'capsule-unresolved'), null);
		assert.equal(by(plain, 'capsule-omitted-done'), null);
	} finally {
		await plain.unmount();
	}
	// A daemon that refuses and names no channel: the sentence, and nothing that could send the option.
	for (const [code, said] of [
		['ASSET_RESTORE_REFUSED', /holds an asset channel, which a restore does not bring back, so nothing was restored and nothing was written/],
		['ASSET_PROVIDER_REQUIRED', /the assets part of this wallet is not running to take it, so nothing was restored and nothing was written/]
	]) {
		const api = restoreApi([refusedOver(code, null)]);
		const r = await mount(api, offer());
		try {
			await click(r.$$('button').find((b) => b.textContent.trim() === 'Resume channels'));
			await settle(20);
			assert.match(r.text(), said, code);
			assert.equal(by(r, 'capsule-asset-channels'), null);
			assert.equal(by(r, 'capsule-omit-confirm'), null);
			assert.deepEqual(api.calls, [['POST', '/recovery/restore-capsule', { confirm: true }]]);
		} finally {
			await r.unmount();
		}
	}
	// No extension to take them, with the list: the same way round.
	const required = restoreApi([refusedOver('ASSET_PROVIDER_REQUIRED', [ASSET_CHANNELS[0]])]);
	const one = await mount(required, offer());
	try {
		await click(one.$$('button').find((b) => b.textContent.trim() === 'Resume channels'));
		await settle(20);
		assert.equal(by(one, 'capsule-asset-channels').getAttribute('data-code'), 'ASSET_PROVIDER_REQUIRED');
		assert.match(by(one, 'capsule-asset-channels').textContent, /the checkpoint holds an asset channel, which this wallet cannot bring back from it/);
		assert.equal(by(one, 'capsule-omit-confirm').disabled, true);
	} finally {
		await one.unmount();
	}
});

test('a card mounted again after the wallet restarted shows what the restore left out, and not the offer', async () => {
	const api = restoreApi([]);
	let dismissed = 0;
	const r = await render(ToastProvider, {
		children: createElement(CapsuleRestoreCard, {
			api,
			offer: offer(),
			restored: { tier: 2, restartRequired: true, channelCount: 2, omittedAssetChannels: ASSET_CHANNELS },
			onRestored: () => {},
			onDismiss: () => (dismissed += 1)
		})
	});
	try {
		assert.match(r.text(), /Checkpoint installed/);
		assert.equal(by(r, 'capsule-omitted-list').querySelectorAll('li').length, 2);
		assert.equal(r.$$('button').find((b) => b.textContent.trim() === 'Resume channels'), undefined, 'nothing to restore again');
		await click(by(r, 'capsule-omitted-done'));
		assert.equal(dismissed, 1);
		assert.deepEqual(api.calls, []);
	} finally {
		await r.unmount();
	}
});
