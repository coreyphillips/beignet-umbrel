/**
 * Run with: npm test (from manager/ui).
 *
 * The channel detail modal for a CLOSED/FORCE_CLOSED channel, pinned where it
 * failed in the field (beignet #212): a force-closed channel whose detail view
 * offered a Reconnect button and routing advice, and could not say what
 * happened or when. Now:
 *
 *   1. the History section renders the manager's recorded story, including
 *      the watchdog reason code that explains the close
 *   2. the live-channel apparatus (Reconnect, HTLC slots, routing policy) is
 *      not shown for a closed channel
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import ChannelsTab from './ChannelsTab.jsx';

const CLOSED_ID = 'c'.repeat(64);
const HISTORY = [
	{ timestamp: 1752000000000, event: 'channel:opening', channelId: CLOSED_ID },
	{ timestamp: 1752000600000, event: 'channel:ready', channelId: CLOSED_ID },
	{
		timestamp: 1753300000000,
		event: 'node:error',
		channelId: CLOSED_ID,
		code: 'REESTABLISH_TIMEOUT_FORCE_CLOSED',
		message: 'stuck in AWAITING_REESTABLISH for > 2016 blocks, force-closing'
	},
	{
		timestamp: 1753300001000,
		event: 'channel:force-closing',
		channelId: CLOSED_ID,
		initiator: 'local'
	}
];

/** A daemon stub: one open channel, one force-closed one. */
function stubApi({ channels, diagnostics } = {}) {
	return {
		get: async (path) => {
			if (path === '/channels') {
				return (
					channels || [
						{
							channelId: 'a'.repeat(64),
							peerPubkey: '02' + 'a'.repeat(64),
							capacitySats: 1_000_000,
							localBalanceSats: 500_000,
							remoteBalanceSats: 500_000,
							state: 'NORMAL'
						},
						{
							channelId: CLOSED_ID,
							peerPubkey: '02' + 'b'.repeat(64),
							capacitySats: 650_000,
							localBalanceSats: 189_825,
							remoteBalanceSats: 460_175,
							state: 'FORCE_CLOSED'
						}
					]
				);
			}
			if (path === '/peers') return [];
			if (path.startsWith('/graph/node')) return null;
			if (path.startsWith('/channel/health')) {
				return { htlcCount: 1, maxHtlcs: 483, warnings: [] };
			}
			if (path.startsWith('/channel/policy')) {
				return { feeBaseMsat: 1000, feeProportionalMillionths: 1, cltvExpiryDelta: 40 };
			}
			if (path.startsWith('/channel/diagnostics')) {
				return (
					diagnostics || {
						state: 'FORCE_CLOSED',
						isPeerConnected: false,
						issues: ['NOT_NORMAL: Channel state is FORCE_CLOSED']
					}
				);
			}
			return null;
		},
		post: async () => ({})
	};
}

/**
 * The manager answers /api/wallets/:id/channel-events with recorded history,
 * or fails every request when `fail` is set.
 */
function stubManagerFetch({ fail } = {}) {
	const original = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const path = String(url);
		assert.ok(
			path.includes('/api/wallets/w1/channel-events'),
			`unexpected fetch ${path}`
		);
		if (fail) return { ok: false, json: async () => ({ ok: false }) };
		const channelId = new URL(path, 'http://x').searchParams.get('channelId');
		return {
			ok: true,
			json: async () => ({
				ok: true,
				result: HISTORY.filter((e) => e.channelId === channelId)
			})
		};
	};
	return () => {
		globalThis.fetch = original;
	};
}

function tabProps(apiOverrides) {
	return { id: 'w1', api: stubApi(apiOverrides), rec: {}, tick: 0, bump: () => {} };
}

const wrapped = (props) => createElement(ToastProvider, null, createElement(ChannelsTab, props));

// Assertions about the modal must read the MODAL, not the whole page: the
// channel list behind it legitimately keeps its own Reconnect and action
// buttons on open-view rows.
const modalText = (r) => {
	const detail = r.$('.detail');
	assert.ok(detail, 'detail modal is open');
	return detail.textContent.replace(/\s+/g, ' ').trim();
};

