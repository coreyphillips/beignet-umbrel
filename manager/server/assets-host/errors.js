'use strict';

/**
 * Errors of the assets host.
 *
 * A route refuses by throwing an Error that carries `extensionCode`, `status`
 * and optionally `details`. The engine reads a refusal by that shape
 * (beignet's docs/EXTENSIONS.md), so nothing here loads a class from the
 * engine. Anything else a handler throws reaches the caller as a generic 500
 * and is logged by the daemon with its stack.
 *
 * The library underneath (ts-tap, and its Beignet adapter) throws errors with
 * a stable string `code`. mapError turns the ones a person can act on into
 * the codes the dashboard knows (manager/ui/src/lib/assets-api.js).
 */

function refusal(code, message, status = 400, details) {
	const err = new Error(message);
	err.extensionCode = code;
	err.status = status;
	if (details !== undefined) err.details = details;
	return err;
}

const isRefusal = (err) => !!err && typeof err.extensionCode === 'string';

/** The library's code for an error, or '' when it has none. */
const codeOf = (err) => (err && typeof err.code === 'string' ? err.code : '');

/** A storage call made after the node's database was replaced or closed. */
const isFenced = (err) => /database connection is not open/i.test(String((err && err.message) || ''));

/**
 * A chain wait that found nothing yet. The adapter is built so that a wait
 * is one look at the chain, and this is what "not yet" looks like.
 */
const isNotYet = (err) => ['ERR_BEIGNET_TIMEOUT', 'ERR_TAPGARDEN_NOT_BURIED'].includes(codeOf(err));

/** Trouble reaching or talking to a proof server, as opposed to a refusal of ours. */
function isCourierTrouble(err) {
	const code = codeOf(err);
	return (
		/^ERR_(COURIER|MAILBOX|ECIES)_/.test(code) ||
		['TOR_UNAVAILABLE', 'PROOF_SERVER_UNREACHABLE', 'PROOF_SERVER_TIMEOUT', 'PRIVATE_URL', 'BAD_URL', 'INSECURE_URL'].includes(code)
	);
}

/** A proof the server does not have (yet): worth asking again later. */
function isProofMissing(err) {
	const code = codeOf(err);
	if (code === 'ERR_COURIER_PROOF_NOT_FOUND' || code === 'ERR_TAPFREIGHTER_PROOF_NOT_FOUND') return true;
	return code === 'ERR_COURIER_HTTP' && [404, 500].includes(Number(err.status));
}

/**
 * A proof the library read and would not accept: it does not verify, or it
 * is not for the payment it was offered for. Not trouble reaching the chain
 * or a proof server, which says nothing about the proof.
 */
function isProofInvalid(err) {
	const code = codeOf(err);
	return (
		/^ERR_(PROOF|VM|COMMITMENT|ASSET|MSSMT|TLV|ENCODING|SCRIPT|TAPSCRIPT|CRYPTO)_/.test(code) ||
		['ERR_TAPFREIGHTER_INVALID_PROOF', 'ERR_TAPFREIGHTER_INVALID_ANCHOR', 'ERR_TAPFREIGHTER_NOT_OWNED'].includes(code)
	);
}

/** A sentence for a person from whatever was thrown, without the library's code prefix. */
function plainMessage(err, fallback = 'Something went wrong') {
	const raw = String((err && err.message) || '').replace(/^ERR_[A-Z0-9_]+:?\s*/, '').trim();
	const text = raw || fallback;
	return text.charAt(0).toUpperCase() + text.slice(1);
}

const FUNDING_CODES = new Set(['ERR_BEIGNET_FUNDING', 'ERR_BEIGNET_WALLET']);
const FEE_CODES = new Set(['ERR_BEIGNET_FEE', 'ERR_WALLET_FEE_ABOVE_LIMIT', 'ERR_TAPGARDEN_INVALID_FEE_RATE']);
const PARAM_MESSAGES = {
	ERR_TAPGARDEN_DUPLICATE_SEEDLING: 'This transaction already has an asset with that name.',
	ERR_TAPGARDEN_UNKNOWN_GROUP: 'This wallet cannot mint more of that asset: it did not create it.',
	ERR_TAPGARDEN_GROUP_TYPE_MISMATCH: 'More of an asset has to be the same kind as the asset itself.',
	ERR_TAPGARDEN_DEC_DISPLAY_MISMATCH: 'More of an asset has to use the same number of decimals as the asset itself.',
	ERR_TAPGARDEN_INVALID_ASSET_TYPE: 'An asset is either a normal asset or a collectible.',
	ERR_TAPGARDEN_EMPTY_BATCH: 'A mint needs at least one asset.',
	ERR_ASSET_INVALID_NAME: 'An asset needs a name of up to 64 bytes, with no line breaks.'
};

