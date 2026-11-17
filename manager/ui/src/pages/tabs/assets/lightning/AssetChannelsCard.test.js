/**
 * Run with: npm test (from manager/ui).
 *
 * Asset channels on the Channels tab: the list, opening one, closing one.
 * A channel funded with an asset is counted in the asset, so every figure is
 * in its units and the one in sats says so. Opening says what it costs in
 * bitcoin before the button works and happens once, a peer that does not
 * take asset channels is refused in plain words with nothing spent, and a
 * force close is never one press away.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useState } from 'react';
import { assetsBackend } from '../../../../../test/assets-backend.mjs';
import { click, render, select, settle, type } from '../../../../../test/render.mjs';
import { ToastProvider } from '../../../../components/Toast.jsx';
import AssetChannelsCard from './AssetChannelsCard.jsx';

test.beforeEach(() => sessionStorage.clear());

const PEER = `02${'ab'.repeat(32)}`;
// The demo's peer that does not take asset channels: a key that starts 02 and eight zeros.
const PLAIN_PEER = `0200000000${'cd'.repeat(28)}`;
// A cost is asked for a beat after the form stops moving.
const PRICED_MS = 350;
const ANSWERED_MS = 80;

/** The card over a backend, as the Channels tab mounts it, with a way to make it ask again. */
async function mount(backend, { id = 'demo-main', api, route, go, status } = {}) {
	let bump = () => {};
	const moves = [];
	function Page() {
		const [tick, setTick] = useState(0);
		bump = () => setTick((n) => n + 1);
		return createElement(
			ToastProvider,
			null,
			createElement(AssetChannelsCard, {
				id,
				api: api || backend.api(id),
				tick,
				bump: () => {},
				route: route || { query: {}, state: null },
				go: go || ((to, options) => moves.push([to, options || {}])),
				status
			})
		);
	}
	const r = await render(Page, {});
	await settle(30);
	return {
		...r,
		moves,
		test: (name) => r.$(`[data-testid="${name}"]`),
		tests: (name) => r.$$(`[data-testid="${name}"]`),
		toasts: () => r.$$('.toast').map((t) => t.textContent),
		/** Let time pass in the wallet, and the card hear about it. */
		async pass(ms) {
			backend.pass(ms);
			await act(async () => bump());
			await settle(30);
		}
	};
}

