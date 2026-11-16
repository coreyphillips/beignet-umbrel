'use strict';

/**
 * The library's and the wallet's errors, said in the dashboard's codes.
 *
 * Run: cd manager && npm test
 * Or:  cd manager && node --test server/assets-host/errors.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { refusal, isRefusal, isFenced, isNotYet, isCourierTrouble, isProofMissing, plainMessage, mapError, workingSats } = require('./errors');

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
});
