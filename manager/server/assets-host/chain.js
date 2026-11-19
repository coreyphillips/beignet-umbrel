'use strict';

/**
 * Which chain a wallet is really on.
 *
 * The engine names a network, and the Electrum server the wallet is pointed
 * at decides what that means. For `testnet` it decides between two chains,
 * testnet3 and testnet4, which Taproot Assets tells apart: other rules about
 * when a proof must carry what, and other proof servers. So the host asks
 * the server for block 0 and reads the chain off its hash.
 *
 * It asks on every network, because the answer also protects what a wallet
 * holds. Asset records checked against another chain would all look spent.
 * A wallet that holds assets remembers the chain they are on (the `chain`
 * row), and its host will not run against any other.
 *
 * Nothing here throws anything but a sentence for the dashboard.
 */
const crypto = require('crypto');
const { GENESIS } = require('./config');
const { hostRows } = require('./store');
const { holdsRecords } = require('./backup');

const ROW = 'chain';
// How long a server is given to answer: briefly while the wallet's node waits
// on the host to attach, longer once it is running.
const ATTACH_TIMEOUT_MS = 5000;
const ASK_TIMEOUT_MS = 15000;

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest();

/** The hash of a block header, as an explorer prints it, or null when `hex` is not a header. */
function headerHash(hex) {
	const text = typeof hex === 'string' ? hex.trim() : '';
	if (!/^[0-9a-f]{160}$/i.test(text)) return null;
	return Buffer.from(sha256(sha256(Buffer.from(text, 'hex')))).reverse().toString('hex');
}

/**
 * Ask the wallet's Electrum server for block 0.
 *
 * Resolves { answered, genesis, chain } and never throws. `chain` is null
 * when the block is not the first of a chain this app knows. No answer
 * within `timeoutMs` is no answer.
 */
async function askChain(wallet, { timeoutMs = ASK_TIMEOUT_MS } = {}) {
	const none = { answered: false, genesis: null, chain: null };
	let timer;
	try {
		const result = await Promise.race([
			Promise.resolve().then(() => wallet.electrum.getBlockHex({ height: 0 })),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error('timed out')), timeoutMs);
				if (typeof timer.unref === 'function') timer.unref();
			})
		]);
		if (!result || (typeof result.isErr === 'function' && result.isErr())) return none;
		const genesis = headerHash(typeof result === 'string' ? result : result.value);
		if (!genesis) return none;
		return { answered: true, genesis, chain: GENESIS[genesis] || null };
	} catch (_) {
		return none;
	} finally {
		clearTimeout(timer);
	}
}

const pinnedChain = (cfg, rows) => {
	const kept = rows.get(ROW);
	return kept && cfg.chains.includes(kept.name) ? kept.name : null;
};

/**
 * The chain a wallet is on without asking: the one it remembers, or the only
 * one its network can be. Null for a testnet wallet that has never been told.
 */
function knownChain({ cfg, storage }) {
	return pinnedChain(cfg, hostRows(storage)) || (cfg.chains.length === 1 ? cfg.chains[0] : null);
}

function otherNetwork(cfg, asked) {
	return asked.chain
		? `This is a ${cfg.network} wallet, and its Electrum server is on ${asked.chain}. Assets stay off until the two match.`
		: `This wallet's Electrum server is on a chain this app does not know, so assets are off.`;
}

function otherChain(pinned, asked) {
	return `This wallet's assets are on ${pinned}, and its Electrum server is on ${asked.chain}. Point the wallet at a ${pinned} server to use them.`;
}

/**
 * The chain a host starts on, from what the server said (`asked`) and what
 * the wallet remembers.
 *
 * Returns { chain, verified }. `verified` is false when the server did not
 * answer and the chain is the one the wallet remembers, or the only one its
 * network can be: the host may start, and must not check a single asset
 * against the chain until laterCheck has passed. Throws a sentence when
 * assets cannot run: a server on another network, a wallet whose assets are
 * on the other testnet, or a testnet nobody has named yet (which the host
 * waits out instead of asking this: see `pending` in index.js).
 *
 * A wallet that holds nothing follows its server, so pointing an unused
 * testnet wallet at the other testnet just works.
 */
function settleChain({ cfg, storage, asked }) {
	const rows = hostRows(storage);
	const pinned = pinnedChain(cfg, rows);
	if (asked.answered) {
		if (!asked.chain || !cfg.chains.includes(asked.chain)) throw new Error(otherNetwork(cfg, asked));
		if (pinned && pinned !== asked.chain && holdsRecords(storage)) throw new Error(otherChain(pinned, asked));
		if (pinned !== asked.chain) rows.put(ROW, { name: asked.chain, genesis: asked.genesis });
		return { chain: asked.chain, verified: true };
	}
	const known = knownChain({ cfg, storage });
	if (!known) throw new Error(`The wallet's Electrum server has not said which ${cfg.network} it is on, so assets cannot start yet.`);
	return { chain: known, verified: false };
}

/**
 * For a host that started on `chain` without the server's word for it: ask
 * again. Resolves once the server names that chain, and throws the reason
 * to keep waiting, or to stop, until then.
 */
function laterCheck({ cfg, storage, wallet, chain, ask = askChain }) {
	return async () => {
		const asked = await ask(wallet);
		if (!asked.answered) throw new Error("The wallet's Electrum server has not said which chain it is on");
		if (asked.chain === chain) {
			const rows = hostRows(storage);
			if (pinnedChain(cfg, rows) !== chain) rows.put(ROW, { name: chain, genesis: asked.genesis });
			return;
		}
		if (!asked.chain || !cfg.chains.includes(asked.chain)) throw new Error(otherNetwork(cfg, asked));
		if (holdsRecords(storage)) throw new Error(otherChain(chain, asked));
		throw new Error(`The wallet's Electrum server is on ${asked.chain}. Stop the wallet and start it again to use assets there.`);
	};
}

module.exports = { ROW, ATTACH_TIMEOUT_MS, ASK_TIMEOUT_MS, headerHash, askChain, knownChain, settleChain, laterCheck };
