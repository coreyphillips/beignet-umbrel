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
	assert.match(hint(past, 'clearnet'), /past the published port window/);
	assert.equal(uri(past, 'local'), null);
	assert.match(hint(past, 'local'), /past the published port window/);
	const loading = nodeUris({ nodeId: null, rec: {}, lanHost: 'umbrel.local' });
	assert.deepEqual(keys(loading), ['clearnet', 'tor', 'local']);
	assert.equal(uri(loading, 'local'), null);
	assert.equal(hint(loading, 'local'), 'Not available yet.');
});
