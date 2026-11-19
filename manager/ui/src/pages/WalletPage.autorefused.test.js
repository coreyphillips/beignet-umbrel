/**
 * Run with: npm test (from manager/ui).
 *
 * The wallet's own apply of a checkpoint, refused over asset channels, as an
 * event. The daemon says it on the wallet's stream (`recovery:restore-progress`
 * of type `capsule:auto-refused`, with the route's code and the list), and the
 * wallet page keeps what it heard so that the card that offers the restore
 * opens on the list before the status has been read again. Here the demo
 * daemon emits the event, the page's handler takes it, and the card is drawn
 * from a status that does not say it yet.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render } from '../../test/render.mjs';
import { ToastProvider } from '../components/Toast.jsx';
import CapsuleRestoreCard from '../components/CapsuleRestoreCard.jsx';
import { capsuleOffer, heardAutoRefusal } from '../lib/recovery.js';

// The demo, with its switch read from the page's own address.
sessionStorage.setItem('beignet-demo', '1');
window.history.pushState({}, '', '/w/demo-autorestore?assets-demo=capsule-auto-refused');
const { mockEvents, mockRequest } = await import('../mock/mockApi.js');

const by = (r, id) => r.$(`[data-testid="${id}"]`);

// The demo keeps timers of its own going for as long as its page is open
// (its ambient events, the rest of this script). Nothing here waits for
// them: once the tests have reported, the file is done.
after(() => {
	setTimeout(() => process.exit(process.exitCode || 0), 500);
});

test('the page keeps a refusal over asset channels that it hears, and nothing else it hears', () => {
	const refusal = { code: 'ASSET_RESTORE_REFUSED', assetChannels: [{ channelId: 'aa'.repeat(32), peerPubkey: `02${'b'.repeat(64)}`, capacitySats: 100000 }] };
	const said = { type: 'capsule:auto-refused', detail: 'nothing was installed', refusal };
	assert.equal(heardAutoRefusal('recovery:restore-progress', said), said);
	assert.equal(heardAutoRefusal('recovery:restore-progress', { type: 'capsule:selecting', detail: 'selecting the newest of 1 checkpoint' }), null);
	assert.equal(heardAutoRefusal('recovery:restore-progress', { type: 'capsule:auto-refused', detail: 'guardians named' }), null, 'a refusal that names no asset channel');
	assert.equal(heardAutoRefusal('recovery:restore-progress', { type: 'capsule:auto-refused', refusal: { code: 'ASSET_RESTORE_REFUSED', assetChannels: [] } }), null);
	assert.equal(heardAutoRefusal('recovery:restored', said), null, 'only on the progress of a restore');
	assert.equal(heardAutoRefusal('recovery:restore-progress', null), null);
});

test('the demo daemon says its refused apply as an event, and the card opens on the list from it before the status is read again', async () => {
	const heard = [];
	const stop = mockEvents.subscribe('demo-autorestore', (name, data) => heard.push([name, data]));
	let r = null;
	try {
		// What the page knew before the event: a checkpoint a peer returned, and an apply still to come.
		const before = await mockRequest('/wallets/demo-autorestore/api/recovery/status');
		const info = await mockRequest('/wallets/demo-autorestore/api/info');
		const stale = { ...before, autoApply: { enabled: true, phase: 'settling', settleUntil: null, lastReason: null } };
		assert.equal(capsuleOffer(stale, info, null), null, 'a wallet that applies by itself is offered nothing while it has not been refused');

		const said = await new Promise((resolve, reject) => {
			const started = Date.now();
			const look = () => {
				const hit = heard.map(([name, data]) => heardAutoRefusal(name, data)).find(Boolean);
				if (hit) return resolve(hit);
				if (Date.now() - started > 20000) return reject(new Error(`the demo did not say its apply was refused: ${JSON.stringify(heard.map(([n, d]) => [n, d && d.type]))}`));
				setTimeout(look, 100);
			};
			look();
		});
		assert.equal(said.type, 'capsule:auto-refused');
		assert.equal(said.refusal.code, 'ASSET_RESTORE_REFUSED');
		assert.ok(said.refusal.assetChannels.length >= 1);
		for (const c of said.refusal.assetChannels) assert.deepEqual(Object.keys(c).sort(), ['capacitySats', 'channelId', 'peerPubkey']);
		assert.ok(!heard.some(([, d]) => d && (d.type === 'capsule:installed' || d.type === 'restore:complete')), 'and nothing is applied');

		const offer = capsuleOffer(stale, info, said);
		assert.ok(offer && offer.refused, 'the offer carries what was heard');
		assert.equal(offer.refused.channels.length, said.refusal.assetChannels.length);
		r = await render(ToastProvider, { children: createElement(CapsuleRestoreCard, { api: { get: async () => null, post: async () => null }, offer, onRestored: () => {} }) });
		const note = by(r, 'capsule-asset-channels');
		assert.ok(note, 'the card opens on the asset channels');
		assert.equal(note.getAttribute('data-auto'), 'yes');
		assert.match(note.textContent, /^The wallet did not apply this checkpoint by itself, and nothing was restored and nothing was written/);
		assert.equal(by(r, 'capsule-asset-channel-list').querySelectorAll('li').length, said.refusal.assetChannels.length);

		// The checkpoint still waits: the status goes on saying so, with the same list.
		const after = await mockRequest('/wallets/demo-autorestore/api/recovery/status');
		assert.equal(after.autoApply.phase, 'refused');
		assert.deepEqual(after.autoApply.refusal.assetChannels, said.refusal.assetChannels);
		assert.ok(after.capsules && after.capsules.best, 'the checkpoint is still there');
	} finally {
		stop();
		if (r) await r.unmount();
	}
});
