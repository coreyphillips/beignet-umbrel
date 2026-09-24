/**
 * Run with: npm test (from manager/ui).
 *
 * The network mode field (umbrel #193): the three choices, the public address
 * that appears for the two direct modes, the port hint, and the announce switch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { click, render, type } from '../../test/render.mjs';
import NetworkModeField from './NetworkModeField.jsx';

function Harness({ initial = 'hybrid', host = '', announced = false, log, ...rest }) {
	const [mode, setMode] = useState(initial);
	const [publicHost, setPublicHost] = useState(host);
	const [announce, setAnnounce] = useState(announced);
	return createElement(NetworkModeField, {
		mode,
		onMode: (v) => {
			log.push(['mode', v]);
			setMode(v);
		},
		publicHost,
		onPublicHost: (v) => {
			log.push(['host', v]);
			setPublicHost(v);
		},
		announce,
		onAnnounce: (v) => {
			log.push(['announce', v]);
			setAnnounce(v);
		},
		...rest
	});
}

const pill = (r, label) => r.$$('button.pill').find((b) => b.textContent.trim() === label);

test('three modes, one line on the one chosen, and the address field for the direct modes', async () => {
	const log = [];
	const r = await render(Harness, { initial: 'tor', log });
	try {
		assert.ok(pill(r, 'Tor').className.includes('active'));
		assert.match(r.$('[data-testid="network-note"]').textContent, /Every peer is reached over Tor/);
		assert.equal(r.$('[data-testid="public-host"]'), null, 'tor mode has no public address');
		await click(pill(r, 'Clearnet'));
		assert.deepEqual(log, [['mode', 'clearnet']]);
		assert.ok(r.$('[data-testid="public-host"]'), 'clearnet asks for the address');
		assert.match(r.text(), /Clearnet needs a public address/);
		await type(r.$('[data-testid="public-host"]'), '203.0.113.4');
		assert.equal(log.at(-1)[1], '203.0.113.4');
		assert.doesNotMatch(r.text(), /Clearnet needs a public address/);
		assert.match(r.text(), /shown on the Overview tab once the wallet exists/, 'no port yet on create');
		await click(pill(r, 'Hybrid'));
		assert.match(r.$('[data-testid="network-note"]').textContent, /Both the Tor address and your public address/);
		assert.equal(r.$('[data-testid="public-host"]').value, '203.0.113.4', 'the address survives the switch');
	} finally {
		await r.unmount();
	}
});

test('with the wallet running, the hint names the port to forward', async () => {
	const r = await render(Harness, { initial: 'hybrid', host: 'node.example.com', log: [], publicPort: 19103 });
	try {
		assert.match(r.text(), /Peers reach this wallet at node.example.com:19103/);
		assert.match(r.text(), /Forward TCP port 19103 on your router/);
	} finally {
		await r.unmount();
	}
});

test('the announce switch reaches the form; Tor is disabled without a proxy; an old engine is said', async () => {
	const log = [];
	const r = await render(Harness, { initial: 'hybrid', log, torAvailable: false, torProxyScopeAvailable: false });
	try {
		const box = r.$('[data-testid="announce"]');
		assert.equal(box.checked, false);
		await click(box);
		assert.deepEqual(log, [['announce', true]]);
		assert.equal(r.$('[data-testid="announce"]').checked, true);
		assert.equal(pill(r, 'Tor').disabled, true);
		assert.equal(pill(r, 'Tor').title, 'This app has no Tor proxy');
		assert.match(r.text(), /cannot keep Tor for onion peers only/);
	} finally {
		await r.unmount();
	}
});