// What the library's Lightning service rejects with, as the dashboard's code,
// a sentence and a status. The caller adds what only it knows: how much a
// channel can send or receive, or a new price (lightning.js).
const LIGHTNING_REFUSALS = {
	ERR_BEIGNET_LN_NOT_READY: ['ASSETS_STARTING', 'Lightning is still starting. Try again in a moment.', 503],
	ERR_BEIGNET_LN_PEER_OFFLINE: ['PEER_UNREACHABLE', 'The peer is not connected, so nothing was done. Try again once it is back.', 502],
	ERR_BEIGNET_LN_PEER_UNSUPPORTED: ['PEER_NO_ASSET_CHANNELS', 'That peer does not open asset channels, so nothing was opened and nothing was spent.', 409],
	ERR_BEIGNET_LN_FUNDING_REJECTED: ['PEER_NO_ASSET_CHANNELS', 'The peer turned the channel down, so nothing was opened and nothing was spent.', 409],
	ERR_BEIGNET_LN_UNKNOWN_CHANNEL: ['CHANNEL_NOT_FOUND', 'This wallet has no asset channel with that id.', 404],
	ERR_BEIGNET_LN_NO_QUOTE: ['PEER_GAVE_NO_PRICE', "The channel's peer did not give a price, so nothing was done. Try again in a moment.", 502],
	ERR_BEIGNET_LN_QUOTE_EXPIRED: ['QUOTE_EXPIRED', 'That price has expired. Ask for a new one.', 410],
	ERR_BEIGNET_LN_PRICE_BOUND: ['QUOTE_CHANGED', 'The price moved before the payment was made, so nothing was paid.', 409],
	ERR_BEIGNET_LN_INSUFFICIENT_OUTBOUND: ['INSUFFICIENT_OUTBOUND', 'No asset channel of this wallet can send that much.', 409],
	ERR_BEIGNET_LN_INSUFFICIENT_INBOUND: ['INSUFFICIENT_INBOUND', 'No asset channel of this wallet can receive that much.', 409],
	ERR_BEIGNET_LN_BAD_INVOICE: ['BAD_INVOICE', 'That is not a Lightning invoice this wallet can read.', 400],
	ERR_BEIGNET_LN_INVOICE_EXPIRED: ['BAD_INVOICE', 'That invoice has expired. Ask whoever made it for a new one.', 400],
	ERR_BEIGNET_LN_AMOUNT_REQUIRED: ['AMOUNT_REQUIRED', 'This invoice names no amount, so one is needed.', 400],
	ERR_BEIGNET_LN_ALREADY_PAID: ['ALREADY_PAID', 'This wallet has already paid that invoice.', 409]
};

// The vbytes' worth of fee the library funds an anchor transaction around.
const WORKING_VBYTES = 2000;

/**
 * About what a wallet has to hold to build an asset transaction at
 * `feeRate` that pays `feeSats`: the library funds it around a working
 * amount and hands back what it did not use as change, so this is more than
 * the transaction costs. 0 when the rate is not known.
 */
const workingSats = (feeRate, feeSats = 0) => (feeRate > 0 ? Math.ceil(feeRate * WORKING_VBYTES) + (Number(feeSats) || 0) : 0);

/**
 * The refusal the dashboard should see for `err`, or `err` itself when it is
 * not one a caller can act on. `context` supplies what only the caller
 * knows: `spendable` sats, an estimate of what was `needed`, the `feeRate`
 * it was built at, and the `details` of a Lightning refusal.
 */
