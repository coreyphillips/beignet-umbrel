'use strict';

const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { config, SUPPORTED_NETWORKS, ELECTRUM_PRESETS } = require('./config');
const { WalletManager } = require('./wallet-manager');

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
				onionAvailable: manager.onionAvailable()
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

	api.get('/wallets/:id/logs', (req, res) =>
		res.json({ ok: true, result: manager.logs(req.params.id) })
	);

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
			error: { code: err.code || 'ERROR', message: err.message }
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
