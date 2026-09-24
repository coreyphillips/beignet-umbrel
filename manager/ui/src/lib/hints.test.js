/**
 * Run with: npm test (from manager/ui).
 *
 * The Tor hint on a failed peer dial follows the network mode (umbrel #193):
 * a Tor wallet routes every peer through the app's Tor, the other modes only
 * .onion peers, so the dialed host decides there.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { withPeerHint, withTorHint } from './hints.js';

const ONION = `${'o'.repeat(56)}.onion`;

test('a tor wallet gets the hint on any connection failure', () => {
	const out = withTorHint({ networkMode: 'tor' }, 'connect ETIMEDOUT', { host: '203.0.113.4' });
	assert.match(out, /routes every peer connection through Tor/);
	assert.match(out, /switch the wallet to Clearnet or Hybrid/);
	assert.equal(withTorHint({ networkMode: 'tor' }, 'Insufficient funds'), 'Insufficient funds', 'not a connection failure');
});

test('a hybrid or clearnet wallet gets it only for an onion peer', () => {
	for (const networkMode of ['hybrid', 'clearnet']) {
		assert.equal(withTorHint({ networkMode }, 'connect ETIMEDOUT', { host: '203.0.113.4' }), 'connect ETIMEDOUT', networkMode);
		const out = withTorHint({ networkMode }, 'connect ETIMEDOUT', { host: ONION });
		assert.match(out, /reached through the app's Tor/, networkMode);
		assert.doesNotMatch(out, /switch the wallet/, 'the mode is not the problem');
	}
	assert.equal(withTorHint({}, 'connect ETIMEDOUT'), 'connect ETIMEDOUT', 'no host known, no mode: nothing to add');
});

test('the peer hint carries the host through to the Tor hint', () => {
	const out = withPeerHint({ networkMode: 'hybrid' }, 'socks5 proxy failure', { port: 9735, host: ONION });
	assert.match(out, /reached through the app's Tor/);
	const handshake = withPeerHint({ networkMode: 'hybrid' }, 'closed during handshake', { port: 2101, host: ONION });
	assert.match(handshake, /web page on Umbrel/, 'a handshake close keeps its own reading');
});
