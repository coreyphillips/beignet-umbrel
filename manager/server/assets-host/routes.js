'use strict';

/**
 * The routes the assets host declares, and the handlers behind them.
 *
 * The daemon serves each at /x/assets<path>, behind its own authentication.
 * Reads are open to a read-only key; everything else is admin only (no
 * scopes). The five writes that mint or move an asset honour
 * X-Idempotency-Key. Lightning routes arrive with asset channels: none are
 * declared here, and the status says lightning is off.
 */
const ops = require('./ops');
const { refusal, mapError, isFenced } = require('./errors');

const READ = ['readonly'];
const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
// A proof file as base64 in a JSON body, with room for the wrapping.
const MAX_PROOF_BODY_BYTES = Math.ceil(ops.MAX_PROOF_FILE_BYTES / 3) * 4 + 4096;

const ROUTES = Object.freeze([
	{ method: 'GET', path: '/status', scopes: READ, summary: 'Whether assets are up, what is in progress, the proof server and the backup' },
	{ method: 'GET', path: '/balances', scopes: READ, summary: 'Every asset the wallet holds, and the bitcoin that travels with them' },
	{ method: 'GET', path: '/asset', scopes: READ, summary: 'One held asset by ID or group key, with its metadata, proofs and issuances' },
	{ method: 'GET', path: '/activity', scopes: READ, summary: 'Mints, receives, sends and burns, newest first' },
	{ method: 'POST', path: '/lookup', summary: 'Look an asset up on the proof server by ID or group key' },
	{ method: 'POST', path: '/mint/quote', summary: 'What minting would cost at a fee rate' },
	{ method: 'POST', path: '/mint', idempotent: true, summary: 'Create one or more assets in one transaction' },
	{ method: 'POST', path: '/addresses', summary: 'Make an address to receive an amount of an asset at' },
	{ method: 'POST', path: '/addresses/decode', summary: 'Read a Taproot Assets address' },
	{ method: 'POST', path: '/addresses/check', summary: 'Look for the payment of an address now' },
	{ method: 'POST', path: '/proofs/retry', summary: 'Ask the proof server again for a late proof' },
	{ method: 'GET', path: '/proofs/export', scopes: READ, summary: "The proof file of a send's payment, to hand to the recipient" },
	{ method: 'POST', path: '/proofs/import', maxBodyBytes: MAX_PROOF_BODY_BYTES, summary: 'Take the proof file of a payment to this wallet from the sender' },
	{ method: 'POST', path: '/proofs/handed-over', summary: "Mark a send's proof as given to the recipient as a file, or take that back" },
	{ method: 'POST', path: '/send/prepare', idempotent: true, summary: 'Fund and price a send without sending it' },
	{ method: 'POST', path: '/send/commit', idempotent: true, summary: 'Send what was previewed' },
	{ method: 'POST', path: '/send/cancel', summary: 'Drop a send preview' },
	{ method: 'POST', path: '/burn/prepare', idempotent: true, summary: 'Fund and price a burn without sending it' },
	{ method: 'POST', path: '/burn/commit', idempotent: true, summary: 'Burn what was previewed' },
	{ method: 'POST', path: '/burn/cancel', summary: 'Drop a burn preview' },
	{ method: 'POST', path: '/transfers/rebroadcast', summary: 'Send the transaction of a mint, send or burn to the network again' },
	{ method: 'POST', path: '/proof-server/test', summary: 'Whether a proof server answers at a web address' },
	{ method: 'POST', path: '/backup/export', summary: 'Write the assets backup file now' },
	{ method: 'POST', path: '/backup/import', maxBodyBytes: MAX_IMPORT_BYTES, summary: 'Restore an assets backup into this wallet' }
]);

// Every event the host may publish. The last three belong to asset channels.
const EVENTS = Object.freeze(['status', 'mint', 'transfer', 'receive', 'proof-delivery', 'balance', 'backup', 'error', 'channel', 'invoice', 'payment']);

const routeKey = (route) => `${route.method} ${route.path}`;

/** One handler per declared route, for a host that is running. */
function bind(host) {
	const table = {
		'GET /status': () => host.status(),
		'GET /balances': () => ops.balances(host),
		'GET /asset': (body, query) => ops.assetDetail(host, query),
		'GET /activity': (body, query) => ops.activity(host, query),
		'POST /lookup': (body) => ops.lookup(host, body),
		'POST /mint/quote': (body) => ops.mintQuote(host, body),
		'POST /mint': (body, query, key) => ops.mint(host, body, key),
		'POST /addresses': (body) => ops.createAddress(host, body),
		'POST /addresses/decode': (body) => ops.decodeAddress(host, body),
		'POST /addresses/check': (body) => ops.checkAddress(host, body),
		'POST /proofs/retry': (body) => ops.retryProof(host, body),
		'GET /proofs/export': (body, query) => ops.exportProof(host, query),
		'POST /proofs/import': (body) => ops.importProof(host, body),
		'POST /proofs/handed-over': (body) => ops.markProofHandedOver(host, body),
		'POST /send/prepare': (body, query, key) => ops.prepareSend(host, body, key),
		'POST /send/commit': (body, query, key) => ops.commit(host, 'send', body, key),
		'POST /send/cancel': (body) => ops.cancelPreview(host, 'send', body),
		'POST /burn/prepare': (body, query, key) => ops.prepareBurn(host, body, key),
		'POST /burn/commit': (body, query, key) => ops.commit(host, 'burn', body, key),
		'POST /burn/cancel': (body) => ops.cancelPreview(host, 'burn', body),
		'POST /transfers/rebroadcast': (body) => ops.rebroadcast(host, body),
		'POST /proof-server/test': (body) => ops.testProofServer(host, body),
		'POST /backup/export': () => ops.exportBackup(host),
		'POST /backup/import': (body) => ops.importBackup(host, body)
	};
	const handlers = {};
	for (const route of ROUTES) {
		const run = table[routeKey(route)];
		handlers[routeKey(route)] = async (request = {}) => {
			try {
				return await run(request.body && typeof request.body === 'object' ? request.body : {}, request.query, request.idempotencyKey);
			} catch (err) {
				if (isFenced(err)) {
					// The node under this host was replaced: this generation is over.
					host.shutdown();
					throw refusal('ASSETS_STOPPING', 'The wallet is restarting. Try again in a moment.', 503);
				}
				throw mapError(err);
			}
		};
	}
	return handlers;
}

/** Handlers for a host that could not start: the status says why, the rest refuse. */
function failedHandlers(status, message) {
	const handlers = {};
	for (const route of ROUTES) {
		handlers[routeKey(route)] =
			routeKey(route) === 'GET /status'
				? () => status()
				: () => {
						throw refusal('ASSETS_UNAVAILABLE', message, 503);
					};
	}
	return handlers;
}

module.exports = { ROUTES, EVENTS, bind, failedHandlers, routeKey };
