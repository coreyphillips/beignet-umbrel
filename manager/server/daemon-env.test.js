'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The one contract that decides a wallet's Lightning posture, held without
 * spawning anything. On-chain only is real on the daemon side exactly insofar
 * as this environment says so: no BEIGNET_LISTEN_PORT (the daemon only starts
 * its Lightning listener when a port is configured) and
 * BEIGNET_AUTO_RECONNECT=false (or the daemon dials its channel partners back
 * and the channels quietly reestablish behind a dashboard that shows nothing).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletManager } = require('./wallet-manager');

// Prototype methods only: the constructor reads registry and settings files,
// none of which the env builder needs.
function bareManager() {
	return Object.create(WalletManager.prototype);
}

const PATHS = { home: '/tmp/x/home', data: '/tmp/x/data' };
const rec = (extra = {}) => ({
	id: 'w1',
	name: 'Test wallet',
	network: 'mainnet',
	electrum: { host: 'umbrel.local', port: 50001, tls: false },
	tor: false,
	announce: false,
	port: 3001,
	...extra
});

test('a Lightning wallet listens, and is left to dial its peers', () => {
	const env = bareManager()._daemonEnv(rec(), PATHS, 'seed words', 'token');
	assert.equal(env.BEIGNET_LISTEN_PORT, String(3001 + 6000));
	assert.equal(env.BEIGNET_AUTO_RECONNECT, undefined);
});

test('an on-chain only wallet neither listens nor dials', () => {
	const env = bareManager()._daemonEnv(
		rec({ onchainOnly: true }),
		PATHS,
		'seed words',
		'token'
	);
	assert.equal(env.BEIGNET_LISTEN_PORT, undefined, 'no listener port, no listener');
	assert.equal(env.BEIGNET_AUTO_RECONNECT, 'false', 'and no dialing peers back');
	assert.equal(
		env.BEIGNET_ANNOUNCE_ADDRESSES,
		undefined,
		'nothing announced, there is nothing to reach'
	);
});

test('flipping the flag flips the whole posture, both directions', () => {
	const m = bareManager();
	const parked = m._daemonEnv(rec({ onchainOnly: true }), PATHS, 's', 't');
	const revived = m._daemonEnv(rec({ onchainOnly: false }), PATHS, 's', 't');
	assert.equal(parked.BEIGNET_LISTEN_PORT, undefined);
	assert.equal(revived.BEIGNET_LISTEN_PORT, String(9001));
	assert.equal(parked.BEIGNET_AUTO_RECONNECT, 'false');
	assert.equal(revived.BEIGNET_AUTO_RECONNECT, undefined);
});
