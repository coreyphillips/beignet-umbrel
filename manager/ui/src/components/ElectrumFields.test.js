/**
 * Run with: npm test (from manager/ui).
 *
 * The Electrum fields' certificate verification (beignet #1776): offered only
 * for a TLS server on an engine that has it, pins only once it is on, and the
 * body the manager gets.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { click, render, type } from '../../test/render.mjs';
import ElectrumFields, { electrumBody } from './ElectrumFields.jsx';

const PIN = 'AC:46:DD:A7:16:DB:70:98:48:AC:80:A8:4E:BA:47:A7:46:73:6B:49:96:D5:3D:3B:CF:F0:7C:6E:8D:45:C4:7F';

function Harness({ initial, seen, ...rest }) {
	const [value, setValue] = useState(initial);
	seen.value = value;
	return createElement(ElectrumFields, { value, onChange: setValue, ...rest });
}

const tlsBox = (r) => r.$$('input[type="checkbox"]').find((b) => b.parentElement.textContent.includes('Use TLS'));

test('the verify switch appears for a TLS server on an engine that verifies, and pins once it is on', async () => {
	const seen = {};
	const r = await render(Harness, { initial: { host: 'electrum.example', port: 50002, tls: false }, seen, verifyAvailable: true });
	try {
		assert.equal(r.$('[data-testid="electrum-tls-verify"]'), null, 'plain TCP has no certificate to check');
		await click(tlsBox(r));
		assert.ok(r.$('[data-testid="electrum-tls-verify"]'));
		assert.equal(r.$('[data-testid="electrum-tls-pins"]'), null, 'no pins while verification is off');
		await click(r.$('[data-testid="electrum-tls-verify"]'));
		await type(r.$('[data-testid="electrum-tls-pins"]'), `sha256 Fingerprint=${PIN}`);
		assert.deepEqual(electrumBody(seen.value), {
			host: 'electrum.example',
			port: 50002,
			tls: true,
			tlsVerify: true,
			tlsFingerprints: [PIN]
		});
		await click(tlsBox(r));
		assert.equal(r.$('[data-testid="electrum-tls-verify"]'), null);
		assert.deepEqual(electrumBody(seen.value), { host: 'electrum.example', port: 50002, tls: false }, 'turning TLS off sends no verification');
	} finally {
		await r.unmount();
	}
});

test('an engine without verification gets no switch, and a stored record shows its pins', async () => {
	const seen = {};
	const old = await render(Harness, { initial: { host: 'e.example', port: 50002, tls: true }, seen });
	try {
		assert.equal(old.$('[data-testid="electrum-tls-verify"]'), null);
	} finally {
		await old.unmount();
	}
	const stored = { host: 'e.example', port: 50002, tls: true, tlsVerify: true, tlsFingerprints: ['ab'.repeat(32), 'cd'.repeat(32)] };
	const r = await render(Harness, { initial: stored, seen, verifyAvailable: true });
	try {
		assert.equal(r.$('[data-testid="electrum-tls-verify"]').checked, true);
		assert.equal(r.$('[data-testid="electrum-tls-pins"]').value, `${'ab'.repeat(32)}, ${'cd'.repeat(32)}`);
		assert.deepEqual(electrumBody(seen.value), { host: 'e.example', port: 50002, tls: true, tlsVerify: true, tlsFingerprints: stored.tlsFingerprints });
		await click(r.$('[data-testid="electrum-tls-verify"]'));
		assert.deepEqual(electrumBody(seen.value), { host: 'e.example', port: 50002, tls: true }, 'off drops the pins too');
	} finally {
		await r.unmount();
	}
});
