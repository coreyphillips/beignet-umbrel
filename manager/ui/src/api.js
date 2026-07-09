// Demo mode: serve every request from an in-memory mock (src/mock/mockApi.js)
// so the dashboard can be explored without a running manager/beignet backend.
// Enabled via VITE_DEMO=1, a ?demo query param, or sessionStorage (which keeps
// it on across client-side navigations that drop the query param).
if (new URLSearchParams(window.location.search).has('demo')) {
	sessionStorage.setItem('beignet-demo', '1');
}
export const DEMO =
	import.meta.env.VITE_DEMO === '1' || sessionStorage.getItem('beignet-demo') === '1';

async function request(path, { method = 'GET', body } = {}) {
	if (DEMO) return (await import('./mock/mockApi.js')).mockRequest(path, { method, body });
	const res = await fetch(path, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined
	});
	let data = {};
	try {
		data = await res.json();
	} catch (_) {
		/* non-JSON */
	}
	if (!res.ok || data.ok === false) {
		const err = new Error((data.error && data.error.message) || `Request failed (${res.status})`);
		err.code = data.error && data.error.code;
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
	logs: (id) => request(`/api/wallets/${id}/logs`)
};

// Per-wallet beignet daemon API (proxied; bearer token injected server-side)
export function walletApi(id) {
	const base = `/wallets/${id}/api`;
	return {
		get: (path) => request(base + path),
		post: (path, body) => request(base + path, { method: 'POST', body }),
		eventsUrl: () => (DEMO ? `demo:${id}` : `${base}/events`)
	};
}
