'use strict';

/**
 * The assets host: Taproot Assets for one wallet, as an extension of the
 * wallet engine (beignet's docs/EXTENSIONS.md).
 *
 * The manager names this file in BEIGNET_EXTENSIONS when it starts a
 * wallet's daemon (manager/server/assets.js). The daemon loads it into its
 * own process, where the wallet's keys and coins are, serves its routes at
 * /x/assets and relays its events as assets:<name>. The manager never loads
 * it.
 *
 * A host that cannot run (a network without assets, packages that are not
 * installed) still attaches: its status says why in plain words, every other
 * route refuses, and the bitcoin wallet runs as it always did.
 *
 *   config.js   what the daemon's environment says
 *   chain.js    which chain the wallet is on: its network, or which testnet
 *   adapter.js  the Taproot Assets library, loaded from beside the engine
 *   store.js    rows in the node's database, and the host's one lock
 *   service.js  state, the start sequence and the loop
 *   ops.js      what each route does
 *   views.js    the shapes the dashboard reads
 *   fetch.js    the way out to a proof server
 *   backup.js   the assets backup file
 *   routes.js   the routes and events declared to the engine
 *   errors.js   refusals, and the library's errors in the dashboard's codes
 */
const { parseConfig, onChain } = require('./config');
const { ROUTES, EVENTS, bind, failedHandlers, routeKey } = require('./routes');
const { plainMessage, refusal } = require('./errors');
const views = require('./views');

const VERSION = '0.1.0';

function warn(context, message) {
	try {
		if (context.logger && typeof context.logger.error === 'function') context.logger.error(message);
	} catch (_) {
		/* nothing to say it to */
	}
}

/** An attachment that only explains why assets are not running. */
function failed(cfg, context, message) {
	const status = () => views.statusView({ cfg, phase: 'failed', error: message });
	return {
		handlers: failedHandlers(status, message),
		start: async () => {
			try {
				context.emit('status', status());
			} catch (_) {
				/* the status route still says it */
			}
		},
		stop: async () => {},
		status
	};
}

/**
 * An attachment for a testnet wallet whose server has not yet said which
 * testnet it is on. The library cannot be built until it has, so the routes
 * are served from here: the status says what is being waited for, everything
 * else asks to be tried again, and the server is asked again until it
 * answers. Then the attachment `build` returns takes over.
 */
function pending(cfg, context, build, { ask, firstDelayMs = 5000, maxDelayMs = 60000 }) {
	const waiting = `Waiting for the wallet's Electrum server to say which ${cfg.network} it is on.`;
	let real = null;
	let stopped = false;
	let timer = null;
	let delay = firstDelayMs;
	const status = () => (real ? real.status() : views.statusView({ cfg, phase: 'starting', startup: { done: 0, total: 4, waiting } }));
	const handlers = {};
	for (const route of ROUTES) {
		const key = routeKey(route);
		handlers[key] = async (request) => {
			if (real) return real.handlers[key](request);
			if (key === 'GET /status') return status();
			throw refusal('ASSETS_STARTING', `Assets are still starting (${waiting.replace(/\.$/, '')}). Try again in a moment.`, 503);
		};
	}
	const attempt = async () => {
		timer = null;
		if (stopped || real) return;
		const asked = await ask(context.wallet);
		if (stopped) return;
		if (!asked.answered) {
			timer = setTimeout(() => attempt().catch(() => undefined), delay);
			if (typeof timer.unref === 'function') timer.unref();
			delay = Math.min(delay * 2, maxDelayMs);
			return;
		}
		const built = await build(asked);
		if (stopped) {
			await built.stop('shutdown').catch(() => undefined);
			return;
		}
		real = built;
		await real.start();
	};
	return {
		handlers,
		start: async () => {
			try {
				context.emit('status', status());
			} catch (_) {
				/* the status route still says it */
			}
			attempt().catch(() => undefined);
		},
		stop: async (reason) => {
			stopped = true;
			clearTimeout(timer);
			if (real) await real.stop(reason);
		},
		status
	};
}

async function attach(base, context, { ask } = {}) {
	if (base.problem) return failed(base, context, base.problem);
	const { loadLibrary, createLib, buildAdapter } = require('./adapter');
	const { createHost } = require('./service');
	const { createNet } = require('./fetch');
	const chains = require('./chain');
	const askChain = ask || chains.askChain;
	let libs;
	try {
		libs = loadLibrary(base.modulesDir);
	} catch (err) {
		warn(context, `assets: ${err.message}`);
		return failed(base, context, err.message);
	}
	/** The attachment for a wallet whose chain can be settled from `asked` and what it remembers. */
	const build = async (asked) => {
		// The library is built for one chain, so that is settled before
		// anything else exists.
		let cfg;
		let settled;
		try {
			settled = chains.settleChain({ cfg: base, storage: context.storage, asked });
			cfg = onChain(base, settled.chain);
		} catch (err) {
			warn(context, `assets: ${err.message}`);
			return failed(base, context, err.message);
		}
		let host;
		try {
			host = createHost({
				cfg,
				storage: context.storage,
				wallet: context.wallet,
				lib: createLib(libs.tap),
				net: createNet({ cfg, logger: context.logger }),
				emit: context.emit,
				logger: context.logger,
				chainCheck: settled.verified
					? null
					: chains.laterCheck({ cfg, storage: context.storage, wallet: context.wallet, chain: settled.chain, ask: askChain })
			});
			host.tap = buildAdapter({
				tap: libs.tap,
				bridge: libs.bridge,
				wallet: context.wallet,
				storage: context.storage,
				cfg,
				lock: host.lock.flowLock,
				courierFor: host.courierFor,
				proofPublisher: host.proofPublisher
			});
			await host.attach();
		} catch (err) {
			const message = `Assets could not start: ${plainMessage(err, 'the wallet could not be read')}.`.replace(/\.\.$/, '.');
			warn(context, `assets: ${message}`);
			return failed(cfg, context, message);
		}
		return {
			handlers: bind(host),
			start: () => host.start(),
			stop: (reason) => host.stop(reason),
			status: () => host.status()
		};
	};
	// The wallet's Electrum server says which chain this is. A quick question
	// here; a server slow to answer is asked again later, by the guard of a
	// host that knows its chain or by `pending` for one that does not.
	const asked = await askChain(context.wallet, { timeoutMs: chains.ATTACH_TIMEOUT_MS });
	let known = true;
	try {
		known = asked.answered || !!chains.knownChain({ cfg: base, storage: context.storage });
	} catch (err) {
		return failed(base, context, `Assets could not start: ${plainMessage(err, 'the wallet could not be read')}.`.replace(/\.\.$/, '.'));
	}
	return known ? build(asked) : pending(base, context, build, { ask: askChain });
}

/**
 * The engine calls this once per daemon with the wallet's network and the
 * daemon's environment, before any node is built.
 */
function beignetExtension({ network, env } = {}) {
	const cfg = parseConfig(network, env || {});
	return {
		id: 'assets',
		version: VERSION,
		api: 1,
		routes: ROUTES,
		events: EVENTS,
		attach: (context) => attach(cfg, context)
	};
}

module.exports = { beignetExtension, attach, pending, VERSION };
