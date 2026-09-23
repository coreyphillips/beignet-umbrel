/**
 * Run with: npm test (from manager/ui).
 *
 * The reading of a NO_ROUTE estimate. The first case is the field case that
 * prompted it, pinned word for word: a wallet with 96,713 sats over two
 * channels that could not pay 50,000, because the invoice was reachable only
 * through the peer it held 10,033 with, and the other channel led nowhere.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS_PAY, explainNoRoute, isNoRouteFailure, noRouteLookups } from './no-route.js';

const H = '025501f56b72e7b999443b836ae1bff4c6fff514943d3f6677302a9189949bd99c';
const O = '031c4ec487a36eed013f62d6cf7c43fbedc1615c39b7351853994afb36c529b394';
const PAYEE = '030c3d68347ea93d924b68a1cc207e02fd10d1def79c3e12b515cf37d1d2118b57';
const HINT = [[{ pubkey: H, shortChannelId: 'f1e3ec71b6c0e830', feeBaseMsat: 1000, feeProportionalMillionths: 1, cltvExpiryDelta: 40 }]];

const chan = (peerPubkey, localBalanceSats, extra = {}) => ({
	channelId: 'c' + peerPubkey.slice(2, 8),
	peerPubkey,
	state: 'NORMAL',
	htlcUsable: true,
	isPrivate: true,
	capacitySats: localBalanceSats + 50_000,
	localBalanceSats,
	remoteBalanceSats: 50_000,
	...extra
});

const FIELD = {
	amountSats: 50_000,
	decoded: { payeeNodeKey: PAYEE, amountSats: 50_000, routingHints: HINT },
	channels: [chan(H, 10_033), chan(O, 86_680, { isPrivate: false })],
	liquidity: { sendableSats: 94_191, reserveSats: 2_522, totalLocalBalanceSats: 96_713 },
	peers: [
		{ pubkey: H, state: 'ready' },
		{ pubkey: O, state: 'ready' }
	],
	graph: { [H]: { alias: 'Powdered Sugar', channelCount: 1 }, [O]: { channelCount: 1 }, [PAYEE]: null },
	graphInfo: { nodeCount: 10_388, channelCount: 35_399 },
	lightningFirst: false
};

const FIELD_MESSAGE =
	'No route found for 50,000 sats. This invoice can be reached only through Powdered Sugar (025501…9bd99c), and this wallet holds 10,033 sats on its channel with that node, less than the payment. ' +
	"The other 86,680 sats sit on a channel with 031c4e…29b394, and this wallet's map of the Lightning network shows no path from there to that node, whose only public channel in the map is this one. " +
	'Pay stays available because the wallet may still split the payment across channels when it tries.';

test('the field case: reachable only through a peer the wallet holds too little with, the rest on a dead end', () => {
	const out = explainNoRoute(FIELD);
	assert.equal(out.code, 'NO_ROUTE');
	assert.equal(out.message, FIELD_MESSAGE);
	assert.match(out.remedy, /have that node pay an invoice from this wallet/);
	assert.equal(BLOCKS_PAY.has(out.code), false, 'the daemon may still split the payment');
});

test('the dead-end clause is only claimed when it is certain', () => {
	const privateOther = explainNoRoute({ ...FIELD, channels: [chan(H, 10_033), chan(O, 86_680)] });
	assert.match(privateOther.message, /shows no path from there to that node\. Pay stays/, 'a private channel of ours says nothing about the peer\'s public channels');
	const unknownOther = explainNoRoute({ ...FIELD, graph: { ...FIELD.graph, [O]: null } });
	assert.match(unknownOther.message, /to that node, which the map does not know\./);
	const connectedOther = explainNoRoute({ ...FIELD, graph: { ...FIELD.graph, [O]: { alias: 'Hub', channelCount: 40 } } });
	assert.match(connectedOther.message, /a channel with Hub \(031c4e…29b394\), and this wallet's map of the Lightning network shows no path from there to that node\. Pay stays/);
	const lookupFailed = explainNoRoute({ ...FIELD, graph: { [H]: FIELD.graph[H] } });
	assert.match(lookupFailed.message, /to that node\. Pay stays/);
});

test('several other channels are listed together', () => {
	const T = '03' + 'cd'.repeat(32);
	const out = explainNoRoute({ ...FIELD, channels: [...FIELD.channels, chan(T, 5_000)] });
	assert.match(out.message, /The other 91,680 sats sit on channels with 031c4e…29b394 and 03cdcd…cdcdcd, and this wallet's map of the Lightning network shows no path from there to that node\./);
});

test('a recipient we hold a channel with is reached over it, whatever the hints say', () => {
	const out = explainNoRoute({ ...FIELD, channels: [chan(PAYEE, 20_000), chan(O, 86_680)], graph: { ...FIELD.graph, [PAYEE]: { alias: 'Phone', channelCount: 0 } } });
	assert.match(out.message, /^No route found for 50,000 sats\. This wallet has a direct channel with the recipient, Phone \(030c3d…118b57\), and holds 20,000 sats on it, less than the payment\. The other 86,680 sats/);
	const spent = explainNoRoute({ ...FIELD, amountSats: 15_000, channels: [chan(PAYEE, 20_000)], graph: { [PAYEE]: { alias: 'Phone', channelCount: 0 } } });
	assert.match(spent.message, /and holds 20,000 sats on it, but the channel reserve and the routing fee come out of that, and the estimate could not fit the payment on it\. Pay stays/);
	const stuck = explainNoRoute({ ...FIELD, channels: [chan(PAYEE, 90_000, { state: 'AWAITING_REESTABLISH', htlcUsable: false }), chan(O, 86_680)], graph: { [PAYEE]: { alias: 'Phone', channelCount: 0 } } });
	assert.match(stuck.message, /recipient, Phone \(030c3d…118b57\), and it cannot send right now \(its peer is not connected\)\./);
});

test('enough on the gateway channel on paper: the reserve and the fee come out of it', () => {
	const out = explainNoRoute({ ...FIELD, amountSats: 9_000, decoded: { ...FIELD.decoded, amountSats: 9_000 } });
	assert.equal(out.code, 'NO_ROUTE');
	assert.equal(
		out.message,
		'No route found for 9,000 sats. This invoice can be reached only through Powdered Sugar (025501…9bd99c), and this wallet holds 10,033 sats on its channel with that node, but the channel reserve and the routing fee come out of that, and the estimate found no path from that node to the recipient with enough capacity. Pay stays available because the wallet may still split the payment across channels when it tries.'
	);
	assert.ok(out.remedy);
});

test('a gateway channel that is open but not sending holds Pay and says why', () => {
	const stuck = explainNoRoute({ ...FIELD, channels: [chan(H, 60_000, { state: 'AWAITING_REESTABLISH', htlcUsable: false }), chan(O, 86_680)], peers: [{ pubkey: O, state: 'ready' }] });
	assert.equal(stuck.code, 'CHANNEL_NOT_READY');
	assert.match(stuck.message, /this wallet's channel with that node cannot send right now \(its peer is not connected\)\. It resumes by itself/);
	assert.equal(BLOCKS_PAY.has(stuck.code), true);
	const splicing = explainNoRoute({ ...FIELD, channels: [chan(H, 60_000, { state: 'SPLICING', htlcUsable: false }), chan(O, 86_680)] });
	assert.match(splicing.message, /cannot send right now \(splicing\)/);
});

test('an invoice it cannot read', () => {
	assert.equal(explainNoRoute({ ...FIELD, amountSats: 0 }).code, 'INVALID_INVOICE');
	assert.equal(explainNoRoute({ ...FIELD, decoded: { routingHints: HINT } }).code, 'INVALID_INVOICE');
	assert.equal(explainNoRoute(null).code, 'INVALID_INVOICE');
});

test('no channel at all, and the lightning-first wording for it', () => {
	const none = explainNoRoute({ ...FIELD, channels: [] });
	assert.equal(none.code, 'NO_CHANNEL');
	assert.equal(none.message, 'This wallet has no Lightning channel to send from. Open one in the Channels tab.');
	assert.equal(BLOCKS_PAY.has(none.code), true);
	const closed = explainNoRoute({ ...FIELD, channels: [chan(H, 10_033, { state: 'CLOSED' }), chan(O, 8_000, { state: 'FORCE_CLOSED', htlcUsable: false })] });
	assert.equal(closed.code, 'NO_CHANNEL');
	const lfbw = explainNoRoute({ ...FIELD, channels: [], lightningFirst: true });
	assert.match(lfbw.message, /^This wallet has no Lightning channel yet\. Deposit bitcoin or receive a Lightning payment on the Receive tab/);
});

test('channels that take no new payment yet', () => {
	const down = explainNoRoute({ ...FIELD, channels: [chan(H, 10_033, { state: 'AWAITING_REESTABLISH', htlcUsable: false })], peers: [{ pubkey: H, state: 'connecting' }] });
	assert.equal(down.code, 'CHANNEL_NOT_READY');
	assert.equal(
		down.message,
		'Your channel with Powdered Sugar (025501…9bd99c) is open, but its peer is not connected right now, so nothing can be sent through it. It resumes by itself when the peer comes back.'
	);
	const unknownPeers = explainNoRoute({ ...FIELD, channels: [chan(H, 10_033, { state: 'AWAITING_FUNDING_CONFIRMED', htlcUsable: false })], peers: null });
	assert.equal(unknownPeers.message, 'Your channel cannot send yet (awaiting funding confirmed). Payments resume once it is ready.');
	const splicing = explainNoRoute({ ...FIELD, channels: [chan(H, 10_033, { state: 'SPLICING', htlcUsable: false })] });
	assert.equal(splicing.message, 'Your channel is mid-splice, and payments resume when the splice transaction confirms and locks.');
	assert.equal(BLOCKS_PAY.has('CHANNEL_NOT_READY'), true);
});

test('too little to send at all, with and without the reserve figure', () => {
	const short = explainNoRoute({ ...FIELD, liquidity: { sendableSats: 40_000, reserveSats: 2_522 } });
	assert.equal(short.code, 'INSUFFICIENT_FUNDS');
	assert.equal(
		short.message,
		'This wallet can send up to 40,000 sats over Lightning right now, which does not cover this 50,000 sats payment and its routing fee. 2,522 sats of the channel balance is held back as the channel reserve.'
	);
	assert.equal(BLOCKS_PAY.has(short.code), true);
	const exact = explainNoRoute({ ...FIELD, liquidity: { sendableSats: 50_000 } });
	assert.equal(exact.code, 'INSUFFICIENT_FUNDS', 'an exact match leaves nothing for the fee');
	assert.doesNotMatch(exact.message, /reserve/);
	const summed = explainNoRoute({ ...FIELD, liquidity: null, channels: [chan(H, 10_033), chan(O, 30_000)] });
	assert.equal(summed.code, 'INSUFFICIENT_FUNDS');
	assert.match(summed.message, /up to 40,033 sats/);
});

test('hinted through a node the wallet has no channel with', () => {
	const base = { ...FIELD, channels: [chan(O, 86_680, { isPrivate: false })] };
	const known = explainNoRoute({ ...base, graph: { [H]: { alias: 'Powdered Sugar', channelCount: 3 }, [O]: { channelCount: 1 } } });
	assert.equal(
		known.message,
		"No route found for 50,000 sats. This invoice can be reached only through Powdered Sugar (025501…9bd99c), and this wallet has no channel with that node, and its map of the Lightning network found no path to it with enough capacity. Pay stays available because the wallet may still split the payment across channels when it tries."
	);
	assert.equal(known.remedy, null);
	const unknown = explainNoRoute({ ...base, graph: { [H]: null, [O]: { channelCount: 1 } } });
	assert.match(unknown.message, /has no channel with that node and its map of the Lightning network does not know it either\.$/);
	const empty = explainNoRoute({ ...base, graphInfo: { nodeCount: 0, channelCount: 0 } });
	assert.match(empty.message, /and its map of the Lightning network is empty, so it cannot reach it through anyone else yet\./);
});

test('no hints and the recipient is not on the map', () => {
	const out = explainNoRoute({ ...FIELD, decoded: { payeeNodeKey: PAYEE, amountSats: 50_000 }, graph: { [H]: FIELD.graph[H], [O]: { channelCount: 30 }, [PAYEE]: null } });
	assert.equal(
		out.message,
		"No route found for 50,000 sats. The recipient (030c3d…118b57) is not in this wallet's map of the Lightning network, and the invoice carries no routing hints, so there is nothing to find a path to. Ask the recipient for an invoice that includes routing hints."
	);
});

test('no hints: an empty map, peers that lead nowhere, and the plain fallback', () => {
	const plain = { payeeNodeKey: PAYEE, amountSats: 50_000 };
	const empty = explainNoRoute({ ...FIELD, decoded: plain, graph: { [PAYEE]: { channelCount: 2 } }, graphInfo: { channelCount: 0 } });
	assert.match(empty.message, /map of the Lightning network is empty, so it cannot reach anyone it has no channel with\./);
	const deadEnds = explainNoRoute({ ...FIELD, decoded: plain, graph: { [H]: FIELD.graph[H], [O]: { channelCount: 1 }, [PAYEE]: { channelCount: 2 } } });
	assert.equal(
		deadEnds.message,
		"No route found for 50,000 sats. This wallet's map of the Lightning network shows no way past Powdered Sugar (025501…9bd99c) and 031c4e…29b394, which have no public channel there leading anywhere else. Open a channel with a well connected node."
	);
	const unknownPeers = explainNoRoute({ ...FIELD, decoded: plain, graph: { [H]: null, [O]: null, [PAYEE]: { channelCount: 2 } } });
	assert.match(unknownPeers.message, /which the map does not know at all\./);
	const fallback = explainNoRoute({ ...FIELD, decoded: plain, graph: { [H]: { alias: 'Powdered Sugar', channelCount: 5 }, [O]: { channelCount: 1 }, [PAYEE]: { alias: 'Shop', channelCount: 2 } } });
	assert.equal(
		fallback.message,
		'No route to the recipient (Shop (030c3d…118b57)) was found with enough capacity for 50,000 sats. Pay stays available because the wallet may still split the payment across channels when it tries.'
	);
});

test('the lookups: gateways first, then every usable peer, once each', () => {
	assert.deepEqual(noRouteLookups(FIELD.decoded, FIELD.channels), [H, O]);
	assert.deepEqual(noRouteLookups({ payeeNodeKey: PAYEE }, FIELD.channels), [PAYEE, H, O]);
	assert.deepEqual(noRouteLookups(FIELD.decoded, [chan(PAYEE, 1_000), chan(H, 10_033, { state: 'CLOSED' })]), [PAYEE, H]);
	assert.deepEqual(noRouteLookups(null, null), []);
});

test('isNoRouteFailure reads the daemon and the demo', () => {
	assert.equal(isNoRouteFailure('[NO_ROUTE] No route found to destination'), true);
	assert.equal(isNoRouteFailure('No route to the destination with enough liquidity.'), true);
	assert.equal(isNoRouteFailure('[INSUFFICIENT_BALANCE] Insufficient balance'), false);
	assert.equal(isNoRouteFailure(undefined), false);
});

// Built from its code point so the character itself never enters the source.
const EM_DASH = String.fromCharCode(0x2014);

test('no message carries an em-dash', () => {
	const variants = [
		FIELD,
		{ ...FIELD, amountSats: 0 },
		{ ...FIELD, channels: [] },
		{ ...FIELD, channels: [], lightningFirst: true },
		{ ...FIELD, channels: [chan(H, 10_033, { state: 'SPLICING', htlcUsable: false })] },
		{ ...FIELD, liquidity: { sendableSats: 40_000, reserveSats: 1 } },
		{ ...FIELD, amountSats: 9_000 },
		{ ...FIELD, channels: [chan(O, 86_680)] },
		{ ...FIELD, decoded: { payeeNodeKey: PAYEE }, graph: { [PAYEE]: null } },
		{ ...FIELD, decoded: { payeeNodeKey: PAYEE }, graph: { [PAYEE]: { channelCount: 2 } }, graphInfo: { channelCount: 0 } },
		{ ...FIELD, decoded: { payeeNodeKey: PAYEE }, graph: { [H]: null, [O]: null, [PAYEE]: { channelCount: 2 } } },
		{ ...FIELD, decoded: { payeeNodeKey: PAYEE }, graph: { [H]: { channelCount: 9 }, [O]: { channelCount: 9 }, [PAYEE]: { channelCount: 2 } } }
	];
	for (const facts of variants) {
		const out = explainNoRoute(facts);
		assert.equal(out.message.includes(EM_DASH), false, out.message);
		if (out.remedy) assert.equal(out.remedy.includes(EM_DASH), false, out.remedy);
	}
});