const chip = (r, name) => r.$$('.asset-chip').find((b) => b.querySelector('.asset-chip-name').textContent === name);
const busdOf = async (backend, id = 'demo-main') => (await backend.api(id).get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');

/** The open dialog with BUSD chosen, an amount typed and a peer named. */
async function filled(r, { amount = '1000', peer = `${PEER}@10.0.0.9:9736` } = {}) {
	await click(r.test('asset-channel-open'));
	await settle(60);
	await click(chip(r, 'BUSD'));
	if (amount) await type(r.test('asset-channel-amount'), amount);
	if (peer) await type(r.test('asset-channel-peer-input'), peer);
	await settle(PRICED_MS);
}

test('a channel is shown in the asset it holds: both sides, what can move, and its bitcoin', async () => {
	const backend = assetsBackend();
	const r = await mount(backend);
	try {
		assert.equal(r.$('.card-head h3').firstChild.textContent, 'Asset channels');
		assert.equal(r.test('asset-channels').getAttribute('data-count'), '1');
		const rows = r.tests('asset-channel');
		assert.equal(rows.length, 1);
		const row = rows[0];
		assert.equal(row.getAttribute('data-state'), 'NORMAL');
		assert.equal(row.querySelector('.asset-name').textContent, 'BUSD');
		assert.match(row.textContent, /with Lightning Labs edge · 02[0-9a-f]{4}…[0-9a-f]{6}/, 'the peer by name, and by key');
		assert.equal(row.querySelector('.badge').textContent, 'open');
		assert.equal(row.querySelector('.badge').className, 'badge green');

		assert.match(r.test('asset-channel-local').textContent, /2,400\.00\s*BUSD\s*yours/);
		assert.match(r.test('asset-channel-remote').textContent, /theirs\s*3,100\.00\s*BUSD/);
		const bar = row.querySelector('.asset-channel-bar');
		assert.equal(bar.getAttribute('role'), 'img');
		assert.equal(bar.getAttribute('aria-label'), "2,400.00 BUSD on your side, 3,100.00 BUSD on the peer's side");
		assert.equal(bar.querySelector('.balbar-local').style.width, '43.6%');

		const facts = [...row.querySelectorAll('.asset-channel-facts > div')].map((d) => d.textContent.replace(/\s+/g, ' '));
		assert.deepEqual(facts, [
			'Can send2,400.00BUSD',
			'Can receive3,100.00BUSD',
			'Capacity5,500.00BUSD',
			'Bitcoin in the channel100,000 sats'
		]);
		assert.equal(r.test('asset-channel-close').textContent, 'Close');
	} finally {
		await r.unmount();
	}
});

test('a wallet with no asset channel is told what one is for', async () => {
	const backend = assetsBackend();
	const r = await mount(backend, { id: 'demo-testnet' });
	try {
		assert.equal(r.test('asset-channels').getAttribute('data-count'), '0');
		assert.match(r.test('asset-channels').textContent, /No asset channels\. Open one to send and receive an asset over Lightning\./);
		assert.ok(r.test('asset-channel-open'));
	} finally {
		await r.unmount();
	}
});

test('opening asks for the asset, the amount, the peer and the fee, says the cost in sats, and opens once', async () => {
	const backend = assetsBackend();
	const busd = await busdOf(backend);
	const r = await mount(backend);
	try {
		await click(r.test('asset-channel-open'));
		await settle(60);
		const dialog = r.test('asset-channel-open-dialog').closest('[role="dialog"]');
		assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).firstChild.textContent, 'Open asset channel');
		assert.deepEqual(
			r.$$('[data-testid="asset-channel-picker"] .asset-chip-name').map((c) => c.textContent),
			['BUSD', 'Club Points', 'Pico'],
			'counted assets with some on-chain, and no collectibles'
		);
		assert.equal(r.test('asset-channel-amount'), null, 'no amount before there is an asset');
		assert.equal(r.test('asset-channel-submit').disabled, true);
		assert.equal(r.test('asset-channel-submit').textContent, 'Open channel');
		assert.match(r.test('asset-channel-peer-note').textContent, /The peer has to take asset channels\. If it does not, the wallet says so and nothing is opened\./);

		await click(chip(r, 'BUSD'));
		await type(r.test('asset-channel-amount'), '1000');
		assert.match(dialog.textContent, /It all starts on your side/);
		await settle(PRICED_MS);
		assert.equal(r.test('asset-channel-submit').disabled, true, 'not without a peer');

		await type(r.test('asset-channel-peer-input'), `${PEER}@10.0.0.9:9736`);
		await settle(PRICED_MS);
		const cost = [...r.test('asset-channel-cost').querySelectorAll('tr')].map((tr) => [...tr.children].map((td) => td.textContent).join(' | '));
		assert.deepEqual(cost, [
			'Goes into the channel | 1,000.00 BUSDand 100,000 sats of bitcoin with it',
			"Starts on the peer's side | 1,708 satsof that bitcoin, so the peer can pay you back",
			'Miner fee | 4,320 satsat 18 sat/vB',
			'Total in bitcoin | 104,320 sats',
			'On-chain available | 500,000 sats'
		]);
		assert.match(
			dialog.textContent,
			/stays yours and comes back when the channel is closed, all but the 1,708 sats that start on the peer's side: those are the peer's\. The miner fee is spent\./,
			'what is handed to the peer is not said to come back'
		);
		assert.deepEqual(backend.posted('/channels/quote').at(-1).body, { key: busd.key, amount: '100000', feeRate: 18 });
		assert.equal(backend.posted('/channels/open').length, 0, 'pricing opens nothing');

		const submit = r.test('asset-channel-submit');
		assert.equal(submit.textContent, 'Open channel with 1,000.00 BUSD');
		assert.equal(submit.disabled, false);
		await click(submit);
		await settle(ANSWERED_MS + 200);

		const opened = backend.posted('/channels/open');
		assert.equal(opened.length, 1);
		assert.deepEqual(opened[0].body, { peer: { pubkey: PEER, host: '10.0.0.9', port: 9736 }, key: busd.key, amount: '100000', feeRate: 18 });
		assert.match(opened[0].headers['X-Idempotency-Key'], /^[0-9a-f-]{16,}$/i);
		assert.equal(r.test('asset-channel-open-dialog'), null, 'the dialog closes');
		assert.ok(r.toasts().some((t) => /Opening a BUSD channel\. It can be used once its funding transaction confirms\./.test(t)));

		const rows = r.tests('asset-channel');
		assert.equal(rows.length, 2, 'and the channel is in the list at once');
		assert.equal(rows[0].getAttribute('data-state'), 'OPENING');
		assert.equal(rows[0].querySelector('.badge').textContent, 'opening');
		assert.match(rows[0].textContent, /It can carry payments once its funding transaction has confirmed\./);
		assert.match(rows[0].textContent, /Can send0\s*BUSD|Can send0\.00\s*BUSD/, 'nothing moves through it yet');
		assert.equal((await busdOf(backend)).balance.onchain, '1150000', 'the asset left the on-chain balance');

		await r.pass(16_000);
		assert.equal(r.tests('asset-channel')[0].querySelector('.badge').textContent, 'open');
		assert.match(r.tests('asset-channel')[0].textContent, /Can send1,000\.00\s*BUSD/);
	} finally {
		await r.unmount();
	}
});

test('a connected peer is chosen from a list, by name', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	const api = {
		...real,
		get: async (path) => {
			if (path === '/peers') {
				return [
					{ pubkey: PEER, host: '10.0.0.9', port: 9736, state: 'connected', alias: 'Edge One' },
					{ pubkey: `03${'ef'.repeat(32)}`, host: '10.0.0.10', port: 9735, state: 'disconnected', alias: 'Gone' }
				];
			}
			if (path.startsWith('/graph/node')) throw Object.assign(new Error('Node not found in graph'), { code: 'NOT_FOUND', status: 404 });
			return real.get(path);
		}
	};
	const r = await mount(backend, { api });
	try {
		await click(r.test('asset-channel-open'));
		await settle(80);
		const peer = r.test('asset-channel-peer');
		assert.deepEqual([...peer.options].map((o) => o.textContent), ['Choose a peer', 'Edge One · 02abab…ababab', 'Another peer…'], 'only peers that are connected now');
		assert.equal(r.test('asset-channel-peer-input'), null, 'no box to type in until another peer is asked for');

		await click(chip(r, 'BUSD'));
		await type(r.test('asset-channel-amount'), '50');
		await select(peer, PEER);
		await settle(PRICED_MS);
		await click(r.test('asset-channel-submit'));
		await settle(ANSWERED_MS + 200);
		assert.deepEqual(backend.posted('/channels/open')[0].body.peer, { pubkey: PEER, host: '10.0.0.9', port: 9736, alias: 'Edge One' });
		assert.match(r.tests('asset-channel')[0].textContent, /with Edge One · 02abab…ababab/);
	} finally {
		await r.unmount();
	}
});

