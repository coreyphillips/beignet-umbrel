/**
 * Run with: npm test (from manager/ui).
 *
 * Which tabs a wallet's page offers, where Taproot Assets are concerned. The
 * Assets tab exists where the app has an assets host and the wallet has not
 * switched assets off. The simple view of a lightning-first wallet gains it
 * only once the wallet has an asset to show there. Everywhere else it is
 * absent, not empty.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tabsFor } from './WalletPage.jsx';
import { assetsShown } from '../lib/wallet-assets.js';

const keys = (options) => tabsFor(options).map(([key]) => key);

test('the full view has the Assets tab wherever assets are offered, held or not', () => {
	const full = keys({ simple: false, onchainOnly: false, assetsOffered: true, assetsHeld: false });
	assert.ok(full.includes('assets'));
	assert.equal(full.indexOf('assets'), full.indexOf('send') + 1, 'beside Send');
	assert.ok(keys({ simple: false, onchainOnly: true, assetsOffered: true, assetsHeld: false }).includes('assets'));
});

test('an on-chain only wallet keeps Assets and has no Lightning tabs', () => {
	const tabs = keys({ simple: false, onchainOnly: true, assetsOffered: true, assetsHeld: true });
	assert.ok(tabs.includes('assets'));
	for (const key of ['channels', 'peers', 'offers']) assert.ok(!tabs.includes(key), key);
});

test('the simple view shows Assets only once the wallet holds an asset', () => {
	const before = keys({ simple: true, onchainOnly: false, assetsOffered: true, assetsHeld: false });
	const after = keys({ simple: true, onchainOnly: false, assetsOffered: true, assetsHeld: true });
	assert.ok(!before.includes('assets'));
	assert.deepEqual(after, [...before, 'assets'], 'added at the end, nothing else moved');
});

test('no view has an Assets tab where assets are not offered', () => {
	for (const simple of [false, true]) {
		for (const onchainOnly of [false, true]) {
			for (const assetsHeld of [false, true]) {
				const tabs = keys({ simple, onchainOnly, assetsOffered: false, assetsHeld });
				assert.ok(!tabs.includes('assets'), JSON.stringify({ simple, onchainOnly, assetsHeld }));
				assert.ok(tabs.includes('overview'));
			}
		}
	}
});

test('assets are not offered without a host, or to a wallet that has switched them off', () => {
	const offered = (config, rec) =>
		keys({ simple: false, onchainOnly: false, assetsOffered: assetsShown(config, rec), assetsHeld: true }).includes('assets');
	assert.equal(offered({ assetsAvailable: true }, { assets: { enabled: true, holdsAssets: true } }), true);
	assert.equal(offered({ assetsAvailable: false }, { assets: { enabled: true, holdsAssets: true } }), false);
	assert.equal(offered({ assetsAvailable: true }, { assets: { enabled: false, holdsAssets: true } }), false);
	assert.equal(offered(null, { assets: { enabled: true } }), false, 'not before the config has answered');
});
