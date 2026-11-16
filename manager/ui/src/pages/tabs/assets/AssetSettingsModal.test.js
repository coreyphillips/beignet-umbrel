/**
 * Run with: npm test (from manager/ui).
 *
 * The proof server setting: which servers are offered, which one the Test
 * button asks about, what is saved to the wallet's record, and what is said
 * when the app refuses it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { manager } from '../../../api.js';
import { ToastProvider } from '../../../components/Toast.jsx';
import { click, render, settle, type } from '../../../../test/render.mjs';
import AssetSettingsModal from './AssetSettingsModal.jsx';

const SERVERS = [
	{
		id: 'lightning-labs',
		label: 'Lightning Labs',
		courier: 'universerpc://universe.lightning.finance:10029',
		rest: 'https://universe.lightning.finance',
		networks: ['mainnet'],
		note: "Lightning Labs' universe, the default of their own daemon"
	},
	{
		id: 'lightning-labs-testnet',
		label: 'Lightning Labs',
		courier: 'universerpc://testnet.universe.lightning.finance:10029',
		rest: 'https://testnet.universe.lightning.finance',
		networks: ['testnet'],
		note: "Lightning Labs' testnet universe"
	}
];
const CONFIG = { assetsAvailable: true, universeServers: SERVERS };

const OWN = { courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com:8089' };

/** The wallet's host as its status describes the server in use. */
const statusFor = (universe) => ({
	ready: true,
	proofServer: universe
		? { host: 'u.example.com:10029', courier: universe.courier, rest: universe.rest, isDefault: false, reachable: true, lastError: null, viaTor: false }
		: { host: 'universe.lightning.finance:10029', courier: SERVERS[0].courier, rest: SERVERS[0].rest, isDefault: true, reachable: true, lastError: null, viaTor: false }
});

/** Mount the dialog over a wallet, recording what it asks of the wallet and of the app. */
async function mount({ universe = null, network = 'mainnet', config = CONFIG, chain = null, answer, save } = {}) {
	const posts = [];
	const saves = [];
	const done = [];
	const api = {
		get: async () => ({}),
		post: async (path, body) => {
			posts.push([path, body]);
			return typeof answer === 'function' ? answer(body) : answer || { reachable: true, network: null, ms: 42, error: null };
		}
	};
	const before = manager.updateWallet;
	manager.updateWallet = async (id, body) => {
		saves.push([id, body]);
		return save ? save(body) : {};
	};
	const rec = { id: 'w1', network, assets: { enabled: true, universe } };
	const r = await render(ToastProvider, {
		children: createElement(AssetSettingsModal, {
			api,
			rec,
			// `chain` is what the wallet's host says its chain is: which testnet, for a testnet wallet.
			status: chain ? { ...statusFor(universe), chain: { name: chain, height: 1, minConfirmations: 6 } } : statusFor(universe),
			config,
			network,
			lightning: false,
			origin: null,
			onClose: () => done.push('closed'),
			onSaved: () => done.push('saved')
		})
	});
	return {
		...r,
		posts,
		saves,
		done,
		test: (name) => r.$(`[data-testid="${name}"]`),
		async unmount() {
			await r.unmount();
			manager.updateWallet = before;
		}
	};
}