test("an asset's own page opens the dialog on that asset, and the request is spent", async () => {
	const backend = assetsBackend();
	const points = (await backend.api('demo-main').get('/x/assets/balances')).assets.find((a) => a.name === 'Club Points');
	const r = await mount(backend, { route: { query: {}, state: { openAsset: points.key } } });
	try {
		await settle(80);
		assert.ok(r.test('asset-channel-open-dialog'), 'opened without a press');
		assert.equal(chip(r, 'Club Points').getAttribute('aria-checked'), 'true');
		assert.equal(chip(r, 'BUSD').getAttribute('aria-checked'), 'false');
		assert.ok(r.test('asset-channel-amount'), 'ready for the amount');
		assert.deepEqual(r.moves, [['channels', { replace: true }]], 'coming back to the tab does not open it again');
	} finally {
		await r.unmount();
	}
});

test('a peer that does not take asset channels is refused in plain words, and nothing is spent', async () => {
	const backend = assetsBackend();
	const r = await mount(backend);
	try {
		await filled(r, { peer: PLAIN_PEER });
		await click(r.test('asset-channel-submit'));
		await settle(ANSWERED_MS);
		const refusal = r.test('asset-channel-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'PEER_NO_ASSET_CHANNELS');
		assert.equal(refusal.getAttribute('role'), 'alert');
		assert.match(refusal.textContent, /That peer does not open asset channels, so nothing was opened and nothing was spent\./);
		assert.ok(r.test('asset-channel-open-dialog'), 'the dialog stays, with what was typed');
		assert.equal(r.test('asset-channel-amount').value, '1000');
		assert.equal(r.tests('asset-channel').length, 1);
		assert.equal((await busdOf(backend)).balance.onchain, '1250000');

		// Naming another peer clears it, and the open goes through.
		await type(r.test('asset-channel-peer-input'), PEER);
		assert.equal(r.test('asset-channel-refusal'), null);
		await click(r.test('asset-channel-submit'));
		await settle(ANSWERED_MS + 200);
		assert.deepEqual(backend.posted('/channels/open').at(-1).body.peer, { pubkey: PEER, host: null, port: null }, 'a key alone will do for a peer the wallet can find');
		assert.equal(r.tests('asset-channel').length, 2);
	} finally {
		await r.unmount();
	}
});

test('without the bitcoin to open, the cost is still shown and the refusal says how much is missing', async () => {
	const backend = assetsBackend({ spendable: 50_000 });
	const r = await mount(backend);
	try {
		await filled(r);
		assert.match(r.test('asset-channel-cost').textContent, /Total in bitcoin104,320 sats/);
		const refusal = r.test('asset-channel-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'INSUFFICIENT_BTC');
		assert.match(refusal.textContent, /Opening needs 104,320 sats on-chain and this wallet has 50,000 sats\.\s*Deposit bitcoin on the Receive tab first\./);
		assert.equal(r.test('asset-channel-submit').disabled, true);
		assert.equal(backend.posted('/channels/open').length, 0);
	} finally {
		await r.unmount();
	}
});

test('an amount the wallet does not hold on-chain, or a peer that is not one, cannot be opened with', async () => {
	const backend = assetsBackend();
	const r = await mount(backend);
	try {
		await filled(r, { amount: '99999999', peer: 'not-a-peer' });
		assert.match(r.test('asset-channel-amount-refusal').textContent, /That is more than the 12,500\.00 BUSD this wallet holds on-chain\./);
		assert.match(r.test('asset-channel-peer-refusal').textContent, /A peer starts with its node public key/);
		assert.equal(r.test('asset-channel-cost'), null, 'nothing is priced that cannot be opened');
		assert.equal(r.test('asset-channel-submit').disabled, true);
		assert.equal(backend.posted('/channels/quote').length, 0);

		await type(r.test('asset-channel-peer-input'), PEER.slice(0, 40));
		assert.match(r.test('asset-channel-peer-refusal').textContent, /66 characters, and this is 40/);
	} finally {
		await r.unmount();
	}
});

test('closing is cooperative, and a force close is asked about twice', async () => {
	const backend = assetsBackend();
	const channel = (await backend.api('demo-main').get('/x/assets/channels')).channels[0];
	const r = await mount(backend);
	try {
		await click(r.test('asset-channel-close'));
		await settle(60);
		const dialog = () => r.test('asset-channel-close-dialog');
		assert.equal(dialog().getAttribute('data-step'), 'cooperative');
		assert.match(dialog().textContent, /Close the BUSD channel with Lightning Labs edge\? Your side of it, 2,400\.00 BUSD, comes back to this wallet\s+on-chain/);
		assert.equal(r.test('asset-channel-close-force-confirm'), null, 'a force close is not on the first page');

		// Asking about a force close closes nothing.
		await click(r.test('asset-channel-close-force'));
		assert.equal(dialog().getAttribute('data-step'), 'force');
		assert.match(dialog().textContent, /A force close does not ask the peer\. It is for a peer that has stopped answering, and for nothing else\./);
		assert.match(dialog().textContent, /only after the channel's safety delay, which can\s+be days/);
		assert.equal(backend.posted('/channels/close').length, 0);

		await click(r.test('asset-channel-close-back'));
		assert.equal(dialog().getAttribute('data-step'), 'cooperative');
		await click(r.test('asset-channel-close-coop'));
		await settle(ANSWERED_MS + 200);
		assert.deepEqual(backend.posted('/channels/close').map((c) => c.body), [{ channelId: channel.channelId, force: false }]);
		assert.equal(r.test('asset-channel-close-dialog'), null);
		assert.ok(r.toasts().some((t) => /Closing the BUSD channel\. The funds come back on-chain once it confirms\./.test(t)));
		assert.equal(r.tests('asset-channel').length, 0, 'it leaves the list');
		assert.match(r.test('asset-channels').textContent, /No asset channels\./);
	} finally {
		await r.unmount();
	}

	const other = assetsBackend();
	const forced = await mount(other);
	try {
		await click(forced.test('asset-channel-close'));
		await settle(60);
		await click(forced.test('asset-channel-close-force'));
		await click(forced.test('asset-channel-close-force-confirm'));
		await settle(ANSWERED_MS + 200);
		assert.deepEqual(other.posted('/channels/close').map((c) => c.body.force), [true]);
		assert.ok(forced.toasts().some((t) => /Force closing the BUSD channel\. The funds come back after its safety delay\./.test(t)));
	} finally {
		await forced.unmount();
	}
});

test('a close the wallet refuses keeps the dialog open, with the reason', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	const api = {
		...real,
		post: async (path, body, options) => {
			if (path === '/x/assets/channels/close') throw Object.assign(new Error('no such channel'), { code: 'CHANNEL_NOT_FOUND', status: 404 });
			return real.post(path, body, options);
		}
	};
	const r = await mount(backend, { api });
	try {
		await click(r.test('asset-channel-close'));
		await settle(60);
		await click(r.test('asset-channel-close-coop'));
		await settle(ANSWERED_MS);
		assert.equal(r.test('asset-channel-close-error').textContent, 'This wallet no longer has that channel. It may already be closed.');
		assert.ok(r.test('asset-channel-close-dialog'));
		assert.equal(r.test('asset-channel-close-coop').disabled, false, 'and it can be tried again');
	} finally {
		await r.unmount();
	}
});

test('an open a restart cut short is listed as not opened, with the wallet\'s sentence, what it was for, and nothing to close', async () => {
	const backend = assetsBackend();
	const before = await backend.api('demo-main').get('/x/assets/status');
	assert.equal(backend.mock.seed('demo-main', 'open-interrupted'), true);
	const { channels } = await backend.api('demo-main').get('/x/assets/channels');
	const failed = channels.find((c) => c.state === 'FAILED');
	assert.deepEqual([failed.failure.code, failed.localBalance, failed.sendable, failed.reclaimable], ['CHANNEL_OPEN_INTERRUPTED', '0', '0', false]);
	// Every row has the key, as the host's has: null for a channel.
	assert.equal(channels.every((c) => 'failure' in c), true);
	assert.equal(channels.filter((c) => c.failure).length, 1);
	const status = await backend.api('demo-main').get('/x/assets/status');
	// It is no channel: nothing that counts them counts it.
	assert.equal(status.lightning.usableChannels, before.lightning.usableChannels);
	assert.equal(backend.mock.daemonChannels('demo-main').some((c) => c.channelId === failed.channelId), false);
	const r = await mount(backend, { status });
	try {
		const row = r.tests('asset-channel').find((el) => el.getAttribute('data-state') === 'FAILED');
		assert.match(row.textContent, /not opened/);
		const note = row.querySelector('[data-testid="asset-channel-failure"]');
		assert.equal(note.getAttribute('data-code'), 'CHANNEL_OPEN_INTERRUPTED');
		assert.match(note.textContent, /interrupted before any bitcoin or asset left the wallet/);
		assert.match(note.textContent, /can be tried again\. It was for 500\.00/);
		// No figures of a channel, and nothing to close or take back.
		assert.equal(row.querySelector('.asset-channel-facts'), null);
		assert.equal(row.querySelector('[data-testid="asset-channel-close"]'), null);
		assert.equal(row.querySelector('[data-testid="asset-channel-reclaim"]'), null);
		await assert.rejects(backend.api('demo-main').post('/x/assets/channels/close', { channelId: failed.channelId }), (e) => e.code === 'CHANNEL_NOT_FOUND');
	} finally {
		await r.unmount();
	}
});

test('a channel whose peer is away says so quietly, carries nothing, and its Close says the peer has to be there', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-main', 'peer-offline'), true);
	const listed = (await backend.api('demo-main').get('/x/assets/channels')).channels;
	assert.deepEqual(listed.map((c) => [c.state, c.peerConnected, c.sendable, c.receivable]), [['NORMAL', false, '0', '0']]);
	const status = await backend.api('demo-main').get('/x/assets/status');
	assert.equal(status.lightning.usableChannels, 0);
	const r = await mount(backend, { status });
	try {
		const row = r.test('asset-channel');
		assert.equal(row.getAttribute('data-state'), 'NORMAL');
		assert.equal(row.querySelector('[data-testid="asset-channel-peer-offline"]').textContent, 'peer offline');
		assert.match(row.querySelector('[data-testid="asset-channel-away"]').textContent, /^The peer of this channel is not connected, so it carries no payments until it is back\./);
		// Close is still offered, and says what a close with the peer needs before it is tried.
		await click(r.test('asset-channel-close'));
		await settle(10);
		const dialog = r.test('asset-channel-close-dialog');
		assert.equal(dialog.getAttribute('data-step'), 'cooperative');
		assert.match(r.test('asset-channel-close-offline').textContent, /^The peer is not connected\. A channel is closed together with its peer only while it is, so this will be refused until the peer is back\./);
		await click(r.test('asset-channel-close-coop'));
		await settle(20);
		assert.match(r.test('asset-channel-close-error').textContent, /^The peer of this channel, Lightning Labs edge, is not connected, and a channel is closed together with its peer only while it is\./);
		assert.equal((await backend.api('demo-main').get('/x/assets/channels')).channels[0].state, 'NORMAL');
	} finally {
		await r.unmount();
	}
	// The wallet's own refusals, word for word, and a close without the peer goes through.
	const id = listed[0].channelId;
	await assert.rejects(backend.api('demo-main').post('/x/assets/channels/close', { channelId: id }), (e) => e.code === 'PEER_OFFLINE' && e.status === 409 && e.details.peerAlias === 'Lightning Labs edge');
	assert.equal((await backend.api('demo-main').post('/x/assets/channels/close', { channelId: id, force: true })).force, true);
});

test('a channel that failed is badged as that, and is closed only by force, on a page that says why', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-main', 'channel-failed'), true);
	const listed = (await backend.api('demo-main').get('/x/assets/channels')).channels;
	assert.deepEqual(listed.map((c) => [c.state, c.peerConnected, c.sendable, c.receivable]), [['ERRORED', true, '0', '0']]);
	const id = listed[0].channelId;
	await assert.rejects(backend.api('demo-main').post('/x/assets/channels/close', { channelId: id }), (e) => e.code === 'CHANNEL_ERRORED' && e.status === 409);
	const status = await backend.api('demo-main').get('/x/assets/status');
	assert.equal(status.lightning.usableChannels, 0);
	const r = await mount(backend, { status });
	try {
		const row = r.test('asset-channel');
		assert.equal(row.getAttribute('data-state'), 'ERRORED');
		assert.match(row.textContent, /failed/);
		assert.match(row.querySelector('[data-testid="asset-channel-errored"]').textContent, /^This channel has failed and carries no payments\. Force close it to bring what is in it back on-chain\./);
		assert.equal(row.querySelector('[data-testid="asset-channel-peer-offline"]'), null);
		// Its balance is still shown: it is the wallet's until the close brings it back.
		assert.match(row.textContent, /2,400\.00/);
		await click(r.test('asset-channel-close'));
		await settle(10);
		// Straight to the force close, with no cooperative close to go back to.
		assert.equal(r.test('asset-channel-close-dialog').getAttribute('data-step'), 'force');
		assert.equal(r.test('asset-channel-close-coop'), null);
		assert.equal(r.test('asset-channel-close-back'), null);
		assert.match(r.test('asset-channel-close-dialog').textContent, /This channel has failed, so it can no longer be closed together with its peer\./);
		await click(r.test('asset-channel-close-force-confirm'));
		await settle(30);
		assert.deepEqual(backend.posted('/channels/close').slice(-1).map((c) => c.body), [{ channelId: id, force: true }]);
	} finally {
		await r.unmount();
	}
});

