'use strict';

const dns = require('dns').promises;

/**
 * Source-restricts the manager's HTTP API to Umbrel's app_proxy.
 *
 * The manager listens on 0.0.0.0 on Umbrel's shared app network, where every
 * installed app can reach it by name/IP. Umbrel's app_proxy (which fronts the
 * browser with single sign-on) is the only component that should ever call the
 * manager: it terminates the browser connection and opens a fresh proxied
 * connection, so legitimate requests arrive with app_proxy's own container IP
 * as their TCP source. This guard rejects any request whose source is neither
 * app_proxy nor loopback, so a co-installed (or compromised) app on the shared
 * network cannot drive the wallet API (including the fund-moving proxied daemon
 * routes) directly, bypassing app_proxy's SSO.
 *
 * It leans on the real TCP peer (req.socket.remoteAddress), never a spoofable
 * X-Forwarded-For header. app_proxy is resolved by Docker DNS and re-resolved
 * periodically because its IP can change across restarts; {all:true} captures
 * every network the container is on, so whichever IP the connection actually
 * uses is covered.
 *
 * Safeguards against ever locking the user out of their own wallet:
 *  - Set BEIGNET_TRUST_ALL=1 to disable the guard entirely.
 *  - Until app_proxy resolves at least once, the guard fails open (allows) so a
 *    transient DNS problem cannot brick the dashboard.
 */

// app_proxy is reachable under a few app-scoped names depending on the umbrelOS
// version and container-name scheme (underscore vs hyphen). We resolve all of
// them and never the bare "app_proxy": that alias is shared by every app on the
// network, so it would be ambiguous. APP_PROXY_HOST overrides with a single name.
const APP_ID = 'beignet-wallet';
const PROXY_HOSTS = process.env.APP_PROXY_HOST
	? [process.env.APP_PROXY_HOST]
	: [`app_proxy_${APP_ID}`, `${APP_ID}_app_proxy_1`, `${APP_ID}-app_proxy-1`];
const REFRESH_MS = 60 * 1000;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

function normalizeIp(ip) {
	if (!ip) return ip;
	// Strip an IPv4-mapped IPv6 prefix (::ffff:10.21.0.5 -> 10.21.0.5).
	return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

function isEnabled() {
	const v = String(process.env.BEIGNET_TRUST_ALL || '').toLowerCase();
	return !(v === '1' || v === 'true');
}

function createAccessGuard({ log = () => {} } = {}) {
	if (!isEnabled()) {
		log('access-control: BEIGNET_TRUST_ALL set; manager API is not source-restricted');
		return (req, res, next) => next();
	}

	let allowed = new Set();
	let everResolved = false;
	let warnedFailOpen = false;

	async function refresh() {
		const next = new Set();
		for (const host of PROXY_HOSTS) {
			try {
				const results = await dns.lookup(host, { all: true });
				for (const r of results) next.add(normalizeIp(r.address));
			} catch (_) {
				/* this name is not resolvable on this system; try the others */
			}
		}
		if (next.size) {
			allowed = next;
			if (!everResolved) {
				log(`access-control: restricting manager API to app_proxy (${[...next].join(', ')}) and loopback`);
			}
			everResolved = true;
		}
		/* if none resolved, keep the last good set (or stay fail-open until first) */
	}

	refresh();
	const timer = setInterval(refresh, REFRESH_MS);
	if (timer.unref) timer.unref();

	return function accessGuard(req, res, next) {
		const ip = normalizeIp(req.socket && req.socket.remoteAddress);
		if (LOOPBACK.has(ip) || allowed.has(ip)) return next();
		if (!everResolved) {
			// Never resolved app_proxy yet: allow, but warn once and keep trying,
			// so a resolution problem degrades to the old (open) behavior instead
			// of locking the user out.
			if (!warnedFailOpen) {
				log('access-control: app_proxy not resolved yet; allowing all sources until it resolves');
				warnedFailOpen = true;
			}
			refresh();
			return next();
		}
		// Re-resolve in case app_proxy's IP just changed; this request is judged
		// on the current set, the next one on the refreshed set.
		refresh();
		return res
			.status(403)
			.json({ ok: false, error: { code: 'FORBIDDEN', message: 'Forbidden' } });
	};
}

module.exports = { createAccessGuard, normalizeIp };
