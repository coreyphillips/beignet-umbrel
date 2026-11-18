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
// The engine refused the fee settings it was given: said by the status, and
// by an open the library turns down for it.
const FEE_POLICY_REFUSED =
	"The wallet's node did not take the settings this app gives it for the miner fees of asset channels, so no new asset channel is opened. The channels there already are keep working. This is for whoever runs the wallet to put right, and the wallet's log says what the node refused.";
const LIGHTNING_REFUSALS = {
	ERR_BEIGNET_LN_UNSUPPORTED: ['LIGHTNING_UNAVAILABLE', 'This wallet has no Lightning for its assets, so it has no asset channels to use.', 409],
	ERR_BEIGNET_LN_NOT_READY: ['ASSETS_STARTING', 'Lightning is still starting. Try again in a moment.', 503],
	ERR_BEIGNET_LN_INVALID: ['INVALID_PARAMS', 'Lightning could not use that request as it is, so nothing was done.', 400],
	ERR_BEIGNET_LN_TIMEOUT: ['PEER_UNREACHABLE', 'The peer did not answer in time, so nothing was done. Try again in a moment.', 502],
	ERR_BEIGNET_LN_PEER_OFFLINE: ['PEER_UNREACHABLE', 'The peer is not connected, so nothing was done. Try again once it is back.', 502],
	ERR_BEIGNET_LN_PEER_UNSUPPORTED: ['PEER_NO_ASSET_CHANNELS', 'That peer does not open asset channels, so nothing was opened and nothing was spent.', 409],
	// This node's own no to an open: its engine and the peer agree on no way
	// to carry an asset payment, or it does not offer asset channels. Never
	// worded as the peer's. The engine's reason is added (modeUnavailable).
	ERR_BEIGNET_LN_MODE_UNAVAILABLE: ['CHANNEL_MODE_UNAVAILABLE', "This wallet's node cannot open an asset channel with that peer. Nothing was opened and nothing was spent.", 409],
	// An open on an engine that refused its fee policy, before anything is written.
	ERR_BEIGNET_LN_FEE_POLICY_REFUSED: ['FEE_POLICY_REFUSED', FEE_POLICY_REFUSED, 409],
	ERR_BEIGNET_LN_FUNDING_REJECTED: ['PEER_NO_ASSET_CHANNELS', 'The peer turned the channel down, so nothing was opened and nothing was spent.', 409],
	ERR_BEIGNET_LN_CANCELLED: ['CHANNEL_CANCELLED', 'This channel open was cancelled before anything was signed, so nothing was opened and nothing was spent.', 409],
	ERR_BEIGNET_LN_FEE_BOUND: [
		'FEE_TOO_HIGH',
		'Opening would pay more to miners than this wallet allows for an asset transaction, so nothing was opened and nothing was spent.',
		400
	],
	ERR_BEIGNET_LN_UNKNOWN_CHANNEL: ['CHANNEL_NOT_FOUND', 'This wallet has no asset channel with that id.', 404],
	ERR_BEIGNET_LN_NO_QUOTE: ['PEER_GAVE_NO_PRICE', "The channel's peer did not give a price, so nothing was done. Try again in a moment.", 502],
	ERR_BEIGNET_LN_QUOTE_EXPIRED: ['QUOTE_EXPIRED', 'That price has expired. Ask for a new one.', 410],
	ERR_BEIGNET_LN_PRICE_BOUND: ['QUOTE_CHANGED', 'The price moved before the payment was made, so nothing was paid.', 409],
	// The peer names the rate, and one unit at it is worth less than an
	// invoice can say: the invoice would come to fewer units than asked for.
	ERR_BEIGNET_LN_RATE_TOO_COARSE: ['RATE_TOO_COARSE', "The channel's peer priced this asset too coarsely for a Lightning invoice to name that amount, so no invoice was made.", 409],
	// A channel is funded with units of one asset ID, and never with a
	// collectible. The host plans an open that way (planOpen), so this is
	// what the library says of a request the host should not have made.
	ERR_BEIGNET_LN_CHANNEL_ASSETS: ['CHANNEL_ASSETS', 'A channel holds units of one issuance of an asset, and never a collectible, so nothing was opened and nothing was spent.', 400],
	// A peer's channel that was turned down. It reaches the host through
	// the library's onError, so this sentence is one for the log.
	ERR_BEIGNET_LN_GROUP_PROOF: [
		'GROUP_PROOF',
		"A channel a peer offered was turned down: the group of its asset could not be shown to be real, because the issuance that created the group could not be fetched from this wallet's proof server.",
		409
	],
	// The node is on its way down. Nothing was recorded or sent.
	ERR_BEIGNET_LN_SERVICE_DRAINING: [
		'SERVICE_DRAINING',
		'This wallet is shutting down or in maintenance and takes no new payments, so nothing was paid. Pay again once it is running.',
		409
	],
	// The wallet's own limits, before anything was recorded or sent. The
	// limit is named when the engine's refusal carries it (mapLightning).
	ERR_BEIGNET_LN_SPENDING_LIMIT: ['SPENDING_LIMIT', "This wallet's own spending limit refused the payment, so nothing was paid.", 409],
	// The engine sends an asset payment in one part, and this one would
	// have needed several. Nothing was recorded or sent.
	ERR_BEIGNET_LN_PAYMENT_UNSUPPORTED: ['PAYMENT_UNSUPPORTED', 'This payment would have to go out in several parts, and an asset payment goes out in one, so nothing was paid.', 409],
	// The wallet has not taken in what became of earlier payments on the
	// channel. Not the payer's doing: it is for a restart, or for a look.
	ERR_BEIGNET_LN_OUTCOMES_UNDELIVERED: [
		'OUTCOMES_UNDELIVERED',
		'This wallet has not yet taken in the results of earlier payments on that channel, so nothing was paid. Nothing is wrong with this payment. Restart the wallet, and if this is said again afterwards, its log says why.',
		409
	],
	// An asset channel carries at most a few payments at once that have not
	// ended (8 unless set otherwise), so that every one of them can still be
	// claimed on chain in time. The library refuses the next before anything
	// is sent or recorded.
	ERR_BEIGNET_LN_HTLC_LIMIT: [
		'CHANNEL_PAYMENTS_FULL',
		'The asset channel this would be paid through already carries as many payments that have not ended as it can hold at once, so nothing was paid. Pay again once one of them has ended.',
		409
	],
	ERR_BEIGNET_LN_INSUFFICIENT_OUTBOUND: ['INSUFFICIENT_OUTBOUND', 'No asset channel of this wallet can send that much.', 409],
	ERR_BEIGNET_LN_INSUFFICIENT_INBOUND: ['INSUFFICIENT_INBOUND', 'No asset channel of this wallet can receive that much.', 409],
	// Every payment over an asset channel moves a little of the channel's
	// bitcoin from the payer's side to the payee's. A side that has paid
	// many times without being paid runs out of it while it still has units.
	// The library refuses before anything is sent or made.
	ERR_BEIGNET_LN_CARRIER_UNFUNDED: [
		'CHANNEL_BITCOIN_SHORT',
		"Your side of the asset channel has too little bitcoin left to carry a payment, so nothing was paid. Each payment moves a little of the channel's bitcoin to the one who is paid. Once you have been paid through the channel, you can pay through it again.",
		409
	],
	ERR_BEIGNET_LN_PEER_CARRIER_UNFUNDED: [
		'PEER_CHANNEL_BITCOIN_SHORT',
		"The peer's side of the asset channel has too little bitcoin left to carry a payment to you, so no invoice was made. Each payment moves a little of the channel's bitcoin to the one who is paid. Once you have paid the peer through the channel, it can pay you again.",
		409
	],
	ERR_BEIGNET_LN_BAD_INVOICE: ['BAD_INVOICE', 'That is not a Lightning invoice this wallet can read.', 400],
	ERR_BEIGNET_LN_INVOICE_EXPIRED: ['BAD_INVOICE', 'That invoice has expired. Ask whoever made it for a new one.', 400],
	ERR_BEIGNET_LN_AMOUNT_REQUIRED: ['AMOUNT_REQUIRED', 'This invoice names no amount, so one is needed.', 400],
	// The library says this of an invoice it has paid and of one it is paying.
	ERR_BEIGNET_LN_ALREADY_PAID: ['ALREADY_PAID', 'This wallet has already paid that invoice, or is paying it now.', 409],
	// The engine did not take the payment, or the invoice could not be worked with.
	ERR_BEIGNET_LN_PAYMENT: ['PAYMENT_NOT_SENT', 'The payment could not be made, so nothing was paid.', 502]
	// ERR_BEIGNET_LN_RECORDS_UNCONFIRMED has no entry, and must not read as a
	// refusal: it comes after the engine took a payment, which is then
	// followed from the library's record of it.
	// ERR_BEIGNET_LN_CHANNEL, _FUNDING and _RECOVERY have no entry: they carry
	// the library's account of what went wrong inside, which is for the log.
	// The caller answers with a sentence of its own.
};

