/**
 * Run with: npm test (from manager/ui).
 *
 * The one place a refusal becomes the Error every caller catches. A wallet's
 * host extension (Taproot Assets) refuses through the daemon, which wraps the
 * refusal in its own code; the dashboard acts on the extension's.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { responseError } from './api.js';

test("an extension's refusal is read by its own code and details, not the daemon's wrapper", () => {
	const err = responseError(400, {
		code: 'EXTENSION_ERROR',
		message: 'Minting needs 1200 sats on-chain and the wallet has 0',
		extension: { id: 'assets', code: 'INSUFFICIENT_BTC', details: { needed: 1200, spendable: 0 } }
	});
	assert.equal(err.code, 'INSUFFICIENT_BTC');
	assert.deepEqual(err.details, { needed: 1200, spendable: 0 });
	assert.equal(err.status, 400);
	assert.equal(err.extension, 'assets');
	assert.equal(err.message, 'Minting needs 1200 sats on-chain and the wallet has 0');
});

test('an extension that is not running keeps the code that says so', () => {
	const err = responseError(503, { code: 'EXTENSION_UNAVAILABLE', message: 'The assets extension is not running' });
	assert.equal(err.code, 'EXTENSION_UNAVAILABLE');
	assert.equal(err.status, 503);
	assert.equal(err.details, null);
	assert.equal(err.extension, undefined);
});

test('an ordinary refusal reads as it always has', () => {
	const err = responseError(409, { code: 'PRIMARY_IN_USE', message: 'In use', details: { wallets: ['a'] } });
	assert.equal(err.code, 'PRIMARY_IN_USE');
	assert.deepEqual(err.details, { wallets: ['a'] });
	// A wrapper with no code of its own beside it falls back to the wrapper's.
	assert.equal(responseError(400, { code: 'EXTENSION_ERROR', message: 'x', extension: { id: 'assets' } }).code, 'EXTENSION_ERROR');
});

test('a response with no error body still makes an Error with its status', () => {
	const err = responseError(502, undefined);
	assert.equal(err.message, 'Request failed (502)');
	assert.equal(err.status, 502);
	assert.equal(err.code, undefined);
});
