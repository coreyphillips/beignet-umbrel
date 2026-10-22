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

// Presets are probed when the fields appear: each one says whether it is
// there and on which chain, Refresh asks again, and a server the user typed
// can be tested before it is saved.
import { manager } from '../api.js';
import { settle } from '../../test/render.mjs';

function stub(name, fn) {
	const before = manager[name];
	manager[name] = fn;
	return () => {
		manager[name] = before;
	};
}

const PRESETS = [
	{ id: 'umbrel-electrs', label: 'Umbrel Electrs', host: '10.21.21.10', port: 50001, tls: false, note: 'n' },
	{ id: 'umbrel-fulcrum', label: 'Umbrel Fulcrum', host: '10.21.21.200', port: 50002, tls: false, note: 'n' }
];
const probe = (extra) => ({ reachable: true, software: 'electrs/0.10.9', protocol: '1.4', chain: 'mainnet', genesisHash: null, height: 908214, certificate: null, error: null, ...extra });
const discovered = () => ({
	at: Date.now(),
	servers: [
		{ ...PRESETS[0], ...probe() },
		{ ...PRESETS[1], ...probe({ reachable: false, error: 'unreachable', software: null, chain: 'unknown', height: null }) }
	]
});

test('each preset says whether it is there and on which chain, and Refresh asks again', async () => {
	const calls = [];
	const restore = stub('discoverElectrum', async (refresh) => {
		calls.push(!!refresh);
		return discovered();
	});
	const seen = {};
	const r = await render(Harness, { initial: { host: '', port: 50001, tls: false }, seen, presets: PRESETS, network: 'mainnet' });
	try {
		await settle(0);
		assert.deepEqual(calls, [false], 'asked once, on appearing');
		const electrs = r.$('[data-testid="preset-status-umbrel-electrs"]');
		assert.equal(electrs.dataset.state, 'reachable');
		assert.match(electrs.textContent, /mainnet/);
		assert.match(electrs.textContent, /908,214/);
		const fulcrum = r.$('[data-testid="preset-status-umbrel-fulcrum"]');
		assert.equal(fulcrum.dataset.state, 'unreachable');
		assert.match(fulcrum.textContent, /not found/);
		await click(r.$('[data-testid="electrum-refresh"]'));
		await settle(0);
		assert.deepEqual(calls, [false, true]);
		await click(r.$$('.preset-btn')[0]);
		assert.deepEqual(seen.value, { host: '10.21.21.10', port: 50001, tls: false }, 'a preset still fills the fields');
	} finally {
		await r.unmount();
		restore();
	}
});

test('a preset on another chain than the wallet says so, and no presets means no probe', async () => {
	let calls = 0;
	const restore = stub('discoverElectrum', async () => {
		calls++;
		return discovered();
	});
	const seen = {};
	const r = await render(Harness, { initial: { host: '', port: 50001, tls: false }, seen, presets: PRESETS, network: 'testnet' });
	try {
		await settle(0);
		const electrs = r.$('[data-testid="preset-status-umbrel-electrs"]');
		assert.equal(electrs.dataset.state, 'wrong-chain');
		assert.match(electrs.textContent, /mainnet, not testnet/);
	} finally {
		await r.unmount();
	}
	const none = await render(Harness, { initial: { host: '', port: 50001, tls: false }, seen: {}, presets: [] });
	try {
		await settle(0);
		assert.equal(calls, 1, 'nothing to probe without presets');
		assert.equal(none.$('[data-testid="electrum-refresh"]'), null);
	} finally {
		await none.unmount();
		restore();
	}
});

test('Test probes the server as typed and the answer goes away when the fields change', async () => {
	const asked = [];
	const restore = stub('testElectrum', async (body) => {
		asked.push(body);
		if (body.host === 'down.example') return { electrum: body, ...probe({ reachable: false, error: 'unreachable', software: null, chain: 'unknown', height: null }), network: body.network, chainMatches: null };
		return { electrum: body, ...probe({ chain: 'testnet', height: 4600000 }), network: body.network, chainMatches: body.network ? body.network === 'testnet' : null };
	});
	const seen = {};
	const r = await render(Harness, { initial: { host: '', port: 50001, tls: false }, seen, network: 'mainnet' });
	try {
		const button = r.$('[data-testid="electrum-test"]');
		assert.equal(button.disabled, true, 'nothing to test without a host');
		const host = r.$('input[placeholder^="192.168"]');
		await type(host, 'testnet.example');
		assert.equal(r.$('[data-testid="electrum-test"]').disabled, false);
		await click(r.$('[data-testid="electrum-test"]'));
		await settle(0);
		assert.deepEqual(asked, [{ host: 'testnet.example', port: 50001, tls: false, network: 'mainnet' }]);
		const result = r.$('[data-testid="electrum-test-result"]');
		assert.equal(result.dataset.state, 'wrong-chain');
		assert.match(result.textContent, /testnet.*not mainnet/);
		await type(host, 'down.example');
		assert.equal(r.$('[data-testid="electrum-test-result"]'), null, 'the answer was for another server');
		await click(r.$('[data-testid="electrum-test"]'));
		await settle(0);
		assert.equal(r.$('[data-testid="electrum-test-result"]').dataset.state, 'unreachable');
		assert.match(r.$('[data-testid="electrum-test-result"]').textContent, /Nothing answered at down.example:50001/);
	} finally {
		await r.unmount();
		restore();
	}
});