test('a force-closed channel tells its story and drops the live apparatus', async () => {
	const restoreFetch = stubManagerFetch();
	const r = await render(wrapped, tabProps());
	try {
		await settle(50);

		// Move to the Closed view and open the force-closed channel's detail.
		const closedPill = r.$$('button.pill').find((b) => /Closed \(1\)/i.test(b.textContent));
		assert.ok(closedPill, 'closed view pill exists');
		await click(closedPill);
		const row = r.$('tr.row-clickable');
		assert.ok(row, 'closed channel row exists');
		await click(row);
		await settle(50);

		const text = modalText(r);
		// The story, with the reason the watchdog gave.
		assert.match(text, /History/i);
		assert.match(text, /REESTABLISH_TIMEOUT_FORCE_CLOSED/);
		assert.match(text, /Force close started by this node/);
		assert.match(text, /Channel ready/);
		// The live-channel apparatus is gone: nothing to reconnect, no slots to
		// fill, no routing advice for a channel that no longer routes.
		assert.doesNotMatch(text, /Reconnect/);
		assert.doesNotMatch(text, /HTLC slots/);
		assert.doesNotMatch(text, /Routing policy/);
		assert.doesNotMatch(text, /NOT_NORMAL/);
	} finally {
		await r.unmount();
		restoreFetch();
	}
});

test('a stale NORMAL row whose diagnostics answer FORCE_CLOSED renders as closed', async () => {
	// The list said NORMAL when it was fetched; by the time the modal asks for
	// diagnostics the channel is force-closed. Closedness must follow the same
	// fresh state the badge shows, or the modal offers Reconnect and routing
	// advice next to a FORCE_CLOSED badge.
	const restoreFetch = stubManagerFetch();
	const r = await render(
		wrapped,
		tabProps({
			channels: [
				{
					channelId: CLOSED_ID,
					peerPubkey: '02' + 'b'.repeat(64),
					capacitySats: 650_000,
					localBalanceSats: 189_825,
					remoteBalanceSats: 460_175,
					state: 'NORMAL'
				}
			],
			diagnostics: {
				state: 'FORCE_CLOSED',
				isPeerConnected: false,
				issues: ['NOT_NORMAL: Channel state is FORCE_CLOSED']
			}
		})
	);
	try {
		await settle(50);
		const row = r.$('tr.row-clickable');
		assert.ok(row, 'channel row exists');
		await click(row);
		await settle(50);

		const text = modalText(r);
		assert.match(text, /FORCE_CLOSED/);
		assert.doesNotMatch(text, /Reconnect/);
		assert.doesNotMatch(text, /HTLC slots/);
		assert.doesNotMatch(text, /Routing policy/);
		assert.doesNotMatch(text, /NOT_NORMAL/);
		assert.match(text, /History/i, 'closed channels always get the History row');
	} finally {
		await r.unmount();
		restoreFetch();
	}
});

test('a failed history fetch is an error, never an empty history', async () => {
	const restoreFetch = stubManagerFetch({ fail: true });
	const r = await render(wrapped, tabProps());
	try {
		await settle(50);
		const closedPill = r.$$('button.pill').find((b) => /Closed \(1\)/i.test(b.textContent));
		await click(closedPill);
		const row = r.$('tr.row-clickable');
		await click(row);
		await settle(50);

		const text = modalText(r);
		assert.match(text, /Channel history could not be loaded/);
		assert.doesNotMatch(
			text,
			/No recorded history/,
			'an unreachable manager must not be presented as an empty record'
		);
	} finally {
		await r.unmount();
		restoreFetch();
	}
});

test('an open channel still shows the live apparatus, with history alongside', async () => {
	const restoreFetch = stubManagerFetch();
	// Diagnostics agree the channel is live; closedness follows them.
	const r = await render(
		wrapped,
		tabProps({ diagnostics: { state: 'NORMAL', isPeerConnected: true, issues: [] } })
	);
	try {
		await settle(50);

		const row = r.$('tr.row-clickable');
		assert.ok(row, 'open channel row exists');
		await click(row);
		await settle(50);

		const text = modalText(r);
		// Live rows stay for a live channel (the stub answers health/policy).
		assert.match(text, /HTLC slots/);
		assert.match(text, /Routing policy/);
		// No recorded events for this channel and it is open, so no History row.
		assert.doesNotMatch(text, /History/);
	} finally {
		await r.unmount();
		restoreFetch();
	}
});
