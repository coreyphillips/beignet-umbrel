/**
 * Run with: npm test (from manager/ui).
 *
 * The connection URIs a wallet hands out, by network mode (umbrel #193).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostForUri, modeOf, nodeUris, usesOnion, usesPublic } from './node-uris.js';

const NODE = '02' + 'a'.repeat(64);
const ONION = `${'o'.repeat(56)}.onion:9101`;

const keys = (list) => list.map((o) => o.key);
const uri = (list, key) => list.find((o) => o.key === key)?.uri;
const hint = (list, key) => list.find((o) => o.key === key)?.hint;

test('a record without a mode is hybrid, and the modes say what they use', () => {
	assert.equal(modeOf({}), 'hybrid');
	assert.equal(modeOf(null), 'hybrid');
	assert.equal(modeOf({ networkMode: 'tor' }), 'tor');
	assert.equal(modeOf({ networkMode: 'bogus' }), 'hybrid');
	assert.deepEqual(['tor', 'clearnet', 'hybrid'].map((m) => [usesOnion(m), usesPublic(m)]), [[true, false], [false, true], [true, true]]);
	assert.equal(hostForUri('2001:db8::1'), '[2001:db8::1]');
	assert.equal(hostForUri('[2001:db8::1]'), '[2001:db8::1]');
	assert.equal(hostForUri('node.example.com'), 'node.example.com');
});

test('a hybrid wallet that announces both hands out all three ways in, public first', () => {
	const rec = { networkMode: 'hybrid', announce: true, publicHost: 'node.example.com', publicAddress: 'node.example.com:19101', publicPort: 19101, listenPort: 9101, onionAddress: ONION };
	const list = nodeUris({ nodeId: NODE, rec, lanHost: 'umbrel.local' });
	assert.deepEqual(keys(list), ['clearnet', 'tor', 'local']);
	assert.equal(uri(list, 'clearnet'), `${NODE}@node.example.com:19101`);
	assert.equal(uri(list, 'tor'), `${NODE}@${ONION}`);
	assert.equal(uri(list, 'local'), `${NODE}@umbrel.local:19101`, 'the LAN dials the published host port too');
});

test('a tor wallet has no clearnet way in; a clearnet wallet no Tor one', () => {
	const tor = nodeUris({ nodeId: NODE, rec: { networkMode: 'tor', announce: true, onionAddress: ONION, publicPort: 19101, listenPort: 9101 }, lanHost: 'umbrel.local' });
	assert.deepEqual(keys(tor), ['tor', 'local']);
	const clearnet = nodeUris({ nodeId: NODE, rec: { networkMode: 'clearnet', announce: true, publicHost: '203.0.113.4', publicAddress: '203.0.113.4:19101', publicPort: 19101, listenPort: 9101 }, lanHost: 'umbrel.local' });
	assert.deepEqual(keys(clearnet), ['clearnet', 'local']);
	assert.equal(uri(clearnet, 'clearnet'), `${NODE}@203.0.113.4:19101`);
});

test('each missing way in says why', () => {
	const off = nodeUris({ nodeId: NODE, rec: { networkMode: 'hybrid', announce: false, publicHost: '203.0.113.4', publicPort: 19101, listenPort: 9101 }, lanHost: 'umbrel.local' });
	assert.equal(uri(off, 'clearnet'), null);
	assert.match(hint(off, 'clearnet'), /Announcing is off/);
	assert.match(hint(off, 'tor'), /Announcing is off/);
	assert.equal(uri(off, 'local'), `${NODE}@umbrel.local:19101`, 'the home network needs no announcing');
	const noHost = nodeUris({ nodeId: NODE, rec: { networkMode: 'hybrid', announce: true, publicHost: '', publicPort: 19101, listenPort: 9101 }, lanHost: 'umbrel.local' });
	assert.match(hint(noHost, 'clearnet'), /No public address set/);
	assert.match(hint(noHost, 'tor'), /not published its Tor address yet/);
	const past = nodeUris({ nodeId: NODE, rec: { networkMode: 'hybrid', announce: true, publicHost: '203.0.113.4', publicPort: null, listenPort: 9131 }, lanHost: 'umbrel.local' });
	assert.match(hint(past, 'clearnet'), /no public port and no Tor address/, 'past the window there is no onion either');
	assert.doesNotMatch(hint(past, 'clearnet'), /over Tor/);
	assert.equal(uri(past, 'local'), null);
	assert.match(hint(past, 'local'), /only wallets in this app reach it/);
	const loading = nodeUris({ nodeId: null, rec: {}, lanHost: 'umbrel.local' });
	assert.deepEqual(keys(loading), ['clearnet', 'tor', 'local']);
	assert.equal(uri(loading, 'local'), null);
	assert.equal(hint(loading, 'local'), 'Not available yet.');
});

test('Iroh pairing is opt-in and independent of announcement and routing mode', () => {
	const uri = `${NODE}@iroh:${'a'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;
	const info = { irohAvailable: true, irohUri: uri };
	for (const networkMode of ['tor', 'clearnet', 'hybrid']) {
		const rec = { networkMode, announce: false, iroh: { enabled: true } };
		assert.equal(nodeUris({ nodeId: NODE, rec, info })[0].uri, uri);
		assert.equal(nodeUris({ nodeId: NODE, rec, info: {} }).some((w) => w.key === 'iroh'), false);
		assert.equal(nodeUris({ nodeId: NODE, rec: { ...rec, onchainOnly: true }, info }).some((w) => w.key === 'iroh'), false);
	}
	assert.equal(nodeUris({ nodeId: NODE, rec: {}, info }).some((w) => w.key === 'iroh'), false);
});

// Relay-only (beignet #1982): the link is called private only once the
// running daemon reports the mode, and is held back in every state where it
// might not be.
test('a relay-only Iroh link says who still sees the address, and is held back until the daemon reports the mode', () => {
	const uri = `${NODE}@iroh:${'a'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;
	const rec = { networkMode: 'tor', announce: false, iroh: { enabled: true, relayOnly: true } };
	const iroh = (args) => nodeUris({ nodeId: NODE, rec, relayOnlyAvailable: true, ...args })[0];

	const live = iroh({ info: { irohAvailable: true, irohUri: uri, irohRelayOnly: true, irohRelayOnlyMode: 'loopback-pin' } });
	assert.equal(live.uri, uri);
	assert.equal(live.relayOnly, true);
	assert.match(live.hint, /cannot learn this Umbrel's IP address/);
	assert.match(live.hint, /relay's operator still sees it/);
	assert.match(live.hint, /n0/);
	assert.doesNotMatch(live.hint, /Your phone and the relay can see/);
	// Tor mode with announcing off: nothing else ties the node id to an address.
	assert.deepEqual(live.warnings, []);

	// Starting: nothing to show yet, and the wait is explained.
	const starting = iroh({ info: { irohAvailable: true } });
	assert.equal(starting.uri, null);
	assert.match(starting.hint, /about 12 seconds/);
	assert.equal(starting.pending, true, 'on its way, so the card keeps its place');

	// The record says relay-only and the daemon answering is not in that mode
	// (the one from before the restart): no link is shown as private.
	const stale = iroh({ info: { irohAvailable: true, irohUri: uri } });
	assert.equal(stale.uri, null);
	assert.match(stale.hint, /has not started with it yet/);
	assert.equal(stale.pending, true);

	// The engine closed the endpoint because an address appeared.
	const closed = iroh({ info: { irohAvailable: true, irohListenError: { message: 'Relay-only Iroh endpoint closed: a routable address appeared' } } });
	assert.equal(closed.uri, null);
	assert.match(closed.hint, /routable address appeared/);
	// Off, not on its way: neither this nor a live link is pending.
	assert.equal(closed.pending, undefined);
	assert.equal(live.pending, undefined);

	// An engine without the switch: the manager starts no listener for it.
	const old = iroh({ relayOnlyAvailable: false, info: { irohAvailable: true } });
	assert.equal(old.uri, null);
	assert.match(old.hint, /bundled engine cannot provide it/);
});

test('a relay-only link names custom relays and warns beside an announced public address', () => {
	const uri = `${NODE}@iroh:${'a'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;
	const info = { irohAvailable: true, irohUri: uri, irohRelayOnly: true };
	const custom = nodeUris({
		nodeId: NODE,
		rec: { networkMode: 'tor', iroh: { enabled: true, relayOnly: true, relays: ['https://relay.example/'] } },
		info,
		relayOnlyAvailable: true
	})[0];
	assert.match(custom.hint, /Custom relays disable n0 discovery/);
	assert.doesNotMatch(custom.hint, /that is n0/);
	assert.deepEqual(custom.warnings, []);

	// The warnings stand apart from the hint, so the card can box them.
	const announced = nodeUris({
		nodeId: NODE,
		rec: { networkMode: 'hybrid', announce: true, publicHost: '203.0.113.4', publicAddress: '203.0.113.4:19102', iroh: { enabled: true, relayOnly: true } },
		info,
		relayOnlyAvailable: true
	})[0];
	assert.equal(announced.uri, uri);
	assert.doesNotMatch(announced.hint, /announces its public address/);
	assert.equal(announced.warnings.length, 2);
	assert.match(announced.warnings[0], /announces its public address/);
	assert.match(announced.warnings[1], /Hybrid mode/);
	// A wallet that holds a public address and does not announce it has nothing to look up.
	const quiet = nodeUris({
		nodeId: NODE,
		rec: { networkMode: 'hybrid', announce: false, publicHost: '203.0.113.4', publicAddress: '203.0.113.4:19102', iroh: { enabled: true, relayOnly: true } },
		info,
		relayOnlyAvailable: true
	})[0];
	assert.ok(!quiet.warnings.some((w) => /announces its public address/.test(w)));
});

// Relay only covers Iroh. A wallet that dials clearnet peers directly still
// shows its address to the peers its owner connects to, and to the ones it
// saved before the switch, so the mode is named on the link itself.
test('a relay-only link in Clearnet or Hybrid mode says which peers still see the address', () => {
	const uri = `${NODE}@iroh:${'a'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;
	const info = { irohAvailable: true, irohUri: uri, irohRelayOnly: true };
	const warnings = (rec) => nodeUris({ nodeId: NODE, rec: { announce: false, iroh: { enabled: true, relayOnly: true }, ...rec }, info, relayOnlyAvailable: true })[0].warnings;

	const hybrid = warnings({ networkMode: 'hybrid' });
	assert.equal(hybrid.length, 1);
	assert.match(hybrid[0], /Hybrid mode/);
	assert.match(hybrid[0], /dialed directly and see this Umbrel's IP address/);
	assert.match(hybrid[0], /Use Tor mode/);
	assert.match(warnings({ networkMode: 'clearnet', publicHost: '203.0.113.4' })[0], /Clearnet mode/);
	// A record with no mode reads as Hybrid, the default.
	assert.match(warnings({})[0], /Hybrid mode/);
	assert.deepEqual(warnings({ networkMode: 'tor' }), []);

	// Only a link shown as private carries them: one that offers direct
	// connections already says the phone sees the address.
	const direct = nodeUris({ nodeId: NODE, rec: { networkMode: 'hybrid', iroh: { enabled: true } }, info: { irohAvailable: true, irohUri: uri }, relayOnlyAvailable: true })[0];
	assert.equal(direct.warnings, undefined);
});

test('without relay-only the Iroh link reads as before and carries no relay-only mark', () => {
	const uri = `${NODE}@iroh:${'a'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;
	const way = nodeUris({ nodeId: NODE, rec: { networkMode: 'tor', iroh: { enabled: true } }, info: { irohAvailable: true, irohUri: uri }, relayOnlyAvailable: true })[0];
	assert.equal(way.uri, uri);
	assert.equal(way.relayOnly, false);
	assert.match(way.hint, /Your phone and the relay can see this Umbrel's IP address/);
});