test('a preset that names its networks is offered for those alone', async () => {
	const restore = stub('discoverElectrum', async () => discovered());
	const presets = [...PRESETS, { id: 'umbrel-rbitcoin', label: 'Umbrel rbitcoin', host: 'beignet-rbitcoin_node_1', port: 50001, tls: false, networks: ['mainnet'], note: 'n' }];
	const main = await render(Harness, { initial: { host: '', port: 50001, tls: false }, seen: {}, presets, network: 'mainnet' });
	try {
		assert.equal(main.$$('.preset-btn').length, 3);
	} finally {
		await main.unmount();
	}
	const test = await render(Harness, { initial: { host: '', port: 50001, tls: false }, seen: {}, presets, network: 'testnet' });
	try {
		assert.deepEqual(test.$$('.preset-btn .preset-name').map((n) => n.textContent), ['Umbrel Electrs', 'Umbrel Fulcrum'], 'a mainnet-only node is no use to a testnet wallet');
	} finally {
		await test.unmount();
	}
	const any = await render(Harness, { initial: { host: '', port: 50001, tls: false }, seen: {}, presets });
	try {
		assert.equal(any.$$('.preset-btn').length, 3, 'with no network to hold it to, every preset is offered');
	} finally {
		await any.unmount();
		restore();
	}
});

test('a Test answer that lands after the fields changed is not shown under the new server', async () => {
	// The probe takes up to a few seconds; the user may have typed another
	// host meanwhile. The late answer is about the old one and must not be
	// read as the new one's.
	const pending = [];
	const restore = stub('testElectrum', (body) => new Promise((resolve) => pending.push({ body, resolve })));
	const seen = {};
	const r = await render(Harness, { initial: { host: 'old.example', port: 50001, tls: false }, seen, network: 'mainnet' });
	try {
		await click(r.$('[data-testid="electrum-test"]'));
		assert.equal(pending.length, 1);
		await type(r.$('input[placeholder^="192.168"]'), 'new.example');
		pending[0].resolve({ electrum: pending[0].body, ...probe(), network: 'mainnet', chainMatches: true });
		await settle(0);
		assert.equal(r.$('[data-testid="electrum-test-result"]'), null, 'the answer was for old.example');
		await click(r.$('[data-testid="electrum-test"]'));
		assert.equal(pending.length, 2);
		assert.equal(pending[1].body.host, 'new.example');
		pending[1].resolve({ electrum: pending[1].body, ...probe({ chain: 'testnet' }), network: 'mainnet', chainMatches: false });
		await settle(0);
		assert.equal(r.$('[data-testid="electrum-test-result"]').dataset.state, 'wrong-chain');
	} finally {
		await r.unmount();
		restore();
	}
});

test('a Test answer is for the network it was asked about', async () => {
	// The same server is a right answer for one network and a wrong one for
	// another, so the result is filed under the network too and a parent that
	// changes the network makes it go away.
	const restore = stub('testElectrum', async (body) => ({ electrum: body, ...probe(), network: body.network, chainMatches: body.network === 'mainnet' }));
	function Parent() {
		const [value, setValue] = useState({ host: 'a.example', port: 50001, tls: false });
		const [network, setNetwork] = useState('mainnet');
		return createElement('div', null,
			createElement('button', { 'data-testid': 'to-testnet', onClick: () => setNetwork('testnet') }, 'testnet'),
			createElement(ElectrumFields, { value, onChange: setValue, network }));
	}
	const r = await render(Parent, {});
	try {
		await click(r.$('[data-testid="electrum-test"]'));
		await settle(0);
		assert.equal(r.$('[data-testid="electrum-test-result"]').dataset.state, 'reachable');
		await click(r.$('[data-testid="to-testnet"]'));
		assert.equal(r.$('[data-testid="electrum-test-result"]'), null, 'mainnet was the answer; testnet is now the question');
	} finally {
		await r.unmount();
		restore();
	}
});
