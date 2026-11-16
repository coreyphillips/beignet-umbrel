'use strict';

/**
 * The library's and the wallet's errors, said in the dashboard's codes.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/errors.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
	refusal,
	isRefusal,
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
	engineCodeOf,
	PAYMENT_FAILURES,
	paymentFailure
} = require('./errors');

const coded = (code, message = 'the detail of what went wrong', extra = {}) => Object.assign(new Error(`${code}: ${message}`), { code, ...extra });

test('a refusal carries the code, the status and the details the engine relays', () => {
	const err = refusal('FEE_TOO_HIGH', 'The fee is too high.', 400, { feeSats: 9 });
	assert.ok(err instanceof Error);
	assert.equal(err.extensionCode, 'FEE_TOO_HIGH');
	assert.equal(err.status, 400);
	assert.deepEqual(err.details, { feeSats: 9 });
	assert.equal(refusal('X', 'y').status, 400);
	assert.equal('details' in refusal('X', 'y'), false);
	assert.equal(isRefusal(err), true);
	assert.equal(isRefusal(new Error('plain')), false);
	assert.equal(isRefusal(null), false);
});

test('a refusal and an error with no code pass through untouched', () => {
	const mine = refusal('BAD_AMOUNT', 'No.');
	assert.equal(mapError(mine), mine);
	const plain = new Error('something else');
	assert.equal(mapError(plain), plain);
	const unknown = coded('ERR_SOMETHING_NEW');
	assert.equal(mapError(unknown), unknown);
});

test('each library error becomes the code the dashboard knows', () => {
	const table = [
		['ERR_TAPFREIGHTER_INSUFFICIENT_BALANCE', 'INSUFFICIENT_ASSET_BALANCE', 409],
		['ERR_TAPFREIGHTER_RESERVATION_CONFLICT', 'ASSET_IN_USE', 409],
		['ERR_TAPFREIGHTER_INPUT_UNAVAILABLE', 'ASSET_IN_USE', 409],
		['ERR_BEIGNET_FUNDING', 'INSUFFICIENT_BTC', 409],
		['ERR_BEIGNET_FEE', 'FEE_TOO_HIGH', 400],
		['ERR_WALLET_FEE_ABOVE_LIMIT', 'FEE_TOO_HIGH', 400],
		['ERR_TAPGARDEN_INVALID_FEE_RATE', 'FEE_TOO_HIGH', 400],
		['ERR_COURIER_ENDPOINT', 'UNKNOWN_COURIER', 400],
		['ERR_COURIER_UNSUPPORTED', 'UNKNOWN_COURIER', 400],
		['ERR_TAPFREIGHTER_UNSUPPORTED_COURIER', 'UNKNOWN_COURIER', 400],
		['ERR_ADDRESS_MISMATCHED_HRP', 'WRONG_NETWORK', 400],
		['ERR_ADDRESS_INVALID_BECH32M', 'BAD_ADDRESS', 400],
		['ERR_ADDRESS_UNKNOWN_VERSION', 'BAD_ADDRESS', 400],
		['ERR_ENCODING_BECH32', 'BAD_ADDRESS', 400],
		['ERR_TAPGARDEN_INVALID_AMOUNT', 'BAD_AMOUNT', 400],
		['ERR_TAPGARDEN_INVALID_COLLECTIBLE_AMOUNT', 'BAD_AMOUNT', 400],
		['ERR_TAPGARDEN_DUPLICATE_SEEDLING', 'INVALID_PARAMS', 400],
		['ERR_TAPGARDEN_UNKNOWN_GROUP', 'INVALID_PARAMS', 400],
		['ERR_TAPGARDEN_GROUP_TYPE_MISMATCH', 'INVALID_PARAMS', 400],
		['ERR_TAPGARDEN_DEC_DISPLAY_MISMATCH', 'INVALID_PARAMS', 400],
		['ERR_TAPGARDEN_EMPTY_BATCH', 'INVALID_PARAMS', 400],
		['ERR_ASSET_INVALID_NAME', 'INVALID_PARAMS', 400],
		['ERR_PROOF_INVALID_JSON', 'INVALID_PARAMS', 400],
		['ERR_PROOF_INVALID_META_REVEAL', 'INVALID_PARAMS', 400],
		['TOR_UNAVAILABLE', 'TOR_UNAVAILABLE', 503]
	];
	for (const [code, expected, status] of table) {
		const mapped = mapError(coded(code));
		assert.equal(mapped.extensionCode, expected, code);
		assert.equal(mapped.status, status, code);
		assert.ok(mapped.message.length > 10, code);
		assert.equal(mapped.message.includes(String.fromCharCode(0x2014)), false, code);
		assert.match(mapped.message, /^[A-Z]/, code);
	}
});

test('each refusal of the Lightning service becomes the code the dashboard words', () => {
	const table = [
		['ERR_BEIGNET_LN_UNSUPPORTED', 'LIGHTNING_UNAVAILABLE', 409],
		['ERR_BEIGNET_LN_NOT_READY', 'ASSETS_STARTING', 503],
		['ERR_BEIGNET_LN_INVALID', 'INVALID_PARAMS', 400],
		['ERR_BEIGNET_LN_TIMEOUT', 'PEER_UNREACHABLE', 502],
		['ERR_BEIGNET_LN_PEER_OFFLINE', 'PEER_UNREACHABLE', 502],
		['ERR_BEIGNET_LN_PEER_UNSUPPORTED', 'PEER_NO_ASSET_CHANNELS', 409],
		['ERR_BEIGNET_LN_FUNDING_REJECTED', 'PEER_NO_ASSET_CHANNELS', 409],
		['ERR_BEIGNET_LN_CANCELLED', 'CHANNEL_CANCELLED', 409],
		['ERR_BEIGNET_LN_FEE_BOUND', 'FEE_TOO_HIGH', 400],
		['ERR_BEIGNET_LN_UNKNOWN_CHANNEL', 'CHANNEL_NOT_FOUND', 404],
		['ERR_BEIGNET_LN_NO_QUOTE', 'PEER_GAVE_NO_PRICE', 502],
		['ERR_BEIGNET_LN_QUOTE_EXPIRED', 'QUOTE_EXPIRED', 410],
		['ERR_BEIGNET_LN_PRICE_BOUND', 'QUOTE_CHANGED', 409],
		['ERR_BEIGNET_LN_RATE_TOO_COARSE', 'RATE_TOO_COARSE', 409],
		['ERR_BEIGNET_LN_CHANNEL_ASSETS', 'CHANNEL_ASSETS', 400],
		['ERR_BEIGNET_LN_GROUP_PROOF', 'GROUP_PROOF', 409],
		['ERR_BEIGNET_LN_SERVICE_DRAINING', 'SERVICE_DRAINING', 409],
		['ERR_BEIGNET_LN_SPENDING_LIMIT', 'SPENDING_LIMIT', 409],
		['ERR_BEIGNET_LN_INSUFFICIENT_OUTBOUND', 'INSUFFICIENT_OUTBOUND', 409],
		['ERR_BEIGNET_LN_INSUFFICIENT_INBOUND', 'INSUFFICIENT_INBOUND', 409],
		['ERR_BEIGNET_LN_BAD_INVOICE', 'BAD_INVOICE', 400],
		['ERR_BEIGNET_LN_INVOICE_EXPIRED', 'BAD_INVOICE', 400],
		['ERR_BEIGNET_LN_AMOUNT_REQUIRED', 'AMOUNT_REQUIRED', 400],
		['ERR_BEIGNET_LN_ALREADY_PAID', 'ALREADY_PAID', 409],
		['ERR_BEIGNET_LN_PAYMENT', 'PAYMENT_NOT_SENT', 502]
	];
	assert.deepEqual(Object.keys(LIGHTNING_REFUSALS).sort(), table.map((row) => row[0]).sort());
	for (const [code, as, status] of table) {
		const mapped = mapError(coded(code));
		assert.deepEqual([mapped.extensionCode, mapped.status], [as, status], code);
		// A sentence of the host's own, never the library's text or its code.
		assert.match(mapped.message, /^[A-Z].*\.$/, code);
		assert.equal(mapped.message.includes('ERR_'), false, code);
		assert.equal(mapped.message.includes('the detail of what went wrong'), false, code);
		assert.equal(mapped.message.includes(String.fromCharCode(0x2014)), false, code);
		assert.equal('details' in mapped, false, code);
	}
	// What only the caller knows travels with the refusal.
	const short = mapError(coded('ERR_BEIGNET_LN_INSUFFICIENT_OUTBOUND'), { details: { sendable: '40' } });
	assert.deepEqual(short.details, { sendable: '40' });
	// The codes that carry the library's own account of what went wrong inside
	// have no words here: the caller logs them and answers in a sentence of its own.
	for (const code of ['ERR_BEIGNET_LN_CHANNEL', 'ERR_BEIGNET_LN_FUNDING', 'ERR_BEIGNET_LN_RECOVERY', 'ERR_BEIGNET_LN_SOMETHING_NEW']) {
		assert.equal(mapLightning(coded(code, 'state 7 of flow 03aa is not one this can leave')), null, code);
	}
	// A send the engine took and did not confirm is no refusal: it has no words, and is followed.
	assert.equal(mapLightning(coded('ERR_BEIGNET_LN_RECORDS_UNCONFIRMED', 'the engine did not confirm')), null);
	assert.equal('ERR_BEIGNET_LN_RECORDS_UNCONFIRMED' in LIGHTNING_REFUSALS, false);
});

test('what the engine itself refuses is worded in one place, wherever in the error it is named', () => {
	const within = (code, cause) => Object.assign(coded(code, 'the engine would not'), { cause });
	// The fee pool of a channel's fixed outputs: as the error's own code, as
	// its cause, as the cause of a cause, and named in its text alone.
	const spent = [
		coded('FEE_BUDGET_EXHAUSTED', 'budget spent'),
		within('ERR_BEIGNET_LN_CHANNEL', coded('FEE_BUDGET_EXHAUSTED', 'budget spent')),
		within('ERR_BEIGNET_LN_FUNDING', within('ERR_WHATEVER', coded('FEE_BUDGET_EXHAUSTED', 'budget spent'))),
		coded('ERR_BEIGNET_LN_CHANNEL', 'the engine refused the fee action: FEE_BUDGET_EXHAUSTED (pool 0 of 40000)')
	];
	for (const err of spent) {
		const mapped = mapLightning(err);
		assert.deepEqual([mapped.extensionCode, mapped.status], ['FEE_BUDGET_EXHAUSTED', 409]);
		assert.match(mapped.message, /budget this app sets for the miner fees of asset channels is used up/);
		assert.match(mapped.message, /Nothing was lost/);
		assert.equal(mapped.message.includes('pool 0'), false);
		assert.equal(engineCodeOf(err), 'FEE_BUDGET_EXHAUSTED');
	}
	// A name that only contains the code is not it, and an error with no cause has none.
	assert.equal(engineCodeOf(coded('ERR_BEIGNET_LN_CHANNEL', 'NOT_FEE_BUDGET_EXHAUSTED_AT_ALL')), '');
	assert.equal(engineCodeOf(null), '');
	// A chain of causes that never ends is read a few deep and no further.
	const loop = coded('ERR_BEIGNET_LN_CHANNEL', 'round');
	loop.cause = loop;
	assert.equal(engineCodeOf(loop), '');

	// The wallet's own spending limits: the library's code, with the engine's refusal as its cause.
	const limited = mapLightning(within('ERR_BEIGNET_LN_SPENDING_LIMIT', coded('ASSET_PAYMENT_REFUSED', 'over the daily limit of 100000 sats')));
	assert.deepEqual([limited.extensionCode, limited.status], ['SPENDING_LIMIT', 409]);
	assert.equal(limited.message, "This wallet's own spending limit refused the payment, so nothing was paid.");
	assert.equal('details' in limited, false);
	// The limit is named when the refusal carries its name, and only a name is shown.
	const named = mapLightning(within('ERR_BEIGNET_LN_SPENDING_LIMIT', Object.assign(coded('ASSET_PAYMENT_REFUSED', 'no'), { limit: 'daily' })));
	assert.equal(named.message, "This wallet's own spending limit (daily) refused the payment, so nothing was paid.");
	assert.deepEqual(named.details, { limit: 'daily' });
	const odd = mapLightning(within('ERR_BEIGNET_LN_SPENDING_LIMIT', Object.assign(coded('ASSET_PAYMENT_REFUSED', 'no'), { limit: '<b>x</b> '.repeat(30) })));
	assert.equal(odd.message, "This wallet's own spending limit refused the payment, so nothing was paid.");
	// The engine's code alone says the same.
	assert.equal(mapLightning(coded('ASSET_PAYMENT_REFUSED', 'no')).extensionCode, 'SPENDING_LIMIT');
	// The refusal says why, in the library's details or on the engine's own error. A limit is the limit's sentence.
	const over = mapLightning(Object.assign(within('ERR_BEIGNET_LN_SPENDING_LIMIT', coded('ASSET_PAYMENT_REFUSED', 'no')), { details: { reason: 'SPENDING_LIMIT_EXCEEDED' } }));
	assert.deepEqual([over.extensionCode, over.message], ['SPENDING_LIMIT', "This wallet's own spending limit refused the payment, so nothing was paid."]);
	// A wallet on its way down is no limit, and is said on its own.
	const draining = 'This wallet is shutting down or in maintenance and takes no new payments, so nothing was paid. Pay again once it is running.';
	for (const err of [
		Object.assign(within('ERR_BEIGNET_LN_SPENDING_LIMIT', coded('ASSET_PAYMENT_REFUSED', 'no')), { details: { reason: 'SERVICE_DRAINING' } }),
		within('ERR_BEIGNET_LN_SPENDING_LIMIT', Object.assign(coded('ASSET_PAYMENT_REFUSED', 'draining'), { reason: 'SERVICE_DRAINING' })),
		Object.assign(coded('ASSET_PAYMENT_REFUSED', 'no'), { details: { reason: 'SERVICE_DRAINING', limit: 'daily' } })
	]) {
		const said = mapLightning(err);
		assert.deepEqual([said.extensionCode, said.status, said.message], ['SERVICE_DRAINING', 409, draining]);
		assert.equal('details' in said, false);
	}
	// A reason this host has no words for is the limit's, as before.
	assert.equal(mapLightning(Object.assign(coded('ASSET_PAYMENT_REFUSED', 'no'), { reason: 'SOMETHING_NEW' })).extensionCode, 'SPENDING_LIMIT');
	// Every sentence here is the host's own.
	for (const [code, message, status] of Object.values(ENGINE_REFUSALS)) {
		assert.match(code, /^[A-Z_]+$/);
		assert.match(message, /^[A-Z].*\.$/);
		assert.equal(message.includes(String.fromCharCode(0x2014)), false);
		assert.equal(status, 409);
	}
});

test('a wallet that is short of bitcoin says what was needed', () => {
	const mapped = mapError(coded('ERR_BEIGNET_FUNDING', 'no spendable coins'), { needed: 1306, spendable: 200, anchorSats: 1000, feeSats: 306 });
	assert.equal(mapped.extensionCode, 'INSUFFICIENT_BTC');
	assert.deepEqual(mapped.details, { needed: 1306, spendable: 200, anchorSats: 1000, feeSats: 306 });
	assert.deepEqual(mapError(coded('ERR_BEIGNET_FUNDING')).details, {});
});

test('a wallet that holds the cost but not what the library works with is told both figures', () => {
	// 3,300 sats on hand, a mint that costs 1,308: the library needs 4,000 and the fee to build it.
	const mapped = mapError(coded('ERR_BEIGNET_FUNDING', 'insufficient funds'), { needed: 1308, spendable: 3300, anchorSats: 1000, feeSats: 308, feeRate: 2 });
	assert.deepEqual(mapped.details, { needed: 1308, onHandSats: 4308, spendable: 3300, anchorSats: 1000, feeSats: 308 });
	// A cost above the working amount is all there is to say.
	const big = mapError(coded('ERR_BEIGNET_FUNDING', 'insufficient funds'), { needed: 20000, spendable: 100, anchorSats: 17000, feeSats: 3000, feeRate: 5 });
	assert.deepEqual(big.details, { needed: 20000, spendable: 100, anchorSats: 17000, feeSats: 3000 });
	// No rate, no guess.
	assert.deepEqual(mapError(coded('ERR_BEIGNET_FUNDING'), { needed: 1308, spendable: 3300 }).details, { needed: 1308, spendable: 3300 });
	// A wallet that holds the working amount too was stopped by something else.
	const held = mapError(coded('ERR_BEIGNET_FUNDING', 'wallet has no spendable fee input'), { needed: 1308, spendable: 500000, anchorSats: 1000, feeSats: 308, feeRate: 2 });
	assert.deepEqual(held.details, { needed: 1308, spendable: 500000, anchorSats: 1000, feeSats: 308 });
	assert.deepEqual([workingSats(2, 308), workingSats(50, 7700), workingSats(0, 308), workingSats(undefined), workingSats(1.5)], [4308, 107700, 0, 0, 3000]);
});

test('the wallet refusing for another reason is not called a shortage', () => {
	const short = mapError(coded('ERR_BEIGNET_WALLET', 'Insufficient funds for this transaction'));
	assert.equal(short.extensionCode, 'INSUFFICIENT_BTC');
	const other = mapError(coded('ERR_BEIGNET_WALLET', 'electrum is not connected'));
	assert.equal(other.extensionCode, 'WALLET_ERROR');
	assert.equal(other.status, 502);
	assert.equal(other.message, 'Electrum is not connected.');
});

test('a closed database is known for what it is: the node being rebuilt', () => {
	assert.equal(isFenced(new Error('The database connection is not open')), true);
	assert.equal(isFenced(new TypeError('the database connection is not open')), true);
	assert.equal(isFenced(new Error('disk full')), false);
	assert.equal(isFenced(null), false);
});

test('a chain wait that ran out is "not yet", not a failure', () => {
	assert.equal(isNotYet(coded('ERR_BEIGNET_TIMEOUT')), true);
	assert.equal(isNotYet(coded('ERR_TAPGARDEN_NOT_BURIED')), true);
	assert.equal(isNotYet(coded('ERR_BEIGNET_WALLET')), false);
	assert.equal(isNotYet(new Error('timeout')), false);
});

test('trouble reaching a proof server is told apart from everything else', () => {
	for (const code of ['ERR_COURIER_HTTP', 'ERR_COURIER_TIMEOUT', 'ERR_MAILBOX_CLOSED', 'ERR_ECIES_DECRYPT', 'TOR_UNAVAILABLE', 'PROOF_SERVER_UNREACHABLE', 'PROOF_SERVER_TIMEOUT', 'PRIVATE_URL', 'BAD_URL', 'INSECURE_URL']) {
		assert.equal(isCourierTrouble(coded(code)), true, code);
	}
	assert.equal(isCourierTrouble(coded('ERR_BEIGNET_WALLET')), false);
	assert.equal(isCourierTrouble(new Error('no code')), false);
});

test('a proof the server does not have yet', () => {
	assert.equal(isProofMissing(coded('ERR_COURIER_PROOF_NOT_FOUND')), true);
	assert.equal(isProofMissing(coded('ERR_TAPFREIGHTER_PROOF_NOT_FOUND')), true);
	assert.equal(isProofMissing(coded('ERR_COURIER_HTTP', 'x', { status: 404 })), true);
	assert.equal(isProofMissing(coded('ERR_COURIER_HTTP', 'x', { status: 500 })), true);
	assert.equal(isProofMissing(coded('ERR_COURIER_HTTP', 'x', { status: 503 })), false);
	assert.equal(isProofMissing(coded('ERR_COURIER_TIMEOUT')), false);
});

test('a message loses its code and starts with a capital', () => {
	assert.equal(plainMessage(coded('ERR_COURIER_HTTP', 'courier returned HTTP 503')), 'Courier returned HTTP 503');
	assert.equal(plainMessage(new Error('ERR_X_Y the thing broke')), 'The thing broke');
	assert.equal(plainMessage(new Error(''), 'it did not answer'), 'It did not answer');
	assert.equal(plainMessage(null), 'Something went wrong');
	// A caller that has its own sentence asks for nothing when there is no reason to add.
	assert.equal(plainMessage(Object.assign(new Error('ERR_PROOF_INVALID_PREV'), { code: 'ERR_PROOF_INVALID_PREV' }), ''), '', 'an error that is its code alone');
	assert.equal(plainMessage(new Error(''), ''), '');
});

test('a proof that does not verify is told apart from trouble reaching anything', () => {
	// What the library says when a proof is wrong, or is not for this payment.
	for (const code of [
		'ERR_PROOF_INVALID_PREV',
		'ERR_VM_INVALID_TRANSFER',
		'ERR_COMMITMENT_MISMATCH',
		'ERR_ASSET_INVALID_AMOUNT',
		'ERR_MSSMT_INVALID_PROOF',
		'ERR_TLV_TRUNCATED',
		'ERR_CRYPTO_INVALID_SIGNATURE',
		'ERR_TAPFREIGHTER_INVALID_PROOF',
		'ERR_TAPFREIGHTER_INVALID_ANCHOR',
		'ERR_TAPFREIGHTER_NOT_OWNED'
	]) {
		assert.equal(isProofInvalid(coded(code)), true, code);
	}
	// None of these says anything about the proof: a file is kept through them.
	for (const code of ['ERR_BEIGNET_TIMEOUT', 'ERR_TAPGARDEN_NOT_BURIED', 'ERR_COURIER_HTTP', 'ERR_COURIER_PROOF_NOT_FOUND', 'ERR_BEIGNET_WALLET', 'ERR_TAPFREIGHTER_PROOF_NOT_FOUND']) {
		assert.equal(isProofInvalid(coded(code)), false, code);
	}
	assert.equal(isProofInvalid(new Error('socket hang up')), false);
	assert.equal(isProofInvalid(null), false);
});

test('every refusal of a payment that means nothing left the wallet has a sentence here, and the list of them is not kept here', () => {
	// Which codes those are is the library's to say (its export
	// ASSET_PAYMENT_REFUSALS, read by adapter.js). These are the ones it
	// names at ts-tap 2df9663: a row that fails on one says why.
	const named = ['NOT_READY', 'INVALID', 'UNKNOWN_CHANNEL', 'NO_QUOTE', 'QUOTE_EXPIRED', 'PRICE_BOUND', 'INSUFFICIENT_OUTBOUND', 'BAD_INVOICE', 'INVOICE_EXPIRED', 'AMOUNT_REQUIRED', 'ALREADY_PAID', 'PAYMENT'];
	for (const name of named) {
		const mapped = mapLightning(coded(`ERR_BEIGNET_LN_${name}`, 'the detail of what went wrong'));
		assert.ok(mapped, name);
		assert.equal(mapped.message.includes('the detail of what went wrong'), false, name);
	}
	// The host keeps no copy of the list, which could fall behind the library's.
	assert.equal('PAY_NOTHING_SENT' in require('./errors'), false);
});

test('a failed payment is worded by the host, whatever the node wrote', () => {
	for (const word of Object.keys(PAYMENT_FAILURES)) {
		const why = paymentFailure(word);
		assert.equal(why.known, true, word);
		assert.match(why.message, /^[A-Z].*, so nothing was paid\.$/, word);
	}
	for (const text of ['htlc 7 failed at 03aa: temporary_channel_failure', 'toString', '', null, undefined, 7]) {
		assert.deepEqual(paymentFailure(text), { known: false, message: 'The payment did not go through, so nothing was paid.' }, String(text));
	}
});

test('bitcoin that is not on native SegWit addresses is said with what is there, what is needed and what sits elsewhere', () => {
	const short = (details) => Object.assign(new Error('native witness coins do not hold the funding'), { code: 'ERR_BEIGNET_LN_FUNDING_INPUTS', ...(details ? { details } : {}) });
	const open = mapLightning(short({ eligibleSatoshis: 40000n, neededSatoshis: 100420n, otherSatoshis: 250000n }));
	assert.deepEqual([open.extensionCode, open.status], ['FUNDING_INPUTS', 409]);
	assert.equal(
		open.message,
		'The bitcoin for an asset channel has to be on native SegWit addresses. This wallet has 40000 sats on those, and this needs about 100420. Another 250000 sats are on addresses of other types, which cannot be used for it. Nothing was done and nothing was spent.'
	);
	assert.deepEqual(open.details, { eligibleSats: '40000', neededSats: '100420', otherSats: '250000' });
	// Taking a funding back: nothing sits elsewhere, so nothing is said of it.
	const reclaim = mapLightning(short({ eligibleSatoshis: 0n, neededSatoshis: 360n, otherSatoshis: 0n }));
	assert.equal(reclaim.message, 'The bitcoin for an asset channel has to be on native SegWit addresses. This wallet has 0 sats on those, and this needs about 360. Nothing was done and nothing was spent.');
	// Wrapped by another error of the library, the figures are still read. With none, the rule alone is said.
	const wrapped = mapLightning(Object.assign(new Error('outer'), { code: 'ERR_BEIGNET_LN_FUNDING_INPUTS', cause: short({ eligibleSatoshis: 5n, neededSatoshis: 9n, otherSatoshis: 0n }) }));
	assert.deepEqual(wrapped.details, { eligibleSats: '5', neededSats: '9', otherSats: '0' });
	const bare = mapLightning(short(null));
	assert.deepEqual([bare.extensionCode, bare.status, 'details' in bare], ['FUNDING_INPUTS', 409, false]);
	assert.match(bare.message, /has to come from native SegWit addresses of this wallet/);
	// The library's own name for a wallet on its way down is the sentence the engine's reason has.
	assert.equal(mapLightning(Object.assign(new Error('draining'), { code: 'ERR_BEIGNET_LN_SERVICE_DRAINING', details: { reason: 'SERVICE_DRAINING' } })).message, 'This wallet is shutting down or in maintenance and takes no new payments, so nothing was paid. Pay again once it is running.');
});