test('a state this page has not met is shown as it stands, with Close and its force close on offer', async () => {
	const backend = assetsBackend();
	const real = backend.api('demo-main');
	const api = {
		...real,
		get: async (path, ...rest) => {
			const answer = await real.get(path, ...rest);
			return path === '/x/assets/channels' ? { channels: answer.channels.map((c) => ({ ...c, state: 'SOMETHING_NEW', sendable: '0', receivable: '0' })) } : answer;
		}
	};
	const status = await real.get('/x/assets/status');
	const r = await mount(backend, { api, status });
	try {
		const row = r.test('asset-channel');
		assert.match(row.textContent, /something new/);
		assert.equal(row.querySelector('[data-testid="asset-channel-errored"]'), null);
		await click(r.test('asset-channel-close'));
		await settle(10);
		assert.equal(r.test('asset-channel-close-dialog').getAttribute('data-step'), 'cooperative');
		assert.notEqual(r.test('asset-channel-close-force'), null);
	} finally {
		await r.unmount();
	}
});

test('a channel the node no longer holds is listed as that, cannot be closed, and the card says what it means', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-main', 'channel-missing'), true);
	const status = await backend.api('demo-main').get('/x/assets/status');
	assert.equal(status.lightning.usableChannels, 0);
	const r = await mount(backend, { status });
	try {
		const row = r.test('asset-channel');
		assert.equal(row.getAttribute('data-state'), 'MISSING');
		assert.match(row.textContent, /not held here/);
		// Its last known balance is still shown, and nothing offers to close it.
		assert.match(row.textContent, /2,400\.00/);
		assert.equal(r.test('asset-channel-close'), null);
		const notes = r.tests('asset-channels-warning');
		assert.equal(notes.length, 1);
		assert.equal(notes[0].getAttribute('data-code'), 'CHANNEL_MISSING');
		assert.equal(notes[0].getAttribute('role'), 'alert');
		assert.match(notes[0].textContent, /as happens after a restore from a backup/);
		assert.match(notes[0].textContent, /cannot bring the assets in it back by itself/);
		// The wallet refuses a close all the same, in words.
		await assert.rejects(backend.api('demo-main').post('/x/assets/channels/close', { channelId: row.getAttribute('data-channel') || (await backend.api('demo-main').get('/x/assets/channels')).channels[0].channelId }), (e) => e.code === 'CHANNEL_MISSING');
		// The daemon does not list a channel it does not hold.
		assert.equal(backend.mock.daemonChannels('demo-main').length, 0);
	} finally {
		await r.unmount();
	}
});

