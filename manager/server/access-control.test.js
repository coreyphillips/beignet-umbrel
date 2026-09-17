'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * app_proxy does not resolve on a developer's machine, which is the fail-open
 * window itself: the guard has never resolved it and never will. That makes it
 * the state to test the backup routes in, since those are the ones that must
 * not be open to the shared network while it lasts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.BEIGNET_TRUST_ALL;
const { createAccessGuard } = require('./access-control');

function fakeRes() {
	return {
		code: 0,
		body: null,
		status(c) {
			this.code = c;
			return this;
		},
		json(b) {
			this.body = b;
			return this;
		}
	};
}

function call(guard, ip) {
	const res = fakeRes();
	let passed = false;
	guard({ method: 'POST', url: '/export', socket: { remoteAddress: ip } }, res, () => {
		passed = true;
	});
	return { passed, res };
}

test('an unresolved app_proxy leaves the dashboard open but not the backup routes', () => {
	const guard = createAccessGuard();
	// The lockout safeguard: another app's IP still reaches the ordinary API.
	assert.equal(call(guard, '10.21.0.9').passed, true);
	// The archive is every seed on the box, so it does not get that safeguard.
	const strict = call(guard.strict, '10.21.0.9');
	assert.equal(strict.passed, false);
	assert.equal(strict.res.code, 403);
	assert.equal(strict.res.body.error.code, 'FORBIDDEN');
	// Loopback is the manager talking to itself, and is always allowed.
	assert.equal(call(guard.strict, '127.0.0.1').passed, true);
	assert.equal(call(guard.strict, '::ffff:127.0.0.1').passed, true);
});
