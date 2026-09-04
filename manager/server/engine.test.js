'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * The dashboard hides channel backup controls when the bundled engine
 * predates the feature; the version comes from the package the daemon
 * binary belongs to, found by walking up from BEIGNET_BIN.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { engineVersion, recoveryAvailable, lfbwAvailable, jitQuoteAvailable, recoveryAutoApplyAvailable,
	guardianHostingAvailable,
	guardianRotationAvailable
} = require('./engine');

function fakeInstall(version) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-engine-'));
	const pkg = path.join(root, 'node_modules', 'beignet');
	fs.mkdirSync(path.join(pkg, 'dist', 'cli'), { recursive: true });
	fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'beignet', version }));
	// A nested manifest that is not beignet's must not be mistaken for it.
	fs.writeFileSync(path.join(pkg, 'dist', 'package.json'), JSON.stringify({ type: 'commonjs' }));
	fs.writeFileSync(path.join(pkg, 'dist', 'cli', 'cli.js'), '');
	return { root, bin: path.join(pkg, 'dist', 'cli', 'cli.js') };
}

test('the version is read from the package the binary belongs to', () => {
	const { root, bin } = fakeInstall('0.9.2');
	try {
		assert.equal(engineVersion(bin), '0.9.2');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('no binary, or a binary outside any beignet package, is an unknown version', () => {
	assert.equal(engineVersion(undefined), null);
	assert.equal(engineVersion(''), null);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-engine-'));
	try {
		fs.writeFileSync(path.join(root, 'beignet'), '');
		assert.equal(engineVersion(path.join(root, 'beignet')), null);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('recovery needs 0.9.1 or later', () => {
	assert.equal(recoveryAvailable('0.9.0'), false);
	assert.equal(recoveryAvailable('0.9.1'), true);
	assert.equal(recoveryAvailable('0.9.2'), true);
	assert.equal(recoveryAvailable('0.10.0'), true);
	assert.equal(recoveryAvailable('1.0.0'), true);
	assert.equal(recoveryAvailable(null), false);
	assert.equal(recoveryAvailable('garbage'), false);
});

// Lightning-first wallets need routes the engine gained after its last
// release; the only honest source is the OpenAPI module beside the binary.
test('lightning-first support is probed on the engine, not its version', () => {
	const { root, bin } = fakeInstall('0.9.3');
	try {
		assert.equal(lfbwAvailable(bin), false, 'no openapi module at all');
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/invoice/create': {}, '/jit/invoice': {} }");
		assert.equal(lfbwAvailable(bin), false, 'JIT alone is not the whole surface');
		fs.writeFileSync(
			openapi,
			"paths: { '/jit/invoice': {}, '/direct-funding/send': {} }, allowSplice: 'boolean?'"
		);
		assert.equal(lfbwAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(lfbwAvailable(undefined), false);
});

test('the JIT quote and the automatic checkpoint restore are probed the same way', () => {
	const { root, bin } = fakeInstall('0.10.0');
	try {
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/jit/invoice': {}, '/jit/status': {} }");
		assert.equal(jitQuoteAvailable(bin), false, '0.10.0 has status and invoice, no quote');
		fs.writeFileSync(openapi, "paths: { '/jit/invoice': {}, '/jit/status': {}, '/jit/quote': {} }");
		assert.equal(jitQuoteAvailable(bin), true);

		assert.equal(recoveryAutoApplyAvailable(bin), false, 'no config module at all');
		const config = path.join(path.dirname(bin), 'config.js');
		fs.writeFileSync(config, "env.BEIGNET_RECOVERY_MODE; env.BEIGNET_RECOVERY_GUARDIANS;");
		assert.equal(recoveryAutoApplyAvailable(bin), false);
		fs.writeFileSync(config, "env.BEIGNET_RECOVERY_MODE; env.BEIGNET_RECOVERY_AUTO_APPLY;");
		assert.equal(recoveryAutoApplyAvailable(bin), true);
		fs.writeFileSync(config, "env.BEIGNET_RECOVERY_MODE;");
		fs.writeFileSync(openapi, "description: 'BEIGNET_RECOVERY_AUTO_APPLY applies the newest capsule'");
		assert.equal(recoveryAutoApplyAvailable(bin), true, 'the OpenAPI module documenting the env is proof too');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(jitQuoteAvailable(undefined), false);
	assert.equal(recoveryAutoApplyAvailable(undefined), false);
});

test('guardian hosting is probed on the OpenAPI module (beignet #699)', () => {
	const { root, bin } = fakeInstall('0.11.0');
	try {
		assert.equal(guardianHostingAvailable(bin), false, 'no openapi module at all');
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/recovery/status': {}, '/guardian/status': {} }");
		assert.equal(guardianHostingAvailable(bin), false, 'the status route alone is not the whole surface');
		fs.writeFileSync(openapi, "paths: { '/guardian/status': {}, '/recovery/resolve-guardian': {} }");
		assert.equal(guardianHostingAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(guardianHostingAvailable(undefined), false);
});

test('guardian rotation is probed on the OpenAPI module (beignet #701)', () => {
	const { root, bin } = fakeInstall('0.12.0');
	try {
		const openapi = path.join(path.dirname(bin), 'openapi.js');
		fs.writeFileSync(openapi, "paths: { '/guardian/status': {}, '/recovery/resolve-guardian': {} }");
		assert.equal(guardianRotationAvailable(bin), false, '0.12.0 hosts guardians but cannot rotate');
		fs.writeFileSync(openapi, "paths: { '/recovery/resolve-guardian': {}, '/recovery/rotate-guardians': {} }");
		assert.equal(guardianRotationAvailable(bin), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.equal(guardianRotationAvailable(undefined), false);
});