test("the servers offered are the app's for the wallet's network, and the default is named", async () => {
	const r = await mount();
	try {
		const options = r.$$('[role="radiogroup"] label').map((l) => l.textContent.replace(/\s+/g, ' ').trim());
		assert.deepEqual(options, [
			"Default for mainnet: universe.lightning.finance:10029Lightning Labs' universe, the default of their own daemon",
			'Custom'
		]);
		assert.equal(r.test('asset-settings-default').checked, true);
		assert.equal(r.test('asset-settings-custom-fields'), null);
		assert.equal(r.test('asset-settings-save').disabled, true, 'nothing to save until something changes');
	} finally {
		await r.unmount();
	}

	// A wallet on its own server is still told what the default is: its host
	// only describes the server in use, so the app's list is what names it.
	const own = await mount({ universe: OWN });
	try {
		assert.equal(own.test('asset-settings-custom').checked, true);
		assert.equal(own.test('asset-settings-host').value, 'u.example.com');
		assert.equal(own.test('asset-settings-port').value, '10029');
		assert.equal(own.test('asset-settings-rest').value, 'https://u.example.com:8089');
		assert.match(own.$('[role="radiogroup"] label').textContent, /Default for mainnet: universe\.lightning\.finance:10029/);
	} finally {
		await own.unmount();
	}

	const testnet = await mount({ network: 'testnet' });
	try {
		assert.match(testnet.$('[role="radiogroup"] label').textContent, /Default for testnet: testnet\.universe\.lightning\.finance:10029/);
		assert.doesNotMatch(testnet.$('[role="radiogroup"]').textContent, /: universe\.lightning\.finance/, "another network's server is not offered");
	} finally {
		await testnet.unmount();
	}

	// Testnet is two chains with a server each. The wallet's host says which
	// one it is on, and the dialog names that chain and offers its server.
	const both = {
		...CONFIG,
		universeServers: [
			{ ...SERVERS[0] },
			{ ...SERVERS[1], label: 'Lightning Labs testnet3', chain: 'testnet3', note: "Lightning Labs' testnet3 universe" },
			{
				id: 'lightning-labs-testnet4',
				label: 'Lightning Labs testnet4',
				courier: 'universerpc://testnet4.universe.lightning.finance:443',
				rest: 'https://testnet4.universe.lightning.finance',
				networks: ['testnet'],
				chain: 'testnet4',
				note: "Lightning Labs' testnet4 universe"
			}
		]
	};
	const four = await mount({ network: 'testnet', config: both, chain: 'testnet4' });
	try {
		const group = four.$('[role="radiogroup"]');
		assert.match(group.querySelector('label').textContent, /^Default for testnet4: testnet4\.universe\.lightning\.finance:443Lightning Labs' testnet4 universe$/);
		assert.doesNotMatch(group.textContent, /testnet\.universe\.lightning\.finance/, "the other testnet's server is not offered");
	} finally {
		await four.unmount();
	}
	const three = await mount({ network: 'testnet', config: both, chain: 'testnet3' });
	try {
		const group = three.$('[role="radiogroup"]');
		assert.match(group.querySelector('label').textContent, /^Default for testnet3: testnet\.universe\.lightning\.finance:10029/);
		assert.doesNotMatch(group.textContent, /testnet4\.universe/);
	} finally {
		await three.unmount();
	}

	// Regtest has no public server: the dialog says there is none, and offers no test of nothing.
	const regtest = await mount({ network: 'regtest', config: CONFIG });
	try {
		// Its host reports no server either.
		assert.match(regtest.$('[role="radiogroup"] label').textContent, /Default for regtest/);
	} finally {
		await regtest.unmount();
	}
});

test('a second server the app knows is offered by name, and saved as that server', async () => {
	const second = { id: 'second', label: 'Second', courier: 'universerpc://second.example.com:10029', rest: 'https://second.example.com', networks: ['mainnet'], note: 'A second one' };
	const r = await mount({ config: { universeServers: [...SERVERS, second] } });
	try {
		await click(r.test('asset-settings-server-second'));
		assert.equal(r.test('asset-settings-custom-fields'), null, 'nothing to type for a server the app knows');
		await click(r.test('asset-settings-test'));
		await settle(20);
		assert.deepEqual(r.posts.at(-1), ['/x/assets/proof-server/test', { rest: 'https://second.example.com' }]);
		await click(r.test('asset-settings-save'));
		await settle(20);
		assert.deepEqual(r.saves, [['w1', { assets: { universe: { courier: second.courier, rest: second.rest } } }]]);
	} finally {
		await r.unmount();
	}

	// And a wallet already on it opens with it chosen, not as something typed.
	const on = await mount({ universe: { courier: second.courier, rest: second.rest }, config: { universeServers: [...SERVERS, second] } });
	try {
		assert.equal(on.test('asset-settings-server-second').checked, true);
		assert.equal(on.test('asset-settings-save').disabled, true);
	} finally {
		await on.unmount();
	}
});

test('Test asks the wallet about the server that is chosen, not the one in use', async () => {
	const r = await mount({ universe: OWN });
	try {
		await click(r.test('asset-settings-test'));
		await settle(20);
		assert.deepEqual(r.posts, [['/x/assets/proof-server/test', { rest: 'https://u.example.com:8089' }]]);
		assert.equal(r.test('asset-settings-test-result').textContent, 'Reachable · 42 ms');
		assert.equal(r.test('asset-settings-test-result').getAttribute('data-state'), 'ok');

		// Switched to the default, it is the default that is tested, though the wallet is still on its own.
		await click(r.test('asset-settings-default'));
		assert.equal(r.test('asset-settings-test-result'), null, 'a result for another server is not left showing');
		await click(r.test('asset-settings-test'));
		await settle(20);
		assert.deepEqual(r.posts.at(-1), ['/x/assets/proof-server/test', { rest: 'https://universe.lightning.finance' }]);

		// A typed server: the web address defaults to https on the host.
		await click(r.test('asset-settings-custom'));
		await type(r.test('asset-settings-host'), 'tap.example.org');
		await type(r.test('asset-settings-rest'), '');
		await click(r.test('asset-settings-test'));
		await settle(20);
		assert.deepEqual(r.posts.at(-1), ['/x/assets/proof-server/test', { rest: 'https://tap.example.org' }]);
	} finally {
		await r.unmount();
	}

	const away = await mount({ answer: { reachable: false, network: null, ms: null, error: 'connection refused' } });
	try {
		await click(away.test('asset-settings-test'));
		await settle(20);
		assert.equal(away.test('asset-settings-test-result').textContent, 'Not reachable: connection refused.');
		assert.equal(away.test('asset-settings-test-result').getAttribute('data-state'), 'unreachable');
	} finally {
		await away.unmount();
	}
});

test("a server is saved to the wallet's record, and the default is saved as none", async () => {
	const r = await mount();
	try {
		assert.match(r.test('asset-settings-restart').textContent, /Changing this restarts the wallet/, 'said before the button, not after');
		await click(r.test('asset-settings-custom'));
		await type(r.test('asset-settings-host'), 'u.example.com');
		await type(r.test('asset-settings-rest'), 'https://u.example.com:8089/');
		assert.equal(r.test('asset-settings-save').disabled, false);
		await click(r.test('asset-settings-save'));
		await settle(20);
		assert.deepEqual(r.saves, [['w1', { assets: { universe: OWN } }]]);
		assert.deepEqual(r.done, ['saved']);
	} finally {
		await r.unmount();
	}

	const back = await mount({ universe: OWN });
	try {
		await click(back.test('asset-settings-default'));
		await click(back.test('asset-settings-save'));
		await settle(20);
		assert.deepEqual(back.saves, [['w1', { assets: { universe: null } }]], 'null puts the default back');
	} finally {
		await back.unmount();
	}
});

test('a server the app refuses is said in its words, and the dialog stays for another try', async () => {
	const refuse = () => {
		throw Object.assign(new Error('The universe server is on plain http. Only https, or an onion address, is used.'), {
			code: 'BAD_UNIVERSE',
			status: 400
		});
	};
	const r = await mount({ save: refuse });
	try {
		await click(r.test('asset-settings-custom'));
		// Left with nothing typed, the form says what is missing and asks nobody.
		await click(r.test('asset-settings-save'));
		assert.equal(r.test('asset-settings-problem').textContent, "Enter the proof server's host.");
		assert.deepEqual(r.saves, []);

		await type(r.test('asset-settings-host'), 'u.example.com');
		assert.equal(r.test('asset-settings-problem'), null, 'gone once the field is touched');
		await click(r.test('asset-settings-save'));
		await settle(20);
		const problem = r.test('asset-settings-problem');
		assert.equal(problem.getAttribute('role'), 'alert');
		assert.equal(problem.textContent, 'The universe server is on plain http. Only https, or an onion address, is used.');
		assert.deepEqual(r.done, [], 'not closed, and not reported as saved');
		assert.equal(r.$('.toast'), null);
		assert.equal(r.test('asset-settings-save').disabled, false, 'and Save can be pressed again');
	} finally {
		await r.unmount();
	}
});
