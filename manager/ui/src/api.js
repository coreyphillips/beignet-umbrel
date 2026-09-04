// Demo mode: serve every request from an in-memory mock (src/mock/mockApi.js)
// so the dashboard can be explored without a running manager/beignet backend.
// Enabled via VITE_DEMO=1, a ?demo query param, or sessionStorage (which keeps
// it on across client-side navigations that drop the query param).
if (new URLSearchParams(window.location.search).has('demo')) {
	sessionStorage.setItem('beignet-demo', '1');
}
export const DEMO =
	import.meta.env.VITE_DEMO === '1' || sessionStorage.getItem('beignet-demo') === '1';

async function request(path, { method = 'GET', body, timeoutMs } = {}) {
	if (DEMO) return (await import('./mock/mockApi.js')).mockRequest(path, { method, body });
	let res;
	try {
		res = await fetch(path, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined
		});
	} catch (e) {
		if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
			const err = new Error('Wallet is not responding');
			err.code = 'WALLET_UNRESPONSIVE';
			throw err;
		}
		throw e;
	}
	let data = {};
	try {
		data = await res.json();
	} catch (_) {
		/* non-JSON */
	}
	if (!res.ok || data.ok === false) {
		const err = new Error((data.error && data.error.message) || `Request failed (${res.status})`);
		err.code = data.error && data.error.code;
		// The HTTP status rides along for the one case a route's absence is
		// an answer: a 404 from a daemon that predates a feature.
		err.status = res.status;
		// Structured context on a refusal (which wallets depend on a primary).
		err.details = (data.error && data.error.details) || null;
		throw err;
	}
	return data.result;
}

// Manager (control plane) API
export const manager = {
	config: () => request('/api/config'),
	getSettings: () => request('/api/settings'),
	updateSettings: (body) => request('/api/settings', { method: 'PUT', body }),
	listWallets: () => request('/api/wallets'),
	getWallet: (id) => request(`/api/wallets/${id}`),
	createWallet: (body) => request('/api/wallets', { method: 'POST', body }),
	importWallet: (body) => request('/api/wallets/import', { method: 'POST', body }),
	updateWallet: (id, body) => request(`/api/wallets/${id}`, { method: 'PATCH', body }),
	startWallet: (id) => request(`/api/wallets/${id}/start`, { method: 'POST' }),
	stopWallet: (id) => request(`/api/wallets/${id}/stop`, { method: 'POST' }),
	deleteWallet: (id, purge) =>
		request(`/api/wallets/${id}${purge ? '?purge=true' : ''}`, { method: 'DELETE' }),
	logs: (id) => request(`/api/wallets/${id}/logs`),
	// Re-run a lightning-first wallet's setup with its primary node.
	lfbwSetup: (id) => request(`/api/wallets/${id}/lfbw/setup`, { method: 'POST' }),
	// One channelize pass now, past the fee wait ("Move now anyway").
	lfbwChannelize: (id) => request(`/api/wallets/${id}/lfbw/channelize`, { method: 'POST' }),
	// Close the channel with the previous primary so its funds move home.
	lfbwMoveHome: (id) => request(`/api/wallets/${id}/lfbw/move-home`, { method: 'POST' }),
	// Close the home channel, optionally turning lightning-first off first.
	lfbwCloseHome: (id, body) => request(`/api/wallets/${id}/lfbw/close-home`, { method: 'POST', body }),
	// A beignet node's Lightning URI to a guardian entry, asked through any
	// running wallet's daemon (beignet #699). Adopts nothing.
	resolveGuardian: (uri) => request('/api/recovery/resolve-guardian', { method: 'POST', body: { uri } }),
	// The wallets on this Umbrel that serve as guardians, with their addresses.
	guardianCandidates: () => request('/api/guardians/candidates'),
	// Move a wallet to a new guardian set with its channels running (beignet #701).
	rotateGuardians: (id, guardians) =>
		request(`/api/wallets/${id}/recovery/rotate`, { method: 'POST', body: { guardians } }),
	errors: (id, since) =>
		request(`/api/wallets/${id}/errors${since ? `?since=${since}` : ''}`),
	channelEvents: (id, channelId) =>
		request(
			`/api/wallets/${id}/channel-events${channelId ? `?channelId=${channelId}` : ''}`
		)
};

// Per-wallet beignet daemon API (proxied; bearer token injected server-side).
// Reads carry a timeout because a deadlocked daemon holds the socket open
// without answering, and a page that awaits it without one shows skeletons
// forever for every wallet, not just the sick one. Writes stay unbounded:
// channel opens and payments legitimately take long, and cutting them off
// client-side would abandon an action the daemon may still complete.
const DAEMON_READ_TIMEOUT_MS = 10000;
export function walletApi(id) {
	const base = `/wallets/${id}/api`;
	return {
		get: (path) => request(base + path, { timeoutMs: DAEMON_READ_TIMEOUT_MS }),
		post: (path, body) => request(base + path, { method: 'POST', body }),
		// The daemon's removal routes take their target in the query string and
		// carry no body, so this takes a path already carrying it.
		del: (path) => request(base + path, { method: 'DELETE' }),
		eventsUrl: () => (DEMO ? `demo:${id}` : `${base}/events`)
	};
}
