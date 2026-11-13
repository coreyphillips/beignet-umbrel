/**
 * Run with: npm test (from manager/ui).
 *
 * The Peers tab names each peer from the wallet's map. A peer the map does not
 * know, as a phone wallet never announces itself, is a private peer, and is
 * asked about once rather than on every 8-second poll.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, settle } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import PeersTab from './PeersTab.jsx';

const PHONE = '03' + '5'.repeat(64);
const PUBLIC = '02' + '6'.repeat(64);

test('a connected phone wallet is named a private peer, next to a named node', async () => {
	const asked = [];
	const api = {
		get: async (path) => {
			if (path === '/peers') {
				return [
					{ pubkey: PUBLIC, host: '10.21.21.9', port: 9735, transport: 'tcp', state: 'connected' },
					{ pubkey: PHONE, host: '127.0.0.1', port: 53122, transport: 'tcp', state: 'connected' }
				];
			}
			if (path.startsWith('/node/uri')) return { uri: null };
			if (path.startsWith('/graph/node')) {
				const pk = new URLSearchParams(path.split('?')[1]).get('pubkey');
				asked.push(pk);
				if (pk === PUBLIC) return { pubkey: pk, alias: 'Seven of Nine' };
				const err = new Error('Node not found in graph');
				err.code = 'NOT_FOUND';
				err.status = 404;
				throw err;
			}
			return null;
		},
		post: async () => ({})
	};
	const view = await render(
		(props) => createElement(ToastProvider, null, createElement(PeersTab, props)),
		{ id: 'w1', api, info: { nodeId: '02' + '1'.repeat(64) }, rec: {}, tick: 0, bump: () => {} }
	);
	try {
		await settle(50);
		const labels = view.$$('tbody .peer-alias').map((el) => el.textContent);
		assert.deepEqual(labels, ['Seven of Nine', 'Private peer']);
		assert.deepEqual(asked.sort(), [PHONE, PUBLIC].sort(), 'each peer is asked about once');
	} finally {
		await view.unmount();
	}
});

// The relay-only Iroh link is copied from here too, so what still gives the
// address away is boxed under it here as it is on the Overview card.
test('a relay-only Iroh link carries its warnings on the Peers tab', async () => {
	const NODE = '02' + '1'.repeat(64);
	const uri = `${NODE}@iroh:${'b'.repeat(64)}?relay=https%3A%2F%2Frelay.example%2F`;
	const api = {
		get: async (path) => (path === '/peers' ? [] : path.startsWith('/node/uri') ? { uri: null } : null),
		post: async () => ({})
	};
	const tab = (rec) =>
		render(
			(props) => createElement(ToastProvider, null, createElement(PeersTab, props)),
			{
				id: 'w1',
				api,
				info: { nodeId: NODE, irohAvailable: true, irohUri: uri, irohRelayOnly: true },
				rec: { announce: false, iroh: { enabled: true, relayOnly: true }, ...rec },
				config: { irohRelayOnlyAvailable: true },
				tick: 0,
				bump: () => {}
			}
		);
	const warnings = (view) => view.$$('[data-testid="peer-uri-warning"]').map((el) => el.textContent);
	const hybrid = await tab({ networkMode: 'hybrid' });
	try {
		await settle(50);
		assert.match(hybrid.text(), /Iroh phone link \(relay only\)/);
		const boxes = warnings(hybrid);
		assert.equal(boxes.length, 1);
		assert.match(boxes[0], /Hybrid mode/);
	} finally {
		await hybrid.unmount();
	}
	const tor = await tab({ networkMode: 'tor' });
	try {
		await settle(50);
		assert.match(tor.text(), /Iroh phone link \(relay only\)/);
		assert.deepEqual(warnings(tor), []);
	} finally {
		await tor.unmount();
	}
});
