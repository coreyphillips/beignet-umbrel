/**
 * The assets API: every route the dashboard calls for Taproot Assets, and the
 * only file that knows their paths.
 *
 * The routes live under /x/assets on a wallet's own API (the engine's host
 * extension namespace), so they are reached through the same `walletApi(id)`
 * every other tab uses, and answered in the same envelope. A component never
 * builds one of these paths itself: if a route moves, it moves here.
 *
 * Conventions the answers keep:
 *
 *   Amounts of an asset are decimal strings of base units, never numbers. An
 *   asset can hold 2^64 - 1 units and a JS number is exact only to 2^53.
 *   Sats are numbers, as everywhere else in the app.
 *
 *   Every object that carries an amount carries `decimalDisplay` beside it
 *   (an integer, or null for none), so it can be shown without a second
 *   lookup.
 *
 *   A write that moves money or mints carries an X-Idempotency-Key. Asked
 *   again with the same key, the wallet answers with what it did the first
 *   time, and records the key on the row as `clientRef`.
 *
 * Shapes, for the reader of the code that uses them:
 *
 *   Asset  { key, assetId, groupKey, name, type: 'normal' | 'collectible',
 *            decimalDisplay,
 *            balance: { total, onchain, pendingIn, pendingOut, channelLocal,
 *                       lightningSendable, lightningReceivable },
 *            lockedSats, anchors, canReissue, mintedHere,
 *            supply: { issued, burned, known },
 *            genesis: { outpoint, height, timestamp } }
 *          `key` is the group key when the asset has one, else the asset ID.
 *
 *   Row    { id, kind: 'mint' | 'receive' | 'send' | 'burn' | 'ln-receive' | 'ln-send',
 *            state: 'pending' | 'broadcast' | 'confirming' | 'proofs' | 'complete'
 *                 | 'failed' | 'cancelled' | 'waiting',
 *            failed, failure: { code, message, retrying } | null,
 *            assets: [{ key, assetId, name, type, decimalDisplay, amount }],
 *            txid, feeSats, satsPerVbyte, anchorSats, address, courier,
 *            paymentHash, confirmations, confirmationsRequired, stuck,
 *            at: { created, broadcast, confirmed, proof, completed }, clientRef }
 *
 *   Preview { previewId, expiresAt, asset, amount, change,
 *             fee: { sats, vbytes, feeRate },
 *             btc: { anchorSats, totalSats, spendableSats },
 *             courier: { uri, host, reachable }, warnings: [code] }
 */

const BASE = '/x/assets';

