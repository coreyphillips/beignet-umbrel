/**
 * Run with: npm test (from manager/ui).
 *
 * The daemon lists an asset channel beside the bitcoin ones, marked
 * `auxiliary`. The bitcoin screens read the list without it, so its sats are
 * never offered as bitcoin the wallet can send, receive or lend.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { bitcoinChannels, bitcoinInvoices, bitcoinPayments, isAssetChannel, isAssetRow, isClosedChannel, openBitcoinChannelCount } from './channels.js';
import { readFileSync } from 'node:fs';

const btc = { channelId: 'a'.repeat(64), state: 'NORMAL', localBalanceSats: 500_000 };
const asset = { channelId: 'b'.repeat(64), state: 'NORMAL', localBalanceSats: 98_292, auxiliary: true };

test('only a channel the daemon marks auxiliary is an asset channel', () => {
	assert.equal(isAssetChannel(asset), true);
	assert.equal(isAssetChannel(btc), false);
	assert.equal(isAssetChannel({ ...btc, auxiliary: false }), false);
	assert.equal(isAssetChannel({ ...btc, auxiliary: 'true' }), false);
	assert.equal(isAssetChannel(null), false);
	assert.equal(isAssetChannel(undefined), false);
});

test('the bitcoin channels of a list are the rows that are not asset channels, in the order they came', () => {
	const closed = { channelId: 'c'.repeat(64), state: 'CLOSED' };
	assert.deepEqual(bitcoinChannels([btc, asset, closed]), [btc, closed]);
	assert.deepEqual(bitcoinChannels([asset]), []);
	assert.deepEqual(bitcoinChannels([]), []);
});

test('an answer that is not a list is handed back as it came, so a list that was not read still reads as not read', () => {
	assert.equal(bitcoinChannels(null), null);
	assert.equal(bitcoinChannels(undefined), undefined);
});

test('an asset channel is still a channel to the question "does this wallet have one open"', () => {
	assert.equal(isClosedChannel(asset), false);
	assert.equal([btc, asset].filter((c) => !isClosedChannel(c)).length, 2);
});

test('only a payment, an invoice or an event the daemon marks auxiliary is one an asset channel carried', () => {
	const paid = { paymentHash: 'd'.repeat(64), direction: 'OUTGOING', amountSats: 354, auxiliary: true };
	const plain = { paymentHash: 'e'.repeat(64), direction: 'OUTGOING', amountSats: 21_000 };
	assert.equal(isAssetRow(paid), true);
	assert.equal(isAssetRow(plain), false);
	assert.equal(isAssetRow({ ...plain, auxiliary: false }), false);
	assert.equal(isAssetRow({ ...plain, auxiliary: 1 }), false);
	assert.equal(isAssetRow(null), false);
	assert.equal(isAssetRow(undefined), false);
});

test('the bitcoin payments and invoices of a list leave out what an asset channel carried, and keep their order', () => {
	const out = { paymentHash: '1'.repeat(64), direction: 'OUTGOING', amountSats: 21_000 };
	const assetOut = { paymentHash: '2'.repeat(64), direction: 'OUTGOING', amountSats: 354, auxiliary: true };
	const assetIn = { paymentHash: '3'.repeat(64), direction: 'INCOMING', amountSats: 2_500, auxiliary: true };
	const inn = { paymentHash: '4'.repeat(64), direction: 'INCOMING', amountSats: 900 };
	assert.deepEqual(bitcoinPayments([out, assetOut, assetIn, inn]), [out, inn]);
	assert.deepEqual(bitcoinPayments([assetOut]), []);
	const invoice = { bolt11: 'lnbc1', status: 'PENDING', amountSats: 5_000 };
	const assetInvoice = { bolt11: 'lnbc2', status: 'PENDING', amountSats: 2_500, auxiliary: true };
	assert.deepEqual(bitcoinInvoices([assetInvoice, invoice]), [invoice]);
});

test('a payment or invoice answer that is not a list is handed back as it came', () => {
	assert.equal(bitcoinPayments(null), null);
	assert.equal(bitcoinInvoices(undefined), undefined);
});

test('a payment or an invoice a restore left unresolved is an asset row, so the bitcoin lists never show it', () => {
	const unresolved = { code: 'CHANNEL_OMITTED_AT_RESTORE', channelIds: ['c'.repeat(64)] };
	const stuck = { paymentHash: 'd'.repeat(64), direction: 'OUTGOING', status: 'PENDING', amountSats: 354, auxiliary: true, unresolved };
	const asked = { paymentHash: 'f'.repeat(64), status: 'PENDING', amountSats: 500, auxiliary: true, unresolved };
	const plain = { paymentHash: 'e'.repeat(64), direction: 'OUTGOING', status: 'PENDING', amountSats: 21_000 };
	assert.equal(isAssetRow(stuck), true);
	assert.deepEqual(bitcoinPayments([stuck, plain]), [plain]);
	assert.deepEqual(bitcoinInvoices([asked]), []);
});

test('the count of open channels is of bitcoin channels: an asset channel is in it in no state, open, closing or closed', () => {
	const bitcoin = [{ state: 'NORMAL' }, { state: 'AWAITING_FUNDING_CONFIRMED' }, { state: 'SHUTTING_DOWN' }, { state: 'CLOSED' }, { state: 'FORCE_CLOSED' }];
	assert.equal(openBitcoinChannelCount(bitcoin), 3);
	// Every state the daemon has for a channel, on a row marked as an asset channel: the count does not move.
	for (const state of ['NORMAL', 'AWAITING_FUNDING_CONFIRMED', 'AWAITING_REESTABLISH', 'SHUTTING_DOWN', 'NEGOTIATING_CLOSING', 'FORCE_CLOSED', 'CLOSED', 'ERRORED', 'SOMETHING_NEW']) {
		assert.equal(openBitcoinChannelCount([...bitcoin, { state, auxiliary: true }]), 3, state);
	}
	// No list is no count, which is never taken for none.
	for (const none of [null, undefined, {}, 'x']) assert.equal(openBitcoinChannelCount(none), null);
	assert.equal(openBitcoinChannelCount([]), 0);
});

test('no page counts or lists the daemon\'s channels without leaving its asset channels out, or shows the daemon\'s own count of every channel it has had', () => {
	const src = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
	// Every read of the daemon's list goes through bitcoinChannels or the count that does.
	for (const file of ['pages/WalletsPage.jsx', 'pages/WalletPage.jsx', 'pages/tabs/ChannelsTab.jsx', 'pages/tabs/OverviewTab.jsx', 'pages/tabs/SendTab.jsx', 'pages/tabs/ReceiveTab.jsx', 'pages/tabs/ToolsTab.jsx', 'pages/tabs/lfbw/LfbwOverviewTab.jsx', 'components/OfflineReceiveCard.jsx', 'lib/receive-invoice.js', 'lib/channel-open.js']) {
		const text = src(file).replace(/\s+/g, ' ');
		const reads = text.split(".get('/channels')").slice(1);
		assert.ok(reads.length > 0, `${file} reads the list`);
		for (const after of reads) assert.match(after, /^\s*\.then\((bitcoinChannels|openBitcoinChannelCount)\)/, `${file}: ${after.slice(0, 60)}`);
	}
	// The daemon's channelCount is every channel it has had, closed ones and asset channels included: the Channels tile never shows it.
	assert.doesNotMatch(src('pages/tabs/OverviewTab.jsx'), /openCount \?\? info\?\.channelCount/);
});
