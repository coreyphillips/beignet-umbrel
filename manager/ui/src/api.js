// Demo mode: serve every request from an in-memory mock (src/mock/mockApi.js)
// so the dashboard can be explored without a running manager/beignet backend.
// Enabled via VITE_DEMO=1, a ?demo query param, or sessionStorage (which keeps
// it on across client-side navigations that drop the query param).
if (new URLSearchParams(window.location.search).has('demo')) {
	sessionStorage.setItem('beignet-demo', '1');
}
export const DEMO =
	import.meta.env.VITE_DEMO === '1' || sessionStorage.getItem('beignet-demo') === '1';

async function request(path, { method = 'GET', body, timeoutMs, headers } = {}) {
	if (DEMO) return (await import('./mock/mockApi.js')).mockRequest(path, { method, body });
	let res;
	try {
		res = await fetch(path, {
			method,
			headers: body || headers ? { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } : undefined,
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

/**
 * A response that is a file rather than JSON (the backup archive). Errors
 * still come back as the usual JSON envelope, so they are read the same way.
 */
async function download(path, body) {
	if (DEMO) return (await import('./mock/mockApi.js')).mockDownload(path, body);
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	if (!res.ok) {
		let data = {};
		try {
			data = await res.json();
		} catch (_) {
			/* non-JSON */
		}
		const err = new Error((data.error && data.error.message) || `Request failed (${res.status})`);
		err.code = data.error && data.error.code;
		err.status = res.status;
		throw err;
	}
	const disposition = res.headers.get('content-disposition') || '';
	const named = /filename="([^"]+)"/.exec(disposition);
	return { blob: await res.blob(), filename: named ? named[1] : 'beignet-backup.beignet' };
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
	// Everything that is not on the chain (records, settings, seeds, tokens)
	// in one passphrase-encrypted archive, and the two halves of putting it
	// back: a preview that writes nothing, then the restore itself.
	exportBackup: (passphrase) => download('/api/backup/export', { passphrase }),
	inspectBackup: (passphrase, archive) =>
		request('/api/backup/inspect', { method: 'POST', body: { passphrase, archive } }),
	restoreBackup: (passphrase, archive, confirm) =>
		request('/api/backup/restore', { method: 'POST', body: { passphrase, archive, confirm } }),
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
		),
	// Direct fundings that degraded into an ordinary payment (umbrel #121).
	// Only the payer's browser sees both halves, so it is the one that reports
	// them; the Activity tab reads them back onto the payment they became.
	directFundingFallbacks: (id) => request(`/api/wallets/${id}/direct-funding/fallbacks`),
	recordDirectFundingFallback: (id, body) =>
		request(`/api/wallets/${id}/direct-funding/fallbacks`, { method: 'POST', body, timeoutMs: 5000 }),
	// The latest attempt to pay a direct-funding request, step by step (umbrel #147).
	directFundingSteps: (id, requestId) =>
		request(`/api/wallets/${id}/direct-funding/steps?requestId=${encodeURIComponent(requestId)}`, { timeoutMs: 10000 })
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
		// `headers` carries an X-Idempotency-Key for a write that may be asked
		// again after its answer was lost.
		post: (path, body, { headers } = {}) => request(base + path, { method: 'POST', body, headers }),
		// The daemon's removal routes take their target in the query string and
		// carry no body, so this takes a path already carrying it.
		del: (path) => request(base + path, { method: 'DELETE' }),
		eventsUrl: () => (DEMO ? `demo:${id}` : `${base}/events`)
	};
}