// Which rejections of a payment mean that nothing left the wallet is the
// library's to say: it exports the list (adapter.js, item 22), and the host
// keeps no copy of it.

// Why the library's record says a payment failed. It writes two texts of its
// own, and otherwise hands on whatever the engine gave as its reason. Only
// its own are known here: any other text is worded generally, and goes to
// the log and not to whoever asked.
const PAYMENT_FAILURES = Object.freeze({
	'the payment never left this wallet': 'This payment was never sent, so nothing was paid.',
	// Said when the engine gave no reason at all.
	'the payment failed': 'The payment did not go through, so nothing was paid.'
});
const PAYMENT_FAILED = 'The payment did not go through, so nothing was paid.';

// A try whose HTLC never entered the channel, as the library marks it (`neverSent`).
const PAYMENT_NEVER_SENT = 'This payment never left the wallet, so nothing was paid. The invoice can be paid again.';

/** A failed payment's reason as a sentence, and whether the record's text for it was one this host knows. */
function paymentFailure(text, { neverSent = false } = {}) {
	if (neverSent) return { known: true, message: PAYMENT_NEVER_SENT };
	const known = typeof text === 'string' && Object.prototype.hasOwnProperty.call(PAYMENT_FAILURES, text);
	return { known, message: known ? PAYMENT_FAILURES[text] : PAYMENT_FAILED };
}

