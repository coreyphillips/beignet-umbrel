'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The dashboard reaches a wallet's daemon through the manager's proxy. A
 * capsule restore that holds asset channels is refused by the daemon with
 * the channels it names, and is run again without them only when the
 * dashboard's user confirmed that, with `omitAssetChannels` in the body.
 * These tests put the proxy in front of a stand-in daemon and check that
 * the manager hands the call on exactly as it came, adds no option of its
 * own, hands the refusal back with its details, and writes the refusal in
 * the wallet's log in its own sentence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const { createDaemonProxy, daemonFailureLine, RESTORE_REFUSALS } = require('./daemon-proxy');
const { ENGINE_ASSET_REFUSALS } = require('./wallet-manager');

const CHANNELS = [
	{ channelId: 'aa'.repeat(32), peerPubkey: `02${'bb'.repeat(32)}`, capacitySats: 100000 },
	{ channelId: 'cc'.repeat(32), peerPubkey: `03${'dd'.repeat(32)}`, capacitySats: 100000 }
];
const REFUSAL = { ok: false, error: { code: 'ASSET_RESTORE_REFUSED', message: 'the capsule holds asset channels that cannot be restored', details: { assetChannels: CHANNELS } } };
const RESTORED = { ok: true, result: { tier: 2, restartRequired: true, channelCount: 2, omittedAssetChannels: CHANNELS } };

function listen(server) {
	return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function waitFor(check, what, ms = 3000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 10));
	}
}

async function setup(t) {
	const seen = [];
	const daemon = http.createServer((req, res) => {
		let raw = '';
		req.on('data', (c) => (raw += c));
		req.on('end', () => {
			seen.push({ method: req.method, url: req.url, raw, auth: req.headers.authorization });
			res.setHeader('Content-Type', 'application/json');
			const body = raw ? JSON.parse(raw) : {};
			if (body.omitAssetChannels !== true) {
				res.statusCode = 409;
				res.end(JSON.stringify(REFUSAL));
				return;
			}
			res.end(JSON.stringify(RESTORED));
		});
	});
	const daemonPort = await listen(daemon);
	const logs = [];
	const manager = { target: () => `http://127.0.0.1:${daemonPort}`, token: () => 'wallet-token', recordLog: (id, line) => logs.push([id, line]) };
	const app = express();
	// As in index.js: the proxy first, the body parser after it.
	app.use('/wallets/:id/api', createDaemonProxy(manager));
	app.use(express.json());
	const server = http.createServer(app);
	const port = await listen(server);
	t.after(() => {
		for (const s of [server, daemon]) {
			if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
			s.close();
		}
	});
	const post = (body) => fetch(`http://127.0.0.1:${port}/wallets/w1/api/recovery/restore-capsule`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
	return { seen, logs, post };
}

test('a capsule restore reaches the daemon as the dashboard sent it, and the refusal comes back with the channels it names', async (t) => {
	const { seen, logs, post } = await setup(t);
	const plain = JSON.stringify({ confirm: true });
	const refused = await post(plain);
	assert.equal(refused.status, 409);
	assert.deepEqual(await refused.json(), REFUSAL, 'the refusal and its details, unchanged');
	assert.deepEqual(
		[seen[0].method, seen[0].url, seen[0].raw, seen[0].auth],
		['POST', '/recovery/restore-capsule', plain, 'Bearer wallet-token'],
		'the manager adds nothing: leaving the asset channels out is not its to ask for'
	);
	await waitFor(() => logs.length === 1, 'the log line');
	assert.deepEqual(logs[0], [
		'w1',
		`POST /recovery/restore-capsule failed [ASSET_RESTORE_REFUSED] ${ENGINE_ASSET_REFUSALS.ASSET_RESTORE_REFUSED} The refusal names 2 asset channels, and the restore can be run without them from the wallet's page.`
	]);

	// The one call the dashboard's user confirmed carries the option, and it goes through as it is.
	const confirmed = JSON.stringify({ confirm: true, omitAssetChannels: true });
	const done = await post(confirmed);
	assert.equal(done.status, 200);
	assert.deepEqual(await done.json(), RESTORED, 'what was left out is in the answer');
	assert.equal(seen[1].raw, confirmed);
	assert.equal(seen.length, 2);
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(logs.length, 1, 'a restore that went through is not logged as a failure');
});

test('a restore the engine refused over an asset channel is logged in the manager\'s sentence, and any other failure in the daemon\'s', () => {
	assert.match(RESTORE_REFUSALS.ASSET_RESTORE_REFUSED, /nothing was restored and nothing was written/);
	assert.equal(
		daemonFailureLine('POST', '/recovery/restore', 409, { code: 'AUXILIARY_GUARDIAN_RESTORE_REFUSED', message: 'aux channel in guardian state' }),
		`POST /recovery/restore failed [AUXILIARY_GUARDIAN_RESTORE_REFUSED] ${ENGINE_ASSET_REFUSALS.AUXILIARY_GUARDIAN_RESTORE_REFUSED}`
	);
	// No extension to take the channels: said for a restore, and not as a wallet that was not started.
	const required = daemonFailureLine('POST', '/recovery/restore-capsule', 409, { code: 'ASSET_PROVIDER_REQUIRED', message: 'no provider', details: { assetChannels: [CHANNELS[0]] } });
	assert.match(required, /^POST \/recovery\/restore-capsule failed \[ASSET_PROVIDER_REQUIRED\] The channel state that was to be restored holds an asset channel, and the assets part of this wallet is not running to take it, so nothing was restored and nothing was written\. The wallet is as it was\. The refusal names 1 asset channel, and the restore can be run without it from the wallet's page\.$/);
	assert.doesNotMatch(required, /not started/);
	// Another refusal of a restore, and the same code on another route, keep the daemon's words.
	assert.equal(daemonFailureLine('POST', '/recovery/restore-capsule', 409, { code: 'CAPSULE_RESTORE_TARGET_DIRTY', message: 'The database already holds channels' }), 'POST /recovery/restore-capsule failed [CAPSULE_RESTORE_TARGET_DIRTY] The database already holds channels');
	assert.equal(daemonFailureLine('POST', '/channels/open', 409, { code: 'ASSET_PROVIDER_REQUIRED', message: 'no provider' }), 'POST /channels/open failed [ASSET_PROVIDER_REQUIRED] no provider');
	assert.equal(daemonFailureLine('POST', '/send', 500, {}), 'POST /send failed [500]');
});
