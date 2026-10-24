/**
 * Run with: npm test (from manager/ui).
 *
 * The create and import form (umbrel #250): the basics in sight, every
 * Lightning-only option behind one collapsed "Advanced", and the same request
 * whether or not Advanced was ever opened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, select, type } from '../../test/render.mjs';
import { ToastProvider } from '../components/Toast.jsx';
import { NewWallet } from './WalletsPage.jsx';

const config = {
	defaultNetwork: 'mainnet',
	supportedNetworks: ['mainnet', 'testnet', 'regtest'],
	defaultElectrum: { host: 'umbrel.local', port: 50001, tls: false },
	electrumPresets: [],
	electrumTlsVerifyAvailable: true,
	torAvailable: true,
	torProxyScopeAvailable: true,
	irohAvailable: true,
	recoveryAvailable: true,
	recoveryGuardians: [],
	recoveryAutoApplyAvailable: true,
	guardianHostingAvailable: true,
	lfbwAvailable: true,
	fforAvailable: true
};

// What a Lightning wallet posted before Advanced existed, left at its defaults.
const DEFAULTS = {
	networkMode: 'hybrid',
	iroh: { enabled: false },
	publicHost: '',
	announce: false,
	onchainOnly: false,
	recoveryMode: 'off',
	guardianServe: false,
	ffor: { settle: { enabled: false }, witness: { enabled: false }, issuer: { enabled: false } },
	lfbw: { enabled: false }
};

async function open(refuse = null) {
	const posts = [];
	const fetchBefore = globalThis.fetch;
	globalThis.fetch = async (path, options) => {
		const body = JSON.parse(options.body);
		posts.push({ path, method: options.method, body });
		if (refuse && !body.allowChainMismatch) {
			return { ok: false, status: 400, json: async () => ({ ok: false, error: refuse }) };
		}
		const result =
			path === '/api/wallets'
				? { record: { id: 'w1', name: body.name }, mnemonic: 'abandon ability able' }
				: { record: { id: 'w1', name: body.name } };
		return { ok: true, json: async () => ({ ok: true, result }) };
	};
	const r = await render((props) => createElement(ToastProvider, null, createElement(NewWallet, props)), {
		config,
		wallets: [],
		onDone() {},
		onSeed() {},
		onOpen() {}
	});
	return {
		...r,
		posts,
		unmount: async () => {
			await r.unmount();
			globalThis.fetch = fetchBefore;
		}
	};
}

const advanced = (r) => r.$('[data-testid="new-wallet-advanced"]');
const field = (r, label) =>
	r.$$('label.field').find((l) => l.querySelector(':scope > .field-label')?.firstChild?.textContent === label);
const checkbox = (r, text) =>
	r.$$('label.checkbox').find((l) => l.textContent.includes(text)).querySelector('input');
const button = (r, text) => r.$$('button.btn').find((b) => b.textContent.trim() === text);
const pill = (r, label) => r.$$('button.pill').find((b) => b.textContent.trim() === label);
// jsdom keeps a closed disclosure's content in the DOM, so "out of sight" is
// "inside a closed <details>".
const hidden = (el) => !!el.closest('details:not([open])');

const setOpen = (r, isOpen) => {
	advanced(r).open = isOpen;
};

test('the create form opens with the basics in sight and the Lightning options collapsed', async () => {
	const r = await open();
	try {
		const adv = advanced(r);
		assert.ok(adv, 'the Advanced disclosure is there');
		assert.equal(adv.open, false, 'and collapsed');
		assert.equal(adv.querySelector(':scope > summary').textContent, 'Advanced');

		for (const label of ['Name', 'Network', 'Seed length']) {
			const f = field(r, label);
			assert.ok(f, `${label} is rendered`);
			assert.equal(adv.contains(f), false, `${label} stays outside Advanced`);
		}
		for (const text of ['Use a different Electrum server', 'On-chain only']) {
			assert.equal(adv.contains(checkbox(r, text)), false, `${text} stays outside Advanced`);
		}
		assert.equal(adv.contains(button(r, 'Create wallet')), false);

		for (const id of ['recovery-mode', 'guardian-serve', 'ffor-settle', 'announce', 'iroh-enabled']) {
			const el = r.$(`[data-testid="${id}"]`);
			assert.ok(el, `${id} is rendered`);
			assert.ok(adv.contains(el), `${id} is inside Advanced`);
			assert.ok(hidden(el), `${id} is out of sight`);
		}
		assert.ok(adv.contains(checkbox(r, 'Make this a lightning-first wallet')));
		for (const label of ['Tor', 'Clearnet', 'Hybrid']) assert.ok(adv.contains(pill(r, label)));

		// The order inside is the order the form always had.
		const order = ['recovery-mode', 'guardian-serve', 'ffor-settle', 'announce'].map((id) =>
			r.$(`[data-testid="${id}"]`)
		);
		for (let i = 1; i < order.length; i++) {
			assert.ok(order[i - 1].compareDocumentPosition(order[i]) & globalThis.Node.DOCUMENT_POSITION_FOLLOWING);
		}
	} finally {
		await r.unmount();
	}
});

test('the Electrum fields and the chain refusal open in place, outside Advanced', async () => {
	const r = await open({
		code: 'ELECTRUM_WRONG_CHAIN',
		message: 'The Electrum server at testnet.example:50002 serves testnet, but this wallet is on mainnet.',
		details: { host: 'testnet.example', port: 50002, chain: 'testnet', network: 'mainnet' }
	});
	try {
		await click(checkbox(r, 'Use a different Electrum server'));
		const host = r.$('input[placeholder^="192.168"]');
		assert.ok(host, 'the Electrum fields are expanded');
		assert.equal(advanced(r).contains(host), false);

		await type(host, 'testnet.example');
		await click(button(r, 'Create wallet'));
		const note = r.$('[data-testid="electrum-wrong-chain"]');
		const anyway = r.$('[data-testid="electrum-save-anyway"]');
		assert.ok(note && anyway, 'the refusal offers a way through');
		assert.equal(advanced(r).contains(note), false);
		assert.equal(advanced(r).contains(anyway), false);
		await click(anyway);
		assert.equal(r.posts.at(-1).body.allowChainMismatch, true);
	} finally {
		await r.unmount();
	}
});

test('the import form keeps the recovery phrase in sight and drops the seed length', async () => {
	const r = await open();
	try {
		await click(pill(r, 'Import wallet'));
		const phrase = field(r, 'Recovery phrase');
		assert.ok(phrase);
		assert.equal(advanced(r).contains(phrase), false);
		assert.equal(field(r, 'Seed length'), undefined);
		assert.equal(r.$('[data-testid="recovery-auto-apply"]'), null);

		await select(r.$('[data-testid="recovery-mode"]'), 'peer-storage');
		const autoApply = r.$('[data-testid="recovery-auto-apply"]');
		assert.ok(autoApply, 'peer storage asks whether to apply the checkpoint by itself');
		assert.ok(advanced(r).contains(autoApply));
	} finally {
		await r.unmount();
	}
});

test('creating without opening Advanced posts the same defaults as before', async () => {
	const r = await open();
	try {
		await type(field(r, 'Name').querySelector('input'), 'Alpha');
		await click(button(r, 'Create wallet'));
		assert.equal(r.posts.length, 1);
		assert.equal(r.posts[0].path, '/api/wallets');
		assert.deepEqual(r.posts[0].body, { name: 'Alpha', network: 'mainnet', wordCount: 24, ...DEFAULTS });
	} finally {
		await r.unmount();
	}
});

test('importing without opening Advanced posts the same defaults as before', async () => {
	const r = await open();
	try {
		await click(pill(r, 'Import wallet'));
		await type(field(r, 'Name').querySelector('input'), 'Beta');
		await type(r.$('textarea'), 'abandon ability able');
		await click(button(r, 'Import wallet'));
		assert.equal(r.posts.length, 1);
		assert.equal(r.posts[0].path, '/api/wallets/import');
		assert.deepEqual(r.posts[0].body, {
			name: 'Beta',
			network: 'mainnet',
			mnemonic: 'abandon ability able',
			...DEFAULTS
		});
	} finally {
		await r.unmount();
	}
});

test('choices made in Advanced survive collapsing it and are posted', async () => {
	const r = await open();
	try {
		await type(field(r, 'Name').querySelector('input'), 'Gamma');
		setOpen(r, true);
		await click(pill(r, 'Clearnet'));
		await type(r.$('[data-testid="public-host"]'), 'node.example.com');
		await select(r.$('[data-testid="recovery-mode"]'), 'peer-storage');
		setOpen(r, false);
		assert.equal(advanced(r).open, false);

		await click(button(r, 'Create wallet'));
		assert.equal(r.posts.length, 1);
		const body = r.posts[0].body;
		assert.equal(body.networkMode, 'clearnet');
		assert.equal(body.publicHost, 'node.example.com');
		assert.equal(body.recoveryMode, 'peer-storage');
	} finally {
		await r.unmount();
	}
});

test('on-chain only leaves nothing to put under Advanced, so it is not rendered', async () => {
	const r = await open();
	try {
		await click(checkbox(r, 'On-chain only'));
		assert.equal(advanced(r), null);
		assert.equal(r.$('[data-testid="recovery-mode"]'), null);
		await click(checkbox(r, 'On-chain only'));
		assert.ok(advanced(r), 'and it comes back with Lightning');
	} finally {
		await r.unmount();
	}
});

test('a disabled button says why, outside Advanced, when the reason is inside it', async () => {
	const r = await open();
	try {
		assert.equal(r.$('[data-testid="new-wallet-blocked"]'), null);
		assert.equal(button(r, 'Create wallet').disabled, false);

		setOpen(r, true);
		await click(checkbox(r, 'Make this a lightning-first wallet'));
		setOpen(r, false);
		assert.equal(button(r, 'Create wallet').disabled, true);
		let note = r.$('[data-testid="new-wallet-blocked"]');
		assert.ok(note);
		assert.equal(hidden(note), false);
		assert.match(note.textContent, /Lightning-first needs a primary node.*Advanced/);

		setOpen(r, true);
		await click(checkbox(r, 'Make this a lightning-first wallet'));
		await click(pill(r, 'Clearnet'));
		setOpen(r, false);
		assert.equal(button(r, 'Create wallet').disabled, true);
		note = r.$('[data-testid="new-wallet-blocked"]');
		assert.equal(hidden(note), false);
		assert.match(note.textContent, /Clearnet needs a public address.*Advanced/);

		setOpen(r, true);
		await type(r.$('[data-testid="public-host"]'), 'node.example.com');
		assert.equal(button(r, 'Create wallet').disabled, false);
		assert.equal(r.$('[data-testid="new-wallet-blocked"]'), null);

		// On-chain only ignores both, as it always has.
		await type(r.$('[data-testid="public-host"]'), '');
		await click(checkbox(r, 'On-chain only'));
		assert.equal(button(r, 'Create wallet').disabled, false);
		assert.equal(r.$('[data-testid="new-wallet-blocked"]'), null);
	} finally {
		await r.unmount();
	}
});