// What mapError words with the library's own text.
const WORDED_BY_THE_LIBRARY = new Set(['WALLET_ERROR', 'TOR_UNAVAILABLE']);

// What the engine itself refuses with, where it reaches the host inside an
// error of the library's: as the error's own code, as that of a cause, or
// named in its text. This is the one place that knows the engine's names,
// so one the engine settles on later is changed here and nowhere else.
const ENGINE_REFUSALS = {
	FEE_BUDGET_EXHAUSTED: [
		'FEE_BUDGET_EXHAUSTED',
		'The budget this app sets for the miner fees of asset channels is used up, so nothing was done. Nothing was lost: the channels and what is in them are as they were.',
		409
	],
	ASSET_PAYMENT_REFUSED: ['SPENDING_LIMIT', "This wallet's own spending limit refused the payment, so nothing was paid.", 409]
};

// Why the engine's gate refused an asset payment: the `reason` its refusal
// carries, which the library hands on in the error's details. A refusal
// that names none, or one not listed here, is the spending limit's.
const PAYMENT_REFUSED_BECAUSE = {
	SPENDING_LIMIT_EXCEEDED: ENGINE_REFUSALS.ASSET_PAYMENT_REFUSED,
	SERVICE_DRAINING: LIGHTNING_REFUSALS.ERR_BEIGNET_LN_SERVICE_DRAINING
};

/**
 * ERR_BEIGNET_LN_FUNDING_INPUTS in the host's words. The bitcoin of an
 * asset channel, and of taking its funding back, comes only from coins on
 * native SegWit addresses. When those do not hold enough the library says
 * so in sats (`details`, each a bigint): what is on such coins, about what
 * is needed, and what sits on coins of other address types.
 */
