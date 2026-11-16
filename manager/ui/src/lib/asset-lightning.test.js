/**
 * Run with: npm test (from manager/ui).
 *
 * The judgements behind the Lightning side of assets: when any of it is
 * shown, what a channel's state is called, how a typed peer is read, when a
 * price has run out, and what each refusal says. These decide whether a
 * wallet without asset channels sees none of it, and whether a reader is
 * ever asked to pay an amount they were not shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	assetChannelsOffered,
	canClose,
	channelAssets,
	channelState,
	invoiceDeadline,
	invoiceStanding,
	lightningRefusal,
	parsePeer,
	payFailure,
	payLabel,
	payableAssets,
	peerName,
	quoteChange,
	quoteExpired,
	quoteLeft,
	sharePct
} from './asset-lightning.js';

const NOW = 1_800_000_000_000;
const BUSD = {
	key: 'g1',
	assetId: 'a'.repeat(64),
	name: 'BUSD',
	type: 'normal',
	decimalDisplay: 2,
	balance: { total: '1490000', onchain: '1250000', channelLocal: '240000', lightningSendable: '240000', lightningReceivable: '310000' }
};
const POINTS = { key: 'p1', assetId: 'b'.repeat(64), name: 'Club Points', type: 'normal', decimalDisplay: 0, balance: { onchain: '900', lightningSendable: '0' } };
const TICKET = { key: 't1', assetId: 'c'.repeat(64), name: 'Ticket', type: 'collectible', decimalDisplay: 0, balance: { onchain: '1', lightningSendable: '1' } };
const SPENT = { key: 's1', assetId: 'd'.repeat(64), name: 'Spent', type: 'normal', decimalDisplay: 0, balance: { onchain: '0', lightningSendable: '40' } };

const ON = { assetsAvailable: true, assetChannelsAvailable: true };
const FULL = { lightning: { mode: 'full', usableChannels: 1 } };
const OFF = { lightning: { mode: 'off', usableChannels: 0 } };

test('asset channels are shown only when the engine, the wallet and its assets host all say so', () => {
	assert.equal(assetChannelsOffered({ config: ON, rec: {}, status: FULL }), true);
	assert.equal(assetChannelsOffered({ config: { assetsAvailable: true, assetChannelsAvailable: false }, rec: {}, status: FULL }), false, 'an engine that cannot carry them');
	assert.equal(assetChannelsOffered({ config: { assetChannelsAvailable: true }, rec: {}, status: FULL }), false, 'an app with no assets host');
	assert.equal(assetChannelsOffered({ config: ON, rec: { onchainOnly: true }, status: FULL }), false, 'a wallet with no Lightning');
	// Off for a reason the host gives is still shown: its channels can be closed, and the rest is held with that reason.
	const held = { lightning: { mode: 'off', usableChannels: 1, unavailable: { code: 'NOT_ADVERTISED', message: 'The node does not offer asset channels.', reason: 'x' } } };
	assert.equal(assetChannelsOffered({ config: ON, rec: {}, status: held }), true);
	assert.equal(assetChannelsOffered({ config: ON, rec: { onchainOnly: true }, status: held }), false);
	assert.equal(assetChannelsOffered({ config: ON, rec: {}, status: { lightning: { mode: 'off', unavailable: { code: 'NOT_ADVERTISED', message: ' ' } } } }), false, 'a reason with no words is no reason');
	assert.equal(assetChannelsOffered({ config: ON, rec: { assets: { enabled: false } }, status: FULL }), false, 'a wallet with assets switched off');
	assert.equal(assetChannelsOffered({ config: ON, rec: {}, status: OFF }), false, 'a host whose Lightning side is off, as every real one is today');
	assert.equal(assetChannelsOffered({ config: ON, rec: {}, status: null }), false, 'and nothing before the host has answered');
	assert.equal(assetChannelsOffered({ config: ON, rec: {}, status: {} }), false);
	assert.equal(assetChannelsOffered({ config: null, rec: {}, status: FULL }), false);
	assert.equal(assetChannelsOffered(), false);
});

test("a channel's state is a word a person uses, and only an open one is usable", () => {
	assert.deepEqual(channelState('NORMAL'), { word: 'open', tone: 'green', usable: true });
	assert.deepEqual(channelState('OPENING'), { word: 'opening', tone: 'yellow', usable: false });
	assert.equal(channelState('AWAITING_FUNDING_CONFIRMED').word, 'opening');
	assert.equal(channelState('SHUTTING_DOWN').word, 'closing');
	assert.equal(channelState('AWAITING_REESTABLISH').word, 'reconnecting');
	assert.deepEqual(channelState('FORCE_CLOSED'), { word: 'force closed', tone: 'red', usable: false });
	assert.equal(channelState('CLOSED').tone, 'muted');
	assert.deepEqual(channelState('SOME_NEW_STATE'), { word: 'some new state', tone: 'muted', usable: false }, "a state not met before is said in the wallet's word");
	assert.equal(channelState(undefined).word, 'unknown');

	assert.equal(canClose({ state: 'NORMAL' }), true);
	assert.equal(canClose({ state: 'OPENING' }), true);
	assert.equal(canClose({ state: 'SHUTTING_DOWN' }), false, 'a channel on its way out is not closed twice');
	assert.equal(canClose({ state: 'CLOSED' }), false);
});

test('the balance bar is worked out in whole units, however large', () => {
	assert.equal(sharePct('240000', '310000'), 43.6);
	assert.equal(sharePct('1', '0'), 100);
	assert.equal(sharePct('0', '5'), 0);
	assert.equal(sharePct('0', '0'), 0, 'an empty channel draws an empty bar, not a division by zero');
	// 2^64 - 1 on each side: far past what a number holds, and still a half.
	assert.equal(sharePct('18446744073709551615', '18446744073709551615'), 50);
	assert.equal(sharePct('9007199254740993', '27021597764222979'), 25);
	assert.equal(sharePct('nonsense', '10'), 0);
});

test('a peer is named by its alias, or by the two ends of its key', () => {
	assert.equal(peerName({ peerAlias: 'Lightning Labs edge', peerPubkey: '02' + 'a'.repeat(64) }), 'Lightning Labs edge');
	assert.equal(peerName({ peerAlias: '  ', peerPubkey: '02' + 'ab'.repeat(32) }), '02ababab…ababab');
	assert.equal(peerName({}), 'an unnamed peer');
});

test('only a counted asset with some on-chain can fund a channel, and only one a channel can send can pay', () => {
	assert.deepEqual(channelAssets([BUSD, POINTS, TICKET, SPENT]).map((a) => a.name), ['BUSD', 'Club Points']);
	assert.deepEqual(payableAssets([BUSD, POINTS, TICKET, SPENT]).map((a) => a.name), ['BUSD', 'Spent']);
	assert.deepEqual(channelAssets(null), []);
	assert.deepEqual(payableAssets(undefined), []);
});

test('a typed peer is read as a key, with or without where it listens', () => {
	const key = '02' + 'ab'.repeat(32);
	assert.deepEqual(parsePeer(''), { ok: false, reason: null }, 'an empty box is not refused');
	assert.deepEqual(parsePeer(`  ${key.toUpperCase()} `), { ok: true, peer: { pubkey: key, host: null, port: null } });
	assert.deepEqual(parsePeer(`${key}@10.0.0.4:9736`), { ok: true, peer: { pubkey: key, host: '10.0.0.4', port: 9736 } });
	assert.deepEqual(parsePeer(`${key}@node.example`).peer, { pubkey: key, host: 'node.example', port: 9735 }, 'the usual port when none is given');
	assert.deepEqual(parsePeer(`${key}@[2001:db8::1]:9735`).peer, { pubkey: key, host: '[2001:db8::1]', port: 9735 });
	assert.deepEqual(parsePeer(`${key}@abcdefghijklmnop.onion:9735`).peer.host, 'abcdefghijklmnop.onion');

	assert.match(parsePeer('lnbc1…').reason, /starts with its node public key/);
	assert.match(parsePeer(key.slice(0, 40)).reason, /66 characters, and this is 40/);
	assert.match(parsePeer('04' + 'ab'.repeat(32)).reason, /starts with 02 or 03/);
	assert.match(parsePeer(`${key}@`).reason, /host:port/);
	assert.match(parsePeer(`${key}@host:port`).reason, /host:port/);
	assert.match(parsePeer(`${key}@host:70000`).reason, /1 to 65535/);
	assert.match(parsePeer(`${key}@host:0`).reason, /1 to 65535/);
});

test('a price has the time its expiry gives it, and none without one', () => {
	assert.equal(quoteLeft({ expiresAt: NOW + 30_000 }, NOW), 30_000);
	assert.equal(quoteLeft({ expiresAt: NOW - 1 }, NOW), 0);
	assert.equal(quoteLeft({}, NOW), 0);
	assert.equal(quoteLeft(null, NOW), 0);
	assert.equal(quoteExpired({ expiresAt: NOW + 1 }, NOW), false);
	assert.equal(quoteExpired({ expiresAt: NOW }, NOW), true);
	assert.equal(quoteExpired(null, NOW), true, 'no price is an expired one: nothing can be paid at it');
});

test('the pay button names the amount it will pay', () => {
	assert.equal(payLabel({ assetAmount: '1250' }, BUSD), 'Pay 12.50 BUSD');
	assert.equal(payLabel({ assetAmount: '40' }, POINTS), 'Pay 40 Club Points');
	assert.equal(payLabel(null, BUSD), 'Pay');
	assert.equal(payLabel({ assetAmount: '1' }, null), 'Pay');
});

test('a changed price says both figures and that nothing was paid', () => {
	const up = quoteChange({ assetAmount: '1250' }, { assetAmount: '1275' }, BUSD);
	assert.equal(up.direction, 'more');
	assert.match(up.text, /nothing was paid\. It is now 12\.75 BUSD, up from 12\.50 BUSD\. Press Pay again only if the new amount is right\./);

	const down = quoteChange({ assetAmount: '1250' }, { assetAmount: '1200' }, BUSD);
	assert.equal(down.direction, 'less');
	assert.match(down.text, /It is now 12\.00 BUSD, down from 12\.50 BUSD/);

	const same = quoteChange({ assetAmount: '1250' }, { assetAmount: '1250' }, BUSD);
	assert.equal(same.direction, 'same');
	assert.match(same.text, /The price ran out before the payment was made, so nothing was paid\. A new one has been given, and it is still 12\.50 BUSD/);
});

test('an invoice made here is payable until the earlier of its expiry and the end of its price', () => {
	assert.equal(invoiceDeadline({ expiresAt: NOW + 60_000, invoiceExpiresAt: NOW + 3_600_000 }), NOW + 60_000);
	assert.equal(invoiceDeadline({ expiresAt: NOW + 60_000, invoiceExpiresAt: NOW + 10_000 }), NOW + 10_000);
	assert.equal(invoiceDeadline({ invoiceExpiresAt: NOW + 10_000 }), NOW + 10_000);
	assert.equal(invoiceDeadline({}), null);
});

test('an invoice is paid when the wallet says so, and never because the clock ran', () => {
	const invoice = { expiresAt: NOW + 60_000, invoiceExpiresAt: NOW + 3_600_000 };
	assert.equal(invoiceStanding({ invoice, row: { state: 'waiting' }, now: NOW }), 'waiting');
	assert.equal(invoiceStanding({ invoice, row: { state: 'complete' }, now: NOW }), 'paid');
	assert.equal(invoiceStanding({ invoice, row: { state: 'waiting' }, listed: { status: 'PAID' }, now: NOW }), 'paid', 'the invoice list is believed too');
	assert.equal(invoiceStanding({ invoice, row: { state: 'waiting' }, listed: { status: 'OPEN' }, now: NOW }), 'waiting');
	assert.equal(invoiceStanding({ invoice, row: { state: 'waiting' }, now: NOW + 60_000 }), 'expired');
	assert.equal(invoiceStanding({ invoice, row: { state: 'complete' }, now: NOW + 90_000 }), 'paid', 'paid late is still paid');
	assert.equal(invoiceStanding({ invoice, row: { state: 'waiting', failed: true }, now: NOW }), 'failed');
	assert.equal(invoiceStanding({ invoice: {}, row: null, now: NOW }), 'waiting');
});

const refusal = (code, details, message) => Object.assign(new Error(message || code), { code, details, status: 400 });

test('each Lightning refusal is said in plain words, with the figure that matters', () => {
	const none = lightningRefusal(refusal('INSUFFICIENT_INBOUND', { maxReceivable: '0' }), { asset: BUSD });
	assert.equal(none.code, 'INSUFFICIENT_INBOUND');
	assert.match(none.text, /No channel of this wallet can receive BUSD right now/);
	assert.match(none.text, /An on-chain address works meanwhile/);

	const above = lightningRefusal(refusal('INSUFFICIENT_INBOUND', { maxReceivable: '310000' }), { asset: BUSD });
	assert.match(above.text, /The most this wallet can receive over Lightning right now is 3,100\.00 BUSD/);

	const out = lightningRefusal(refusal('INSUFFICIENT_OUTBOUND', { sendable: '240000' }), { asset: BUSD });
	assert.match(out.text, /needs more than the 2,400\.00 BUSD this wallet can send over Lightning right now/);
	assert.match(lightningRefusal(refusal('INSUFFICIENT_OUTBOUND', { sendable: '0' }), { asset: BUSD }).text, /No channel of this wallet can send BUSD right now/);

	assert.equal(lightningRefusal(refusal('QUOTE_EXPIRED')).text, 'That price has expired. Ask for a new one.');
	assert.match(lightningRefusal(refusal('PEER_NO_ASSET_CHANNELS')).text, /does not open asset channels, so nothing was opened and nothing was spent/);
	assert.equal(
		lightningRefusal(refusal('INSUFFICIENT_BTC', { needed: 104320, spendable: 50000 })).text,
		'Opening needs 104,320 sats on-chain and this wallet has 50,000 sats. Deposit bitcoin on the Receive tab first.'
	);
	assert.match(lightningRefusal(refusal('INSUFFICIENT_BTC')).text, /does not have the bitcoin on-chain that opening needs/);
	assert.match(lightningRefusal(refusal('INSUFFICIENT_ASSET_BALANCE'), { asset: BUSD }).text, /does not hold that much BUSD on-chain/);
	assert.match(lightningRefusal(refusal('AMOUNT_REQUIRED')).text, /does not name an amount, so say how many sats to pay/);
	assert.match(lightningRefusal(refusal('BAD_INVOICE')).text, /could not read that invoice/);
	assert.match(lightningRefusal(refusal('LIGHTNING_UNAVAILABLE')).text, /has no Lightning/);
	assert.match(lightningRefusal(refusal('CHANNEL_NOT_FOUND')).text, /no longer has that channel/);
	assert.equal(lightningRefusal(null), null);
});

test('a refusal with no sentence of its own is said in the wallet words, and a bare code never is', () => {
	const own = lightningRefusal(refusal('PEER_UNREACHABLE', null, 'The peer could not be reached'));
	assert.deepEqual(own, { code: 'PEER_UNREACHABLE', text: 'The peer could not be reached.' });

	const silent = lightningRefusal(Object.assign(new Error(''), { code: 'SOMETHING_NEW' }));
	assert.equal(silent.text, 'The wallet refused this, and did not say why.');
	assert.doesNotMatch(silent.text, /SOMETHING_NEW/);

	const dropped = lightningRefusal(new Error('Failed to fetch'));
	assert.equal(dropped.code, 'NO_ANSWER');
	assert.equal(dropped.text, 'The wallet did not answer: Failed to fetch.');

	const down = lightningRefusal(Object.assign(new Error('The wallet is not running'), { code: 'NOT_RUNNING' }));
	assert.match(down.text, /^The wallet did not answer: The wallet is not running\.$/);

	const unknown = lightningRefusal(Object.assign(new Error('timeout'), { unknown: true }));
	assert.match(unknown.text, /not known whether this went through/);
});

test('a failed payment says why, and that nothing was paid', () => {
	assert.equal(payFailure({ failureDescription: 'no route found' }), 'The payment did not go through, and nothing was paid. No route found.');
	assert.equal(payFailure({ failureDescription: '' }), 'The payment did not go through, and nothing was paid. The wallet did not say why.');
	assert.equal(payFailure(null), 'The payment did not go through, and nothing was paid. The wallet did not say why.');
});

test('a channel the node no longer holds is said to be not held here, carries nothing and cannot be closed', () => {
	assert.deepEqual(channelState('MISSING'), { word: 'not held here', tone: 'red', usable: false });
	assert.equal(canClose({ state: 'MISSING' }), false);
	assert.equal(canClose({ state: 'NORMAL' }), true);
});

import { channelableOf as mostInOne, lightningRefusal as saidOf } from './asset-lightning.js';

test('the most that goes into one channel is what the wallet holds of a single issuance, and the refusals over it are sentences', () => {
	const asset = (balance) => ({ name: 'BUSD', decimalDisplay: 2, balance });
	assert.equal(mostInOne(asset({ onchain: '1250000', channelable: '900000' })), '900000');
	assert.equal(mostInOne(asset({ onchain: '1250000', channelable: '1250000' })), '1250000');
	// A host that does not say, or says more than is there: all that is on-chain.
	assert.equal(mostInOne(asset({ onchain: '1250000' })), '1250000');
	assert.equal(mostInOne(asset({ onchain: '500', channelable: '900' })), '500');
	assert.equal(mostInOne(null), '0');

	const over = saidOf({ code: 'CHANNEL_ASSETS', message: 'As the host said it.', details: { needed: '1000000', largest: '900000', available: '1250000', issuances: 2 } }, { asset: asset({}) });
	assert.equal(over.code, 'CHANNEL_ASSETS');
	assert.match(over.text, /^A channel holds units of one issuance of an asset\. This wallet holds enough BUSD in all, spread over 2 issuances, and the most it has of a single one on-chain is 9,000\.00 BUSD\. Open a channel with that much or less, and another for the rest\.$/);
	assert.equal(saidOf({ code: 'CHANNEL_ASSETS', message: 'As the host said it.', details: {} }).text, 'As the host said it.');

	const short = saidOf({ code: 'FUNDING_INPUTS', message: 'As the host said it.', details: { eligibleSats: '40000', neededSats: '104320', otherSats: '250000' } });
	assert.equal(
		short.text,
		'The bitcoin for an asset channel has to be on native SegWit addresses. This wallet has 40,000 sats on those, and this needs about 104,320 sats. Another 250,000 sats are on addresses of other types, which cannot be used for it. Nothing was done and nothing was spent.'
	);
	assert.doesNotMatch(saidOf({ code: 'FUNDING_INPUTS', message: 'x', details: { eligibleSats: '0', neededSats: '360', otherSats: '0' } }).text, /Another/);
	assert.equal(saidOf({ code: 'FUNDING_INPUTS', message: 'As the host said it.', details: {} }).text, 'As the host said it.');
});

import { feeCoinsShort as shortOfFeeCoins } from './asset-lightning.js';

test('a wallet is short of fee coins only when the node says it has no bitcoin to prepare one from', () => {
	const said = (extra) => ({ possible: false, neededSats: '1500', largestConfirmedSats: '0', ready: 0, budgetRemainingSats: '25000', reason: 'FEE_FUNDS_UNAVAILABLE', ...extra });
	assert.equal(shortOfFeeCoins(said()), true);
	assert.equal(shortOfFeeCoins(said({ possible: true, reason: null })), false);
	// A used-up budget is another matter, with a note of its own.
	assert.equal(shortOfFeeCoins(said({ reason: 'FEE_BUDGET_EXHAUSTED' })), false);
	assert.equal(shortOfFeeCoins(said({ neededSats: undefined })), false);
	assert.equal(shortOfFeeCoins(null), false);
	assert.equal(shortOfFeeCoins(undefined), false);
});