function query(params) {
	const parts = Object.entries(params || {})
		.filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? '1' : v)}`);
	return parts.length ? `?${parts.join('&')}` : '';
}

/** A key for one money-moving request, kept across its retries. */
export function idempotencyKey() {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The assets routes of one wallet, given its `walletApi(id)`.
 *
 * Methods that take a `key` last are the idempotent writes; the caller mints
 * the key once per intent (one press of Send) and passes the same one again
 * if it has to ask twice.
 */
export function assetsApi(api) {
	const get = (path, params) => api.get(BASE + path + query(params));
	const post = (path, body) => api.post(BASE + path, body || {});
	const once = (path, body, key) =>
		api.post(BASE + path, body || {}, { headers: { 'X-Idempotency-Key': key || idempotencyKey() } });

	return {
		/* ------------------------------------------------------------ reads */
		/** Whether assets are up, what is in progress, the proof server, the backup. */
		status: () => get('/status'),
		/** { assets: [Asset], btc: { anchorSats, anchorCount, spendableSats } } */
		balances: () => get('/balances'),
		/** One Asset, with { meta, proofs, issuances }. 404 ASSET_NOT_FOUND. */
		asset: (key) => get('/asset', { key }),
		/** { rows: [Row], nextBefore }. params: limit, before, key, pending, kind. */
		activity: (params) => get('/activity', params),
		/** An asset this wallet does not hold, by ID or group key, from the proof server. */
		lookup: (id) => post('/lookup', { id }),

		/* ------------------------------------------------------------- mint */
		/** { feeSats, vsize, anchorSats, totalSats, spendableSats, sufficient } */
		mintQuote: ({ count, feeRate }) => post('/mint/quote', { count, feeRate }),
		/** { row }, in state `broadcast`. seedlings: [{ name, type, amount, decimalDisplay, meta, group }] */
		mint: ({ seedlings, feeRate, maxFeeSats }, key) => once('/mint', { seedlings, feeRate, maxFeeSats }, key),

		/* ---------------------------------------------------------- receive */
		/** { address: { id, encoded, assetId, groupKey, amount, version, courier, createdAt }, row } */
		createAddress: ({ key, amount }) => post('/addresses', { key, amount }),
		/** What an address asks for: { network, assetId, groupKey, amount, type, version, courier, asset, own } */
		decodeAddress: (address) => post('/addresses/decode', { address }),
		/** Look for an address's payment now instead of waiting for the next block. */
		checkAddress: (id) => post('/addresses/check', { id }),
		/** Ask the proof server again for a receive whose proof is late. */
		retryProof: (id) => post('/proofs/retry', { id }),

		/* ------------------------------------------------------ proof files */
		/**
		 * The proof file of a send's payment, for the sender to hand to the
		 * recipient: { id, fileName, file (base64), bytes, assetId, address, txid }.
		 * PROOF_NOT_READY until the transaction is deep enough.
		 */
		exportProof: (id) => get('/proofs/export', { id }),
		/**
		 * Take a proof file (base64) for a payment to this wallet. { result, row }
		 * where result is 'complete', 'already', or 'kept' with
		 * { waitingFor: 'confirmations' | 'check', reason }. The wallet verifies
		 * it as it would a proof from a server; PROOF_INVALID when it does not pass.
		 */
		importProof: (file) => post('/proofs/import', { file }),
		/**
		 * Say that a send's proof was given to the recipient as a file, or take
		 * that back. It changes how the send reads; the wallet goes on offering
		 * the proof to the proof server. { row }.
		 */
		markProofHandedOver: (id, handedOver = true) => post('/proofs/handed-over', { id, handedOver }),

		/* ------------------------------------------------------------- send */
		/** A Preview for paying a Taproot Assets address. Supersedes this wallet's open one. */
		prepareSend: ({ address, feeRate }, key) => once('/send/prepare', { address, feeRate }, key),
		/** { row }. PREVIEW_EXPIRED means prepare again. */
		commitSend: (previewId, key) => once('/send/commit', { previewId }, key),
		cancelSend: (previewId) => post('/send/cancel', { previewId }),

		/* ------------------------------------------------------------- burn */
		prepareBurn: ({ key: assetKey, assetId, amount, feeRate }, key) =>
			once('/burn/prepare', { key: assetKey, assetId, amount, feeRate }, key),
		/** `confirmAmount` is the amount again, so a burn is said twice before it happens. */
		commitBurn: ({ previewId, confirmAmount }, key) => once('/burn/commit', { previewId, confirmAmount }, key),
		cancelBurn: (previewId) => post('/burn/cancel', { previewId }),

		/* -------------------------------------------------------- transfers */
		/** Put a transfer's transaction out again when the network has not shown it. */
		rebroadcast: (id) => post('/transfers/rebroadcast', { id }),

		/* --------------------------------------------------------- settings */
		/** { reachable, network, ms, error } for a proof server's REST address. */
		testProofServer: (rest) => post('/proof-server/test', { rest }),

		/* -------------------------------------------------------- lightning */
		/**
		 * { channels: [{ channelId, pendingChannelId, peerPubkey, peerAlias, state, asset, capacity, localBalance,
		 *   remoteBalance, sendable, receivable, channelSats, fundingTxid, reclaimable, reclaimTxid }] }
		 */
		channels: () => get('/channels'),
		/** { channelSats, feeSats, totalSats, spendableSats, sufficient } */
		channelQuote: ({ key, amount, feeRate }) => post('/channels/quote', { key, amount, feeRate }),
		/** { pendingChannelId, phase }. PEER_NO_ASSET_CHANNELS when the peer does not take them. */
		openChannel: ({ peer, key: assetKey, amount, feeRate }, key) =>
			once('/channels/open', { peer, key: assetKey, amount, feeRate }, key),
		closeChannel: ({ channelId, force }) => post('/channels/close', { channelId, force: !!force }),
		/**
		 * Take the funding of an open that has not confirmed back, with a transaction at `feeRate`.
		 * { channelId, pendingChannelId, txid, feeSats, feeRate }
		 */
		reclaimChannel: ({ channelId, feeRate }, key) => once('/channels/reclaim', { channelId, feeRate }, key),
		/** A price for receiving: { quoteId, peerPubkey, peerAlias, assetAmount, amountSats, rateText, expiresAt, maxReceivable } */
		invoiceQuote: ({ key, amount }) => post('/invoices/quote', { key, amount }),
		/** { bolt11, paymentHash, assetAmount, amountSats, rateText, expiresAt, invoiceExpiresAt, row } */
		createInvoice: ({ key, amount, description, quoteId }) => post('/invoices', { key, amount, description, quoteId }),
		invoices: () => get('/invoices'),
		/** A price for paying: { quoteId, assetAmount, amountSats, rateText, peerAlias, expiresAt, sendable } */
		payQuote: ({ bolt11, key, amountSats }) => post('/pay/quote', { bolt11, key, amountSats }),
		/** { status, paymentHash, assetAmount, feeSats, failureDescription }, or QUOTE_CHANGED with details.quote. */
		pay: ({ bolt11, key: assetKey, quoteId, maxAssetAmount }, key) =>
			once('/pay', { bolt11, key: assetKey, quoteId, maxAssetAmount }, key)
	};
}

/** The SSE event names the assets host sends, each listed in hooks/useSSE.js. */
export const ASSET_EVENTS = [
	'assets:status',
	'assets:mint',
	'assets:transfer',
	'assets:receive',
	'assets:proof-delivery',
	'assets:balance',
	'assets:backup',
	'assets:error',
	'assets:channel',
	'assets:invoice',
	'assets:payment'
];

/** The path prefix, for the mock, which has to answer the same routes. */
export const ASSETS_BASE = BASE;