function fundingInputs(err) {
	const sats = (value) => {
		try {
			const n = BigInt(value);
			return n >= 0n ? n : null;
		} catch (_) {
			return null;
		}
	};
	let said = null;
	for (const e of causesOf(err)) {
		const d = e.details || e.data;
		if (d && sats(d.eligibleSatoshis) !== null && sats(d.neededSatoshis) !== null) {
			said = { eligible: sats(d.eligibleSatoshis), needed: sats(d.neededSatoshis), other: sats(d.otherSatoshis) || 0n };
			break;
		}
	}
	if (!said) {
		return refusal(
			'FUNDING_INPUTS',
			'The bitcoin for an asset channel has to come from native SegWit addresses of this wallet, and the transaction could not be made from those alone, so nothing was done and nothing was spent.',
			409
		);
	}
	const elsewhere = said.other > 0n ? ` Another ${said.other} sats are on addresses of other types, which cannot be used for it.` : '';
	return refusal(
		'FUNDING_INPUTS',
		`The bitcoin for an asset channel has to be on native SegWit addresses. This wallet has ${said.eligible} sats on those, and this needs about ${said.needed}.${elsewhere} Nothing was done and nothing was spent.`,
		409,
		{ eligibleSats: said.eligible.toString(), neededSats: said.needed.toString(), otherSats: said.other.toString() }
	);
}

/** Every error in the chain of causes of `err`, itself first. Never more than a few. */
function causesOf(err) {
	const out = [];
	for (let e = err, n = 0; e && typeof e === 'object' && n < 6; e = e.cause, n += 1) out.push(e);
	return out;
}

/** The engine's own code inside `err`, when it is one of ENGINE_REFUSALS. '' otherwise. */
function engineCodeOf(err) {
	const chain = causesOf(err);
	for (const e of chain) if (Object.prototype.hasOwnProperty.call(ENGINE_REFUSALS, codeOf(e))) return codeOf(e);
	for (const e of chain) {
		const text = String(e.message || '');
		for (const code of Object.keys(ENGINE_REFUSALS)) if (new RegExp(`\\b${code}\\b`).test(text)) return code;
	}
	return '';
}

/** Why the engine's gate refused a payment, when the refusal or one of its causes says so in a word this host knows. '' otherwise. */
function refusalReasonOf(err) {
	for (const e of causesOf(err)) {
		for (const said of [e.reason, e.details && e.details.reason, e.data && e.data.reason]) {
			if (typeof said === 'string' && Object.prototype.hasOwnProperty.call(PAYMENT_REFUSED_BECAUSE, said)) return said;
		}
	}
	return '';
}

/** The name of the spending limit that refused a payment, when the refusal carries one in a form that can be shown. */
function spendingLimitOf(err) {
	for (const e of causesOf(err)) {
		for (const said of [e.limit, e.details && e.details.limit, e.data && e.data.limit]) {
			if (typeof said === 'string' && /^[A-Za-z][A-Za-z0-9 _.-]{0,40}$/.test(said.trim())) return said.trim();
		}
	}
	return null;
}

/** What an error of the library's, or a cause of it, carries under `name` in its details. */
function detailOf(err, name) {
	for (const e of causesOf(err)) {
		const d = e.details || e.data;
		if (d && d[name] !== undefined && d[name] !== null) return d[name];
	}
	return undefined;
}

/**
 * ERR_BEIGNET_LN_MODE_UNAVAILABLE in the host's words: this wallet's own
 * node cannot open an asset channel with the peer, and why, where the
 * engine said why. The reason is the engine's, on one line and no longer
 * than a reason needs to be.
 */
function modeUnavailable(reason) {
	const [code, message, status] = LIGHTNING_REFUSALS.ERR_BEIGNET_LN_MODE_UNAVAILABLE;
	const why =
		typeof reason === 'string'
			? reason
					.replace(/[\u0000-\u001f\u007f]+/g, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 300)
					.replace(/[.\s]+$/, '')
			: '';
	if (!why) return refusal(code, message, status);
	return refusal(code, `This wallet's node cannot open an asset channel with that peer: ${why}. Nothing was opened and nothing was spent.`, status, { reason: why });
}

/**
 * As mapError, for what a call into the Lightning service threw: a refusal
 * in the host's own words, or null when the host has none for it. What the
 * library wrote is never part of it. The caller logs that, and answers with
 * a sentence of its own.
 */
