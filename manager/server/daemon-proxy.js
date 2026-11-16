'use strict';

/**
 * The reverse proxy between the dashboard and a wallet's own daemon.
 *
 * It relays a call as it came. The request body streams through untouched
 * (the proxy is mounted before the JSON body parser), so the manager adds
 * nothing to a call and takes nothing from it, and the daemon's answer goes
 * back as it is, a refusal's details included. An option such as
 * `omitAssetChannels` on POST /recovery/restore-capsule therefore reaches
 * the daemon only when the dashboard sent it, which it does for the one
 * call its user confirmed after reading the list of channels the daemon
 * refused over. The manager never sends it by itself.
 *
 * What the manager does with a failed call is write it in the wallet's
 * log, and a restore the engine refused over an asset channel is written
 * there in the manager's own sentence.
 */
const { createProxyMiddleware } = require('http-proxy-middleware');
const { releaseUpstreamOnClose } = require('./proxy-release');
const { ENGINE_ASSET_REFUSALS } = require('./wallet-manager');

// Cap on how much of a failed daemon response is buffered before logging it.
// Error bodies are small; this only stops a large one from being held in memory.
const MAX_LOGGED_BODY = 8192;

// The daemon's two restores: from the guardians, and from a checkpoint a
// storage peer returned.
const RESTORE_ROUTE = /^\/recovery\/restore(-capsule)?(\?.*)?$/;
// What the engine refuses a restore with over an asset channel, in the
// manager's sentences. ASSET_PROVIDER_REQUIRED is worded for a restore
// here: the table's own sentence for it is about a wallet that was not
// started.
const RESTORE_REFUSALS = {
	ASSET_RESTORE_REFUSED: ENGINE_ASSET_REFUSALS.ASSET_RESTORE_REFUSED,
	AUXILIARY_GUARDIAN_RESTORE_REFUSED: ENGINE_ASSET_REFUSALS.AUXILIARY_GUARDIAN_RESTORE_REFUSED,
	ASSET_PROVIDER_REQUIRED:
		'The channel state that was to be restored holds an asset channel, and the assets part of this wallet is not running to take it, so nothing was restored and nothing was written. The wallet is as it was.'
};

/**
 * The line the wallet's log gets for a daemon call that failed. A restore
 * refused over an asset channel is said in the manager's sentence, with
 * how many channels the refusal names when it names them (a capsule
 * restore can then be run again without them, from the wallet's page).
 * Anything else is the daemon's own message, as before.
 */
function daemonFailureLine(method, route, status, error) {
	const err = error && typeof error === 'object' ? error : {};
	const code = typeof err.code === 'string' ? err.code : '';
	const restore = RESTORE_ROUTE.test(String(route || ''));
	const said = restore && Object.prototype.hasOwnProperty.call(RESTORE_REFUSALS, code) ? RESTORE_REFUSALS[code] : err.message || '';
	const named = restore && said !== (err.message || '') && err.details && Array.isArray(err.details.assetChannels) ? err.details.assetChannels.length : 0;
	const more = named > 0 ? ` The refusal names ${named} asset channel${named === 1 ? '' : 's'}, and the restore can be run without ${named === 1 ? 'it' : 'them'} from the wallet's page.` : '';
	return `${method} ${route} failed [${code || status}] ${said}${more}`.trim();
}

/** The proxy middleware, for mounting under /wallets/:id/api. */
function createDaemonProxy(manager) {
	return createProxyMiddleware({
		target: 'http://127.0.0.1:1',
		changeOrigin: true,
		ws: false,
		logLevel: 'warn',
		router: (req) => manager.target(req.params.id),
		// Strip the /wallets/:id/api mount prefix so the daemon sees its own
		// routes (e.g. /info, /balance, /events). Anchored at the start, so
		// query strings and already-stripped paths are left intact.
		pathRewrite: { '^/wallets/[^/]+/api': '' },
		onProxyReq: (proxyReq, req, res) => {
			try {
				proxyReq.setHeader('Authorization', `Bearer ${manager.token(req.params.id)}`);
			} catch (_) {
				/* token missing; daemon will reject */
			}
			// Without this a closed wallet page leaves its /events stream open at
			// the daemon, which caps them (see proxy-release.js).
			releaseUpstreamOnClose(proxyReq, req, res);
		},
		// Record failed daemon calls in the wallet's log. The daemon answers a
		// rejected action (a peer that will not complete the handshake, a channel
		// it will not open) to the browser that asked and nowhere else, so the
		// failure never reached the Logs tab and the tab looked empty at exactly
		// the moment someone went looking. Only errors are recorded, so a working
		// wallet does not fill its log with successful calls.
		onProxyRes: (proxyRes, req) => {
			const failed = proxyRes.statusCode >= 400;
			// Non-GETs are the actions worth reporting; they can also fail with a
			// 200 carrying {ok:false}, so their bodies are inspected either way.
			if (!failed && req.method === 'GET') return;
			if (!String(proxyRes.headers['content-type'] || '').includes('json')) return;
			let body = '';
			proxyRes.on('data', (chunk) => {
				if (body.length < MAX_LOGGED_BODY) body += chunk.toString('utf8');
			});
			proxyRes.on('end', () => {
				let parsed;
				try {
					parsed = JSON.parse(body);
				} catch (_) {
					return; // truncated or not JSON after all
				}
				if (!parsed || parsed.ok !== false) return;
				const err = parsed.error || {};
				const route = String(req.originalUrl || '').replace(/^\/wallets\/[^/]+\/api/, '');
				manager.recordLog(req.params.id, daemonFailureLine(req.method, route, proxyRes.statusCode, err));
			});
		},
		onError: (err, req, res) => {
			if (!res.headersSent) {
				res.status(502).json({
					ok: false,
					error: { code: 'PROXY_ERROR', message: err.message }
				});
			}
		}
	});
}

module.exports = { createDaemonProxy, daemonFailureLine, RESTORE_REFUSALS, MAX_LOGGED_BODY };