function mapError(err, context = {}) {
	if (isRefusal(err)) return err;
	const code = codeOf(err);
	if (!code) return err;
	if (code === 'ERR_TAPFREIGHTER_INSUFFICIENT_BALANCE') {
		return refusal('INSUFFICIENT_ASSET_BALANCE', 'This wallet does not hold that much of the asset on-chain.', 409);
	}
	if (LIGHTNING_REFUSALS[code]) {
		const [as, sentence, status] = LIGHTNING_REFUSALS[code];
		return refusal(as, sentence, status, context.details);
	}
	if (code === 'ERR_TAPFREIGHTER_RESERVATION_CONFLICT' || code === 'ERR_TAPFREIGHTER_INPUT_UNAVAILABLE') {
		return refusal('ASSET_IN_USE', 'Another send that has not confirmed yet is using this asset. Wait for it to confirm, then try again.', 409);
	}
	if (FUNDING_CODES.has(code)) {
		// The adapter's wallet code also carries whatever else the engine
		// refused, which is not always a shortage.
		const short = code === 'ERR_BEIGNET_FUNDING' || /insufficient|not enough|no spendable|balance|funds|utxo/i.test(String(err.message));
		if (!short) return refusal('WALLET_ERROR', `${plainMessage(err, 'The wallet could not build the transaction')}.`.replace(/\.\.$/, '.'), 502);
		const details = {};
		if (context.needed != null) details.needed = context.needed;
		// A wallet can hold what the transaction costs (`needed`) and still be
		// short of what it takes to build it: `onHandSats` says about how much
		// that is. Left out when the wallet holds that much too, because then
		// the working amount is not what stopped it.
		const working = workingSats(context.feeRate, context.feeSats);
		if (details.needed != null && working > details.needed && !(context.spendable >= working)) details.onHandSats = working;
		if (context.spendable != null) details.spendable = context.spendable;
		if (context.anchorSats != null) details.anchorSats = context.anchorSats;
		if (context.feeSats != null) details.feeSats = context.feeSats;
		return refusal('INSUFFICIENT_BTC', 'This wallet does not have enough bitcoin on-chain to pay the miner fee.', 409, details);
	}
	if (FEE_CODES.has(code)) {
		return refusal('FEE_TOO_HIGH', `${plainMessage(err, 'The fee is above the limit')}.`.replace(/\.\.$/, '.'), 400);
	}
	if (code === 'ERR_COURIER_ENDPOINT' || code === 'ERR_COURIER_UNSUPPORTED' || code === 'ERR_TAPFREIGHTER_UNSUPPORTED_COURIER') {
		return refusal(
			'UNKNOWN_COURIER',
			'This address names a proof server this wallet does not know how to reach, so the proof could not be delivered. Nothing was sent.',
			400
		);
	}
	if (code === 'ERR_ADDRESS_MISMATCHED_HRP') return refusal('WRONG_NETWORK', 'That address is for another network.', 400);
	if (code.startsWith('ERR_ADDRESS_') || code === 'ERR_ENCODING_BECH32') {
		return refusal('BAD_ADDRESS', 'That is not a Taproot Assets address this wallet can read.', 400);
	}
	if (['ERR_TAPGARDEN_INVALID_AMOUNT', 'ERR_TAPGARDEN_INVALID_COLLECTIBLE_AMOUNT'].includes(code)) {
		return refusal('BAD_AMOUNT', 'The amount must be a whole number of units above zero.', 400);
	}
	if (PARAM_MESSAGES[code]) return refusal('INVALID_PARAMS', PARAM_MESSAGES[code], 400);
	if (code === 'ERR_PROOF_INVALID_JSON' || code === 'ERR_PROOF_INVALID_META_REVEAL') {
		return refusal('INVALID_PARAMS', 'The metadata is not valid. JSON metadata has to be a JSON object.', 400);
	}
	if (code === 'TOR_UNAVAILABLE') return refusal('TOR_UNAVAILABLE', err.message, 503);
	return err;
}

module.exports = {
	refusal,
	isRefusal,
	codeOf,
	isFenced,
	isNotYet,
	isCourierTrouble,
	isProofMissing,
	isProofInvalid,
	plainMessage,
	mapError,
	workingSats,
	LIGHTNING_REFUSALS
};