// A peer keeps a handful of unused prices for a wallet at once (eight), and
// refuses one more until some have run out, which they do within minutes.
const TOO_MANY_REQUESTS = 'ERR_LIGHTNING_TOO_MANY_REQUESTS';
const TOO_MANY_QUOTES = 'The peer is already keeping as many unused prices for this wallet as it keeps at once, so it gave no new one. Try again in a few minutes.';

function mapLightning(err, context = {}) {
	if (isRefusal(err)) return err;
	if (causesOf(err).some((e) => codeOf(e) === TOO_MANY_REQUESTS || new RegExp(`\\b${TOO_MANY_REQUESTS}\\b`).test(String((e && e.message) || '')))) {
		return refusal('TOO_MANY_QUOTES', TOO_MANY_QUOTES, 429);
	}
	const engine = engineCodeOf(err);
	if (codeOf(err) === 'ERR_BEIGNET_LN_MODE_UNAVAILABLE') return modeUnavailable(detailOf(err, 'reason'));
	if (codeOf(err) === 'ERR_BEIGNET_LN_HTLC_LIMIT') {
		const [code, , status] = LIGHTNING_REFUSALS.ERR_BEIGNET_LN_HTLC_LIMIT;
		const max = Number(detailOf(err, 'maxHtlcs'));
		const pending = Number(detailOf(err, 'pendingHtlcs'));
		const named = Number.isInteger(max) && max > 0;
		const message = named
			? `The asset channel this would be paid through already carries ${max} ${max === 1 ? 'payment that has' : 'payments that have'} not ended, the most it holds at once, so nothing was paid. Pay again once one of them has ended.`
			: LIGHTNING_REFUSALS.ERR_BEIGNET_LN_HTLC_LIMIT[1];
		const details = { ...(named ? { maxHtlcs: max } : {}), ...(Number.isInteger(pending) && pending >= 0 ? { pendingHtlcs: pending } : {}) };
		return refusal(code, message, status, Object.keys(details).length ? details : undefined);
	}
	if (codeOf(err) === 'ERR_BEIGNET_LN_OUTCOMES_UNDELIVERED') {
		const [code, message, status] = LIGHTNING_REFUSALS.ERR_BEIGNET_LN_OUTCOMES_UNDELIVERED;
		const count = Number(detailOf(err, 'undeliveredOutcomes'));
		return refusal(code, message, status, Number.isInteger(count) && count > 0 ? { undeliveredOutcomes: count } : undefined);
	}
	if (codeOf(err) === 'ERR_BEIGNET_LN_FUNDING_INPUTS') return fundingInputs(err);
	if (engine === 'ASSET_PAYMENT_REFUSED' || codeOf(err) === 'ERR_BEIGNET_LN_SPENDING_LIMIT') {
		// Not a limit at all: the wallet is on its way down, and takes nothing new.
		if (refusalReasonOf(err) === 'SERVICE_DRAINING') {
			const [code, message, status] = PAYMENT_REFUSED_BECAUSE.SERVICE_DRAINING;
			return refusal(code, message, status);
		}
		const limit = spendingLimitOf(err);
		const [code, , status] = ENGINE_REFUSALS.ASSET_PAYMENT_REFUSED;
		return refusal(code, `This wallet's own spending limit${limit ? ` (${limit})` : ''} refused the payment, so nothing was paid.`, status, limit ? { limit } : undefined);
	}
	if (engine) {
		const [code, message, status] = ENGINE_REFUSALS[engine];
		return refusal(code, message, status);
	}
	if (FEE_CODES.has(codeOf(err))) {
		return refusal('FEE_TOO_HIGH', 'The miner fee would be above what this wallet allows for an asset transaction, so nothing was done.', 400);
	}
	const mapped = mapError(err, context);
	return isRefusal(mapped) && !WORDED_BY_THE_LIBRARY.has(mapped.extensionCode) ? mapped : null;
}

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
	mapLightning,
	workingSats,
	LIGHTNING_REFUSALS,
	ENGINE_REFUSALS,
	PAYMENT_REFUSED_BECAUSE,
	engineCodeOf,
	PAYMENT_FAILURES,
	paymentFailure,
	modeUnavailable,
	FEE_POLICY_REFUSED
};
