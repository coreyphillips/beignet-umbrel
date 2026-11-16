/**
 * A wallet's assets backend for a component test: the demo's own
 * (src/mock/mockAssets.js), with the clock in the test's hand.
 *
 * Nothing moves by itself. `pass(ms)` moves the time on and lets every row
 * catch up with it, so a mint is taken from broadcast to ready in as many
 * steps as a test wants to look at, and takes no real time to get there.
 * Nothing is stored either: each backend starts from the demo's seed.
 */
import { act, createElement, useState } from 'react';
import { createAssetsMock } from '../src/mock/mockAssets.js';
import { ToastProvider } from '../src/components/Toast.jsx';
import AssetsTab from '../src/pages/tabs/AssetsTab.jsx';
import { click, render, settle } from './render.mjs';

export const FEES = { fast: 18, normal: 7, slow: 2 };

/** The demo wallets the seed knows by name, as wallet records. */
export const WALLETS = [
	{ id: 'demo-main', name: 'Main', network: 'mainnet' },
	{ id: 'demo-witness', name: 'Witness', network: 'mainnet' },
	{ id: 'demo-fresh', name: 'Fresh', network: 'mainnet' },
	{ id: 'demo-savings', name: 'Savings', network: 'mainnet', onchainOnly: true },
	{ id: 'demo-testnet', name: 'Testnet', network: 'testnet' },
	{ id: 'demo-lfbw', name: 'Lightning first', network: 'mainnet', lfbw: { enabled: true } }
];

export function assetsBackend({ wallets = WALLETS, spendable = 500_000, lightning = true, priced = true } = {}) {
	// From now, like the pages that read it: "3 days ago" is worked out against
	// the real clock, so the backend's past has to be the real past.
	let t = Date.now();
	const coins = new Map();
	const events = [];
	const calls = [];
	const sats = (id) => (coins.has(id) ? coins.get(id) : typeof spendable === 'function' ? spendable(id) : spendable);
	const mock = createAssetsMock({
		wallets: () => wallets,
		spendable: sats,
		spend: (id, amount) => coins.set(id, Math.max(0, sats(id) - amount)),
		height: () => 870_000,
		fees: () => FEES,
		emit: (id, name, data) => events.push({ id, name, data }),
		storage: null,
		clock: () => t,
		ticker: false,
		lightning,
		// False for a wallet whose channel peers are other wallets, which set no price.
		priced
	});

	/** What walletApi(id) is to a tab: get and post, answered by the backend. */
	function api(id) {
		const ask = async (method, path, body, options) => {
			const [route, query = ''] = path.split('?');
			calls.push({ id, method, route, query, body: body || null, headers: (options && options.headers) || null });
			if (route === '/fees/estimates') return FEES;
			const answer = await mock.request(id, route, query, method, body, options && options.headers);
			if (answer === undefined) throw Object.assign(new Error(`No such route: ${method} ${route}`), { code: 'NOT_FOUND', status: 404 });
			// Through JSON, as over the wire: nothing the backend keeps can be
			// changed by what a component does with its answer.
			return JSON.parse(JSON.stringify(answer));
		};
		return {
			get: (path) => ask('GET', path),
			post: (path, body, options) => ask('POST', path, body, options),
			del: (path) => ask('DELETE', path),
			eventsUrl: `/events/${id}`
		};
	}

	return {
		mock,
		api,
		wallets,
		events,
		calls,
		now: () => t,
		/** Move the time on, and every row with it. */
		pass(ms) {
			t += ms;
			mock.advance();
		},
		setSpendable: (id, amount) => coins.set(id, amount),
		/** The routes asked for so far, as "POST /x/assets/mint". */
		asked: (id) => calls.filter((c) => !id || c.id === id).map((c) => `${c.method} ${c.route}`),
		/** The bodies posted to one route, oldest first. */
		posted: (route, id) => calls.filter((c) => c.method === 'POST' && c.route === `/x/assets${route}` && (!id || c.id === id))
	};
}

// Longer than a view's exit and entrance, after which the next one is on the page.
export const VIEW_CHANGE_MS = 450;

/**
 * Follow a link the page handles itself. The press can be cancelled, as a
 * real one can, so the page's own handler is what moves and nothing tries to
 * leave the document.
 */
export async function follow(element) {
	await act(async () => {
		element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
	});
	await settle(VIEW_CHANGE_MS);
}

/**
 * The Assets tab over a backend, as the wallet page mounts it: inside the
 * toasts, with the wallet's record and the app's config, and a `tick` that
 * re-asks everything. There is no event stream here, so after time passes the
 * page is told to ask again, which is what the event would have done.
 */
export async function mountAssets(
	backend,
	id,
	{ api: given, config = { assetsAvailable: true, assetChannelsAvailable: true }, rec, health = { electrumConnected: true }, at = null, props = {} } = {}
) {
	const api = given || backend.api(id);
	const record = rec || (backend ? backend.wallets.find((w) => w.id === id) : { id, network: 'mainnet' });
	let bump = () => {};
	// Where the tab asked the wallet page to go, as [tab, options].
	const moves = [];
	function Page() {
		const [tick, setTick] = useState(0);
		const [query, setQuery] = useState(at || {});
		bump = () => setTick((n) => n + 1);
		// With `at`, the tab is given an address to keep its place in, as the
		// wallet page gives it one. Without, it keeps its place itself.
		const routed = at
			? {
					route: { query, state: null },
					go: (to, options) => {
						moves.push([to, options || {}]);
						if (to === 'assets') setQuery((options && options.query) || {});
					}
				}
			: {};
		return createElement(
			ToastProvider,
			null,
			createElement(AssetsTab, { id, api, rec: record, info: null, health, tick, bump, config, ...routed, ...props })
		);
	}
	const r = await render(Page, {});
	await settle(20);
	const refresh = async () => {
		await act(async () => bump());
		await settle(20);
	};
	return {
		...r,
		api,
		moves,
		refresh,
		/** Let time pass in the wallet, and the page hear about it. */
		async pass(ms) {
			backend.pass(ms);
			await refresh();
		},
		/** The toasts on screen, as their text. */
		toasts: () => r.$$('.toast').map((t) => t.textContent),
		/** Press one of the four views in the bar. */
		async view(label) {
			const pill = r.$$('.assets-bar .pill').find((b) => b.textContent === label);
			if (!pill) throw new Error(`No view called ${label}`);
			await click(pill);
			await settle(VIEW_CHANGE_MS);
		},
		test: (name) => r.$(`[data-testid="${name}"]`),
		tests: (name) => r.$$(`[data-testid="${name}"]`)
	};
}
