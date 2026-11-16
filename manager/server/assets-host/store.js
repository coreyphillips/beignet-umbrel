'use strict';

/**
 * The host's rows in the node's database.
 *
 * The engine gives an extension a synchronous key and value store of its own
 * (beignet's docs/EXTENSIONS.md): rows in the same SQLite file as the
 * wallet's channel state, encrypted with it, copied with it by the engine's
 * own backup and carried across an in-process restore. Two things live there:
 *
 *   t/ and T/   the library's records: asset records, proof files, mint
 *               batches, sends, receive addresses and the key counter
 *   h/          the host's own: what the user confirmed, the answers to
 *               money requests (so a repeat is answered and not acted on
 *               again), the open preview, the activity rows, known assets
 *
 * Every write here is one synchronous call or one transaction, durable when
 * it returns. After the node's database is replaced, every call throws; the
 * service loop takes that as its signal to stop (errors.isFenced).
 */
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

// The engine refuses a key over 512 characters. The library keys a receive
// by its whole address, which can be longer, so a long key is stored under
// its head and a hash, with the key itself in front of the value.
const LONG_KEY = 300;
const HEAD = 160;
const SHORT = 't/';
const LONG = 'T/';
const HOST = 'h/';

const sha256Hex = (text) => crypto.createHash('sha256').update(text).digest('hex');
const longKey = (key) => `${LONG}${key.slice(0, HEAD)}/${sha256Hex(key)}`;

/**
 * The storage the library's reference stores need (ts-tap's
 * `store.KeyValueBackend`), over the extension's storage view. A write of
 * several keys is one database transaction.
 */
function tapBackend(storage) {
	return {
		async get(key) {
			if (key.length <= LONG_KEY) {
				const value = storage.get(SHORT + key);
				return value === null ? undefined : value;
			}
			const raw = storage.get(longKey(key));
			if (raw === null) return undefined;
			const cut = raw.indexOf('\n');
			return raw.slice(0, cut) === key ? raw.slice(cut + 1) : undefined;
		},
		async keys(prefix) {
			const out = storage.list(SHORT + prefix).map((row) => row.key.slice(SHORT.length));
			for (const row of storage.list(LONG + prefix.slice(0, HEAD))) {
				const key = row.value.slice(0, row.value.indexOf('\n'));
				if (key.startsWith(prefix)) out.push(key);
			}
			return out;
		},
		async write(writes) {
			storage.transaction(() => {
				for (const { key, value } of writes) {
					const at = key.length <= LONG_KEY ? SHORT + key : longKey(key);
					if (value === undefined) storage.delete(at);
					else storage.set(at, key.length <= LONG_KEY ? value : `${key}\n${value}`);
				}
			});
		}
	};
}

/** The host's own rows: JSON values under h/. */
function hostRows(storage) {
	const rows = {
		get(key) {
			const raw = storage.get(HOST + key);
			if (raw === null) return null;
			try {
				return JSON.parse(raw);
			} catch (_) {
				return null;
			}
		},
		put(key, value) {
			storage.set(HOST + key, JSON.stringify(value));
		},
		del(key) {
			storage.delete(HOST + key);
		},
		/** [{ key, value }] for every row under `prefix`, keys without the prefix the host adds. */
		list(prefix) {
			const out = [];
			for (const row of storage.list(HOST + prefix)) {
				try {
					out.push({ key: row.key.slice(HOST.length), value: JSON.parse(row.value) });
				} catch (_) {
					/* a row that is not JSON is not one of ours */
				}
			}
			return out;
		},
		/** Run `fn` atomically. `fn` must be synchronous. */
		tx(fn) {
			return storage.transaction(fn);
		}
	};
	return rows;
}

/** Every stored row as [key, value], library and host alike, for the backup. */
function dumpRows(storage) {
	return storage.list('').map((row) => [row.key, row.value]);
}

/**
 * One thing at a time. Everything that changes asset state runs through one
 * of these, so a route and the service loop never interleave inside a step.
 */
function createMutex() {
	let tail = Promise.resolve();
	return function run(fn) {
		const result = tail.then(() => fn());
		tail = result.then(
			() => undefined,
			() => undefined
		);
		return result;
	};
}

/**
 * The lock the library serialises its own stages with (`FlowLock`): calls
 * on one scope run one at a time, different scopes never wait on each other
 * (a call holding one scope may take another).
 */
function createScopeLock() {
	const tails = new Map();
	return async function lock(scope, fn) {
		const run = (tails.get(scope) || Promise.resolve()).then(() => fn());
		const tail = run.then(
			() => undefined,
			() => undefined
		);
		tails.set(scope, tail);
		try {
			return await run;
		} finally {
			if (tails.get(scope) === tail) tails.delete(scope);
		}
	};
}

/**
 * The host's one lock. `run(fn)` is the mutex every mutating route and every
 * step of the service loop goes through. `flowLock` is the same lock in the
 * shape the library takes for its own stages: a library call made from
 * inside `run` continues without waiting (its scopes nest, and a second wait
 * on the same lock would never end), and one made from outside waits its
 * turn like anything else.
 */
function createHostLock() {
	const inside = new AsyncLocalStorage();
	const mutex = createMutex();
	const run = (fn) => {
		const held = inside.getStore();
		if (held && held.active) return Promise.resolve().then(fn);
		return mutex(() => {
			// A timer started inside a section inherits its context, so the
			// token says whether that section is still the one running.
			const token = { active: true };
			return inside.run(token, async () => {
				try {
					return await fn();
				} finally {
					token.active = false;
				}
			});
		});
	};
	// A timer made inside a section carries that section's token, and one
	// that fires while the section is still running would walk straight
	// through the lock. Timers are made through here, holding nothing, so
	// what they call always waits its turn.
	const outside = (fn) => inside.exit(fn);
	return { run, flowLock: (_scope, fn) => run(fn), outside };
}

/** A Map-backed stand-in for the extension storage view, for tests. */
function memoryStorage(data = new Map()) {
	let fenced = false;
	let depth = 0;
	const guard = () => {
		if (fenced) throw new Error('The database connection is not open');
	};
	const storage = {
		get(key) {
			guard();
			return data.has(key) ? data.get(key) : null;
		},
		set(key, value) {
			guard();
			if (typeof key !== 'string' || !key || key.length > 512) throw new Error('bad storage key');
			if (typeof value !== 'string') throw new Error('storage values are strings');
			data.set(key, value);
		},
		delete(key) {
			guard();
			data.delete(key);
		},
		list(prefix) {
			guard();
			return [...data.entries()]
				.filter(([key]) => key.startsWith(prefix))
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.map(([key, value]) => ({ key, value }));
		},
		transaction(fn) {
			guard();
			// As the engine's view does: a transaction opened inside another
			// throws before its callback runs, because the inner one could not
			// be undone on its own.
			if (depth > 0) throw new Error('An extension storage transaction cannot be opened inside another transaction');
			const before = new Map(data);
			depth += 1;
			try {
				return fn();
			} catch (err) {
				data.clear();
				for (const [k, v] of before) data.set(k, v);
				throw err;
			} finally {
				depth -= 1;
			}
		}
	};
	return { storage, data, fence: () => (fenced = true) };
}

module.exports = { tapBackend, hostRows, dumpRows, createMutex, createScopeLock, createHostLock, memoryStorage, sha256Hex, LONG_KEY };
