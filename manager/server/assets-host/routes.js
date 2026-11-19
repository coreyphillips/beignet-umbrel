'use strict';

/**
 * The routes the assets host declares, and the handlers behind them.
 *
 * The daemon serves each at /x/assets<path>, behind its own authentication.
 * Reads are open to a read-only key; everything else is admin only (no
 * scopes). The writes that mint or move an asset, open a channel or pay an
 * invoice honour X-Idempotency-Key.
 *
 * The nine Lightning routes are declared for every wallet. One whose engine
 * or library cannot carry assets in channels, or that was not asked to,
 * says so in its status (`lightning.mode` is 'off') and answers them with
 * LIGHTNING_UNAVAILABLE, but for the list of channels, which is then empty
 * or holds the channels still to be closed (lightning.js).
 */
const ops = require('./ops');
const lightning = require('./lightning');
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
	{ method: 'POST', path: '/backup/import', maxBodyBytes: MAX_IMPORT_BYTES, summary: 'Restore an assets backup into this wallet' },
	{ method: 'GET', path: '/channels', scopes: READ, summary: 'The Lightning channels that hold an asset, and what each can send and receive' },
	{ method: 'POST', path: '/channels/quote', summary: 'What opening an asset channel would cost at a fee rate' },
	{ method: 'POST', path: '/channels/open', idempotent: true, summary: 'Open a Lightning channel funded with an asset' },
	{ method: 'POST', path: '/channels/close', summary: 'Close an asset channel, with the peer or without it' },
	{ method: 'POST', path: '/channels/reclaim', idempotent: true, summary: 'Take back the bitcoin of a channel funding that will not confirm, which ends the open' },
	{ method: 'POST', path: '/invoices/quote', summary: "The channel peer's price for receiving an amount of an asset" },
	{ method: 'POST', path: '/invoices', summary: 'Make a Lightning invoice for an amount of an asset at a quoted price' },
	{ method: 'GET', path: '/invoices', scopes: READ, summary: 'The asset invoices this wallet has made, newest first' },
	{ method: 'POST', path: '/pay/quote', summary: 'How much of an asset paying a Lightning invoice would take' },
	{ method: 'POST', path: '/pay', idempotent: true, summary: 'Pay a Lightning invoice with an asset at a quoted price' }
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
		'POST /backup/import': (body) => ops.importBackup(host, body),
		'GET /channels': () => lightning.listChannels(host),
		'POST /channels/quote': (body) => lightning.channelQuote(host, body),
		'POST /channels/open': (body, query, key) => lightning.openChannel(host, body, key),
		'POST /channels/close': (body) => lightning.closeChannel(host, body),
		'POST /channels/reclaim': (body, query, key) => lightning.reclaimFunding(host, body, key),
		'POST /invoices/quote': (body) => lightning.invoiceQuote(host, body),
		'POST /invoices': (body) => lightning.createInvoice(host, body),
		'GET /invoices': () => lightning.listInvoices(host),
		'POST /pay/quote': (body) => lightning.payQuote(host, body),
		'POST /pay': (body, query, key) => lightning.pay(host, body, key)
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