test('a wallet with nothing wrong with its channels shows no warning', async () => {
	const backend = assetsBackend();
	const status = await backend.api('demo-main').get('/x/assets/status');
	assert.equal('warning' in status.lightning, false);
	const r = await mount(backend, { status });
	try {
		assert.equal(r.tests('asset-channels-warning').length, 0);
	} finally {
		await r.unmount();
	}
});

const CHANNEL_KEYS = ['channelId', 'pendingChannelId', 'peerPubkey', 'peerAlias', 'state', 'failure', 'peerConnected', 'asset', 'capacity', 'localBalance', 'remoteBalance', 'sendable', 'receivable', 'channelSats', 'fundingTxid', 'reclaimable', 'reclaimTxid'];
const keyed = (key) => ({ headers: { 'X-Idempotency-Key': key } });

test('the funding of an open that will not confirm can be taken back: asked once, said on the row, and the asset comes back', async () => {
	const backend = assetsBackend();
	const before = (await busdOf(backend)).balance.onchain;
	assert.equal(backend.mock.seed('demo-main', 'open-stuck'), true);
	const listed = (await backend.api('demo-main').get('/x/assets/channels')).channels;
	// The wallet's own keys, in its order, and its word on which funding can be taken back.
	for (const c of listed) assert.deepEqual(Object.keys(c), CHANNEL_KEYS);
	assert.deepEqual(listed.map((c) => [c.state, c.reclaimable, c.reclaimTxid]), [['OPENING', true, null], ['NORMAL', false, null]]);
	assert.match(listed[0].fundingTxid, /^[0-9a-f]{64}$/);
	const status = await backend.api('demo-main').get('/x/assets/status');
	const r = await mount(backend, { status });
	try {
		assert.equal(r.tests('asset-channel').length, 2);
		// One row offers it: a channel that is open has nothing to take back.
		assert.equal(r.tests('asset-channel-reclaim').length, 1);
		assert.equal(r.test('asset-channel-reclaim').textContent, 'Take the funding back');
		assert.match(r.test('asset-channel-opening').textContent, /^Opening\. It can carry payments once its funding transaction has confirmed\./);
		await click(r.test('asset-channel-reclaim'));
		await settle(60);
		const dialog = r.test('asset-channel-reclaim-dialog');
		assert.equal(dialog.getAttribute('data-again'), 'no');
		assert.match(dialog.textContent, /spends the same bitcoin back to this wallet at a higher fee, so the funding of\s+the BUSD channel with Meridian edge can never confirm and the BUSD stays in the wallet\./);
		assert.match(dialog.textContent, /Most fundings confirm by\s+themselves, and waiting costs nothing\./);
		assert.match(r.test('asset-channel-reclaim-cost').textContent, /The wallet says the figure once the transaction is made\./);
		await click(r.test('asset-channel-reclaim-confirm'));
		await settle(ANSWERED_MS);
		const posted = backend.posted('/channels/reclaim');
		assert.equal(posted.length, 1);
		assert.equal(posted[0].body.channelId, listed[0].channelId);
		assert.equal(posted[0].body.feeRate > 2, true);
		assert.match(posted[0].headers['X-Idempotency-Key'], /\S{8,}/, 'it goes with a key, so it is asked for once');
		assert.equal(r.test('asset-channel-reclaim-dialog'), null);
		assert.match(r.toasts().join(' '), /Taking the funding of the BUSD channel back\. The miner fee is [\d,]+ sats\. It is done once that transaction confirms\./);
		// The row says so, links the transaction, and offers only a higher fee.
		const now = (await backend.api('demo-main').get('/x/assets/channels')).channels[0];
		assert.match(now.reclaimTxid, /^[0-9a-f]{64}$/);
		assert.equal(now.reclaimable, true);
		const note = r.test('asset-channel-reclaiming');
		assert.match(note.textContent, /The funding of this channel is being taken back\./);
		assert.match(note.textContent, /its BUSD is back in this wallet's holdings/);
		assert.equal(r.test('asset-channel-opening'), null);
		assert.equal(r.test('asset-channel-reclaim').textContent, 'Raise the fee');
		assert.match(r.tests('asset-channel')[0].textContent, /taking back/);
		// It ends by itself, so the one Close left is the open channel's.
		assert.equal(r.tests('asset-channel-close').length, 1);
		// A block later the open is over, and what was going into it is on-chain again.
		assert.notEqual((await busdOf(backend)).balance.onchain, before);
		await r.pass(7000);
		assert.equal(r.tests('asset-channel').length, 1);
		assert.equal((await busdOf(backend)).balance.onchain, before);
	} finally {
		await r.unmount();
	}
});

test('a funding that cannot be taken back, and a fee that is too high or too low, are refused in the wallet\'s own sentences', async () => {
	const backend = assetsBackend();
	const api = backend.api('demo-main');
	backend.mock.seed('demo-main', 'open-stuck');
	const [stuck, open] = (await api.get('/x/assets/channels')).channels;
	const r = await mount(backend, { status: await api.get('/x/assets/status') });
	try {
		await click(r.test('asset-channel-reclaim'));
		await settle(60);
		const rate = () => r.test('asset-channel-reclaim-dialog').querySelector('input.amount-input');
		const said = () => r.test('asset-channel-reclaim-error');
		await type(rate(), '9999');
		await click(r.test('asset-channel-reclaim-confirm'));
		await settle(ANSWERED_MS);
		assert.equal(said().getAttribute('data-code'), 'FEE_TOO_HIGH');
		assert.equal(said().textContent, 'That fee rate is above the 500 sat/vB this wallet allows for an asset transaction.');
		// A rate the funding transaction already pays is not a replacement of it.
		await type(rate(), '2');
		await click(r.test('asset-channel-reclaim-confirm'));
		await settle(ANSWERED_MS);
		assert.equal(said().getAttribute('data-code'), 'CHANNEL_RECLAIM_FAILED');
		assert.match(said().textContent, /could not be made or sent\. If the funding transaction is already on the network, it takes a fee rate above the one that transaction pays\./);
		assert.equal((await api.get('/x/assets/channels')).channels[0].reclaimTxid, null, 'nothing was sent');
		await type(rate(), '30');
		await click(r.test('asset-channel-reclaim-confirm'));
		await settle(ANSWERED_MS);
		assert.equal(r.test('asset-channel-reclaim-dialog'), null);
		// Asked again, it is a higher fee and worded as that.
		await click(r.test('asset-channel-reclaim'));
		await settle(60);
		assert.equal(r.test('asset-channel-reclaim-dialog').getAttribute('data-again'), 'yes');
		assert.match(r.test('asset-channel-reclaim-dialog').textContent, /This sends\s+it again at a higher fee, in place of the one before\./);
		assert.equal(r.test('asset-channel-reclaim-confirm').textContent, 'Raise the fee');
		await type(rate(), '30');
		await click(r.test('asset-channel-reclaim-confirm'));
		await settle(ANSWERED_MS);
		assert.equal(said().getAttribute('data-code'), 'CHANNEL_RECLAIM_FAILED');
	} finally {
		await r.unmount();
	}
	// A funding that is on the chain, a request with no key, and a close of an open still unconfirmed.
	await assert.rejects(api.post('/x/assets/channels/reclaim', { channelId: open.channelId }, keyed('k-1')), (e) => e.code === 'CHANNEL_NOT_RECLAIMABLE' && /is on the chain, so there is nothing to take back\. Close the channel instead\./.test(e.message));
	await assert.rejects(api.post('/x/assets/channels/reclaim', { channelId: stuck.channelId }), (e) => e.code === 'IDEMPOTENCY_KEY_REQUIRED');
	await assert.rejects(api.post('/x/assets/channels/reclaim', { channelId: 'ff'.repeat(32) }, keyed('k-2')), (e) => e.code === 'CHANNEL_NOT_FOUND');
	await assert.rejects(api.post('/x/assets/channels/close', { channelId: stuck.channelId }), (e) => e.code === 'CHANNEL_OPENING' && e.details.reclaimable === true);
	// The same key is the same request: answered again, and nothing more is sent.
	const first = await api.post('/x/assets/channels/reclaim', { channelId: stuck.channelId, feeRate: 40 }, keyed('k-3'));
	assert.deepEqual(Object.keys(first), ['channelId', 'pendingChannelId', 'txid', 'feeSats', 'feeRate']);
	assert.deepEqual(await api.post('/x/assets/channels/reclaim', { channelId: stuck.channelId, feeRate: 40 }, keyed('k-3')), first);
});

const NOT_OFFERED = "This wallet's node does not offer asset channels to its peers: a Lightning feature they depend on is turned off in the node's settings. Nothing new can be opened, invoiced or paid over asset channels until it is turned on. The channels there already are stay listed and can still be closed.";

test('a node that does not offer asset channels: said above the card, nothing new is opened, and the channels there are stay listed and closable', async () => {
	const backend = assetsBackend();
	const api = backend.api('demo-main');
	const busd = await busdOf(backend);
	assert.equal(backend.mock.seed('demo-main', 'not-advertised'), true);
	const status = await api.get('/x/assets/status');
	// The wallet's shape: off, with the reason beside it, and its channels still counted.
	assert.deepEqual(Object.keys(status.lightning), ['mode', 'usableChannels', 'feeCoins', 'unavailable']);
	assert.deepEqual([status.lightning.mode, status.lightning.usableChannels], ['off', 1]);
	assert.deepEqual(Object.keys(status.lightning.unavailable), ['code', 'message', 'reason']);
	assert.deepEqual([status.lightning.unavailable.code, status.lightning.unavailable.message], ['NOT_ADVERTISED', NOT_OFFERED]);
	// Anything new is refused by the wallet, in the same sentence.
	for (const [route, body] of [
		['/channels/quote', { key: busd.key, amount: '1000' }],
		['/invoices/quote', { key: busd.key, amount: '1000' }],
		['/pay/quote', { bolt11: 'lnbc50u1x', key: busd.key }]
	]) {
		await assert.rejects(api.post(`/x/assets${route}`, body), (e) => e.code === 'LIGHTNING_NOT_ADVERTISED' && e.status === 409 && e.message === NOT_OFFERED && typeof e.details.reason === 'string');
	}
	const r = await mount(backend, { status, route: { query: {}, state: { openAsset: busd.key } } });
	try {
		const note = r.test('asset-channels-held');
		assert.deepEqual([note.getAttribute('data-code'), note.getAttribute('role'), note.textContent], ['NOT_ADVERTISED', 'alert', NOT_OFFERED]);
		// Held, not hidden: the button is there and does nothing, and an asset's page asking for the dialog gets none.
		assert.equal(r.test('asset-channel-open').disabled, true);
		assert.equal(r.test('asset-channel-open-dialog'), null);
		assert.deepEqual(r.moves, [['channels', { replace: true }]], 'the request is spent all the same');
		// The channel there is stays listed, and closes.
		assert.equal(r.tests('asset-channel').length, 1);
		await click(r.test('asset-channel-close'));
		await settle(60);
		await click(r.test('asset-channel-close-coop'));
		await settle(ANSWERED_MS);
		assert.equal(backend.posted('/channels/close').length, 1);
		assert.equal(r.test('asset-channel-close-dialog'), null);
		assert.equal(r.tests('asset-channel').length, 0);
	} finally {
		await r.unmount();
	}
	// Put back, the wallet is as it was.
	backend.mock.setHost('demo-main', null);
});

test('a fee budget for channel fees that is used up is said above the list as something said, not something lost', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-main', 'fee-budget'), true);
	const status = await backend.api('demo-main').get('/x/assets/status');
	assert.deepEqual(status.lightning.warnings.map((w) => w.code), ['FEE_BUDGET_EXHAUSTED']);
	const r = await mount(backend, { status });
	try {
		const notes = r.tests('asset-channels-warning');
		assert.equal(notes.length, 1);
		assert.deepEqual([notes[0].getAttribute('data-code'), notes[0].getAttribute('role'), notes[0].className], ['FEE_BUDGET_EXHAUSTED', 'status', 'info-note']);
		assert.equal(notes[0].textContent, 'The budget this app sets for the miner fees of asset channels is used up, so nothing was done. Nothing was lost: the channels and what is in them are as they were.');
		// Everything else on the card works as ever.
		assert.equal(r.test('asset-channel-open').disabled, false);
		assert.equal(r.test('asset-channels-held'), null);
	} finally {
		await r.unmount();
	}
});

