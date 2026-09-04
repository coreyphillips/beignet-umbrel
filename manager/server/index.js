'use strict';

const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { config, SUPPORTED_NETWORKS, ELECTRUM_PRESETS } = require('./config');
const { WalletManager } = require('./wallet-manager');
const { createAccessGuard } = require('./access-control');

// Cap on how much of a failed daemon response is buffered before logging it.
// Error bodies are small; this only stops a large one from being held in memory.
const MAX_LOGGED_BODY = 8192;

function asyncHandler(fn) {
	return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function swaggerAssetsPath() {
	try {
		return require('swagger-ui-dist').getAbsoluteFSPath();
	} catch (_) {
		return null;
	}
}

async function main() {
	const manager = new WalletManager();
	await manager.init();

	const app = express();
	app.disable('x-powered-by');

	// Restrict the API to Umbrel's app_proxy (which fronts the browser with SSO)
	// and loopback, so other apps on the shared network cannot reach the wallet
	// control plane directly. Mounted first so it covers every route below.
	app.use(createAccessGuard({ log: (m) => console.log(m) }));

	// --- Reverse proxy to the per-wallet beignet daemons. Mounted BEFORE the
	// JSON body parser so request bodies (e.g. POST /send) stream through intact.
	const proxy = createProxyMiddleware({
		target: 'http://127.0.0.1:1',
		changeOrigin: true,
		ws: false,
		logLevel: 'warn',
		router: (req) => manager.target(req.params.id),
		// Strip the /wallets/:id/api mount prefix so the daemon sees its own
		// routes (e.g. /info, /balance, /events). Anchored at the start, so
		// query strings and already-stripped paths are left intact.
		pathRewrite: { '^/wallets/[^/]+/api': '' },
		onProxyReq: (proxyReq, req) => {
			try {
				proxyReq.setHeader('Authorization', `Bearer ${manager.token(req.params.id)}`);
			} catch (_) {
				/* token missing; daemon will reject */
			}
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
				manager.recordLog(
					req.params.id,
					`${req.method} ${route} failed [${err.code || proxyRes.statusCode}] ${
						err.message || ''
					}`.trim()
				);
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

	app.use('/wallets/:id/api', (req, res, next) => {
		if (!manager.target(req.params.id)) {
			return res
				.status(404)
				.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } });
		}
		if (!manager.runtimeState(req.params.id).proc) {
			return res
				.status(503)
				.json({ ok: false, error: { code: 'NOT_RUNNING', message: 'Wallet is not running' } });
		}
		return proxy(req, res, next);
	});

	app.use(express.json({ limit: '1mb' }));

	// --- Management API ---
	const api = express.Router();

	api.get('/health', (req, res) => res.json({ ok: true, result: { status: 'ok' } }));

	api.get('/config', (req, res) => {
		const settings = manager.getSettings();
		res.json({
			ok: true,
			result: {
				defaultNetwork: settings.defaultNetwork,
				defaultElectrum: settings.defaultElectrum,
				hasDefaultElectrum: !!settings.defaultElectrum,
				supportedNetworks: SUPPORTED_NETWORKS,
				electrumPresets: ELECTRUM_PRESETS,
				torAvailable: !!config.torProxy,
				onionAvailable: manager.onionAvailable(),
				// Channel backup (the Recovery Protocol) needs an engine that
				// carries its surface; older engines get no controls for it.
				engineVersion: manager.engineVersion,
				recoveryAvailable: manager.recoveryAvailable(),
				recoveryGuardians: settings.recoveryGuardians,
				// Lightning-first wallets need JIT receive and direct funding,
				// which the engine gained after 0.9.3; probed on the bundle.
				lfbwAvailable: manager.lfbwAvailable(),
				// A fee quote before a just-in-time invoice exists (beignet
				// #687) and the daemon applying a peer-storage checkpoint by
				// itself (beignet #690), both probed on the bundle.
				jitQuoteAvailable: manager.jitQuoteAvailable(),
				recoveryAutoApplyAvailable: manager.recoveryAutoApplyAvailable(),
				// Wallets hosting a guardian for other beignet nodes, and node
				// URIs resolving to guardian entries (beignet #699).
				guardianHostingAvailable: manager.guardianHostingAvailable(),
				// A wallet moving to a new guardian set with its channels running
				// (beignet #701).
				guardianRotationAvailable: manager.guardianRotationAvailable()
			}
		});
	});

	api.get('/settings', (req, res) =>
		res.json({ ok: true, result: manager.getSettings() })
	);

	api.put(
		'/settings',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: manager.updateSettings(req.body || {}) });
		})
	);

	// A beignet node's Lightning URI to a guardian entry, asked through any
	// running Lightning wallet's daemon; adopts nothing (beignet #699).
	api.post(
		'/recovery/resolve-guardian',
		asyncHandler(async (req, res) => {
			const { uri } = req.body || {};
			res.json({ ok: true, result: await manager.resolveGuardianUri(uri) });
		})
	);

	// The wallets on this Umbrel that serve as guardians, with the addresses
	// to reach them at.
	api.get('/guardians/candidates', (req, res) =>
		res.json({ ok: true, result: manager.guardianCandidates() })
	);

	api.get('/wallets', (req, res) => res.json({ ok: true, result: manager.list() }));

	api.post(
		'/wallets',
		asyncHandler(async (req, res) => {
			const { record, mnemonic } = await manager.createWallet(req.body || {});
			res.json({ ok: true, result: { record, mnemonic } });
		})
	);

	api.post(
		'/wallets/import',
		asyncHandler(async (req, res) => {
			const { record } = await manager.importWallet(req.body || {});
			res.json({ ok: true, result: { record } });
		})
	);

	api.get('/wallets/:id', (req, res) => {
		const record = manager.publicRecord(req.params.id);
		if (!record) {
			return res
				.status(404)
				.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } });
		}
		res.json({ ok: true, result: record });
	});

	api.patch(
		'/wallets/:id',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.updateWallet(req.params.id, req.body || {}) });
		})
	);

	api.post(
		'/wallets/:id/start',
		asyncHandler(async (req, res) => {
			await manager.startWallet(req.params.id);
			res.json({ ok: true, result: manager.publicRecord(req.params.id) });
		})
	);

	api.post(
		'/wallets/:id/stop',
		asyncHandler(async (req, res) => {
			await manager.stopWallet(req.params.id);
			res.json({ ok: true, result: manager.publicRecord(req.params.id) });
		})
	);

	api.delete(
		'/wallets/:id',
		asyncHandler(async (req, res) => {
			await manager.deleteWallet(req.params.id, { purge: req.query.purge === 'true' });
			res.json({ ok: true, result: { deleted: true } });
		})
	);

	// Re-run a lightning-first wallet's setup (trust, direct-funding policy,
	// peer connection, the first channel). It runs by itself on every start;
	// this is the dashboard's Retry after a failure.
	api.post(
		'/wallets/:id/lfbw/setup',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.setupLfbw(req.params.id) });
		})
	);

	// One channelize pass now, skipping the fee wait: the dashboard's
	// "Move now anyway" for a deposit the owner wants in Lightning at any
	// price. The channel minimums still hold.
	api.post(
		'/wallets/:id/lfbw/channelize',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.channelizeNow(req.params.id) });
		})
	);

	// Re-pointing the primary leaves the old home channel open (umbrel #86):
	// this closes it cooperatively so channelize can carry the funds into the
	// new one once the payout confirms.
	api.post(
		'/wallets/:id/lfbw/move-home',
		asyncHandler(async (req, res) => {
			res.json({ ok: true, result: await manager.moveHome(req.params.id) });
		})
	);

	// Close the home channel, optionally turning lightning-first off first
	// so the payout is not moved straight back into a new channel.
	api.post(
		'/wallets/:id/lfbw/close-home',
		asyncHandler(async (req, res) => {
			const { channelId, turnOff } = req.body || {};
			res.json({ ok: true, result: await manager.closeHome(req.params.id, { channelId, turnOff: !!turnOff }) });
		})
	);

	// Move a wallet to a new guardian set with its channels running (beignet
	// #701): the daemon rotates, the record follows.
	api.post(
		'/wallets/:id/recovery/rotate',
		asyncHandler(async (req, res) => {
			const { guardians } = req.body || {};
			res.json({ ok: true, result: await manager.rotateGuardians(req.params.id, guardians) });
		})
	);

	api.get('/wallets/:id/logs', (req, res) =>
		res.json({ ok: true, result: manager.logs(req.params.id) })
	);

	// Node-level errors captured from the daemon's event stream. These carry the
	// reason a channel open failed, which is otherwise reported nowhere.
	api.get('/wallets/:id/errors', (req, res) => {
		const since = parseInt(req.query.since, 10);
		res.json({
			ok: true,
			result: manager.nodeErrors(req.params.id, {
				since: Number.isFinite(since) ? since : undefined
			})
		});
	});

	// Durable channel history captured from the daemon's event stream: opening,
	// ready, closing, and the reason an automatic force-close fired. Unlike the
	// error ring this survives manager restarts, so a channel that closed while
	// nobody was watching can still explain itself in the detail view.
	api.get('/wallets/:id/channel-events', (req, res) => {
		const channelId =
			typeof req.query.channelId === 'string' ? req.query.channelId : undefined;
		res.json({
			ok: true,
			result: manager.channelEvents(req.params.id, { channelId })
		});
	});

	// Fetch the wallet daemon's OpenAPI spec and rewrite its server URL so the
	// Swagger UI "Try it out" calls route back through this manager (with auth).
	api.get(
		'/wallets/:id/openapi.json',
		asyncHandler(async (req, res) => {
			const id = req.params.id;
			const target = manager.target(id);
			if (!target) {
				return res
					.status(404)
					.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Wallet not found' } });
			}
			const upstream = await fetch(`${target}/openapi.json`, {
				signal: AbortSignal.timeout(5000)
			});
			const spec = await upstream.json();
			spec.servers = [{ url: `/wallets/${id}/api`, description: 'Beignet wallet (via manager)' }];
			res.json(spec);
		})
	);

	app.use('/api', api);

	// --- Static assets + SPA ---
	const swaggerPath = swaggerAssetsPath();
	if (swaggerPath) {
		app.use('/vendor/swagger', express.static(swaggerPath));
	}
	const publicDir = path.join(__dirname, '..', 'public');
	app.use(express.static(publicDir));
	// Client-side routing fallback: serve index.html for non-API GET routes.
	app.get('*', (req, res, next) => {
		if (
			req.path.startsWith('/api') ||
			req.path.startsWith('/wallets') ||
			req.path.startsWith('/vendor')
		) {
			return next();
		}
		res.sendFile(path.join(publicDir, 'index.html'), (err) => err && next());
	});

	// --- Error handler (must be last) ---
	// eslint-disable-next-line no-unused-vars
	app.use((err, req, res, next) => {
		const status = err.statusCode || 500;
		if (status >= 500) console.error(err);
		res.status(status).json({
			ok: false,
			error: {
				code: err.code || 'ERROR',
				message: err.message,
				// Structured context for a refusal the dashboard can act on
				// (which wallets depend on a primary, say).
				...(err.details ? { details: err.details } : {})
			}
		});
	});

	const server = app.listen(config.port, '0.0.0.0', () => {
		console.log(`beignet manager listening on :${config.port} (data dir ${config.dataDir})`);
	});

	const shutdown = async () => {
		console.log('shutting down; stopping wallet daemons...');
		await manager.shutdown();
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 12000);
	};
	process.on('SIGTERM', shutdown);
	process.on('SIGINT', shutdown);
}

main().catch((err) => {
	console.error('fatal:', err);
	process.exit(1);
});
