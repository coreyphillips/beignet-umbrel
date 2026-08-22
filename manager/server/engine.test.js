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
const { engineVersion, recoveryAvailable } = require('./engine');

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