test('a channel takes one issuance: the amount is held to the most the wallet has of a single one, and says so', async () => {
	const backend = assetsBackend();
	const r = await mount(backend);
	try {
		const busd = await busdOf(backend);
		assert.deepEqual([busd.balance.onchain, busd.balance.channelable], ['1250000', '900000']);
		await filled(r, { amount: '10000' });
		assert.match(
			r.test('asset-channel-open-dialog').textContent,
			/A channel holds one issuance of an asset, and the most this wallet has of a single one on-chain is 9,000\.00 BUSD\. Open a channel with that much or less, and another for the rest\./
		);
		assert.equal(r.test('asset-channel-submit').disabled, true);
		assert.equal(r.test('asset-channel-cost'), null, 'no price is asked for an amount that cannot go in');
		assert.equal(backend.posted('/x/assets/channels/quote').some((c) => c.body.amount === '1000000'), false);
	} finally {
		await r.unmount();
	}
});

test('bitcoin on addresses a channel cannot be funded from is said in the open dialog, with the figures', async () => {
	const backend = assetsBackend();
	backend.mock.seed('demo-main', 'funding-inputs');
	const r = await mount(backend);
	try {
		await filled(r);
		const note = r.test('asset-channel-refusal');
		assert.equal(note.getAttribute('data-code'), 'FUNDING_INPUTS');
		assert.equal(
			note.textContent,
			'The bitcoin for an asset channel has to be on native SegWit addresses. This wallet has 40,000 sats on those, and this needs about 104,320 sats. Another 250,000 sats are on addresses of other types, which cannot be used for it. Nothing was done and nothing was spent.'
		);
		assert.equal(r.test('asset-channel-submit').disabled, true);
	} finally {
		await r.unmount();
	}
});

test('a wallet with a channel and no bitcoin for a fee coin is told how much to keep, in blue, and can still open a channel', async () => {
	const backend = assetsBackend();
	backend.mock.seed('demo-main', 'no-fee-coins');
	const status = await backend.api('demo-main').get('/x/assets/status');
	const r = await mount(backend, { status });
	try {
		assert.deepEqual(status.lightning.feeCoins, { possible: false, neededSats: '1500', largestConfirmedSats: '0', ready: 0, budgetRemainingSats: '25000', reason: 'FEE_FUNDS_UNAVAILABLE' });
		const notes = r.tests('asset-channels-warning');
		assert.deepEqual(notes.map((n) => n.getAttribute('data-code')), ['FEE_COINS_UNAVAILABLE'], 'the one note, and not the fee budget beside it');
		assert.match(notes[0].className, /info-note/);
		assert.match(notes[0].textContent, /^Keep at least 1500 sats of confirmed bitcoin on-chain in this wallet\. A payment caught in an asset channel that has to be closed without the peer is claimed with an on-chain transaction, and its miner fee comes from the wallet's own bitcoin\./);

		await filled(r);
		assert.match(r.test('asset-channel-fee-coins').textContent, /^Keep about 1,500 sats of bitcoin on-chain as well, apart from what this channel takes\./);
		assert.equal(r.test('asset-channel-refusal'), null, 'the open is not refused for it');
		assert.equal(r.test('asset-channel-submit').disabled, false);
	} finally {
		await r.unmount();
	}
	// A wallet whose node can prepare a fee coin is told nothing.
	const fine = assetsBackend();
	const fineStatus = await fine.api('demo-main').get('/x/assets/status');
	const quiet = await mount(fine, { status: fineStatus });
	try {
		assert.equal(fineStatus.lightning.feeCoins.possible, true);
		assert.equal(quiet.tests('asset-channels-warning').length, 0);
		await filled(quiet);
		assert.equal(quiet.test('asset-channel-fee-coins'), null);
	} finally {
		await quiet.unmount();
	}
});

test('a node that refused its fee settings is said in red, and the open dialog holds a new channel with the reason', async () => {
	const backend = assetsBackend();
	backend.mock.seed('demo-main', 'fee-policy');
	const status = await backend.api('demo-main').get('/x/assets/status');
	const r = await mount(backend, { status });
	try {
		assert.equal(status.lightning.feeCoins, null);
		const notes = r.tests('asset-channels-warning');
		assert.deepEqual(notes.map((n) => n.getAttribute('data-code')), ['FEE_POLICY_REFUSED']);
		assert.match(notes[0].className, /error-note/);
		assert.equal(r.tests('asset-channel').length, 1, 'the channel there is stays');
		await filled(r);
		const refusal = r.test('asset-channel-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'FEE_POLICY_REFUSED');
		assert.match(refusal.textContent, /did not take the settings this app gives it for the miner fees of asset channels, so no new asset channel is opened\./);
		assert.equal(r.test('asset-channel-submit').disabled, true);
	} finally {
		await r.unmount();
	}
});
