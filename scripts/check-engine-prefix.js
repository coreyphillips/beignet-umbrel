#!/usr/bin/env node
'use strict';

/**
 * Checks an engine prefix: the directory the daemon is installed in, with the
 * Taproot Assets packages beside it (docs/ASSETS.md).
 *
 *   node scripts/check-engine-prefix.js <prefix> [--require-assets]
 *
 * The image build runs it on /opt/beignet, and scripts/engine-prefix.sh runs
 * it on a prefix made for development. It fails unless:
 *
 *   - the prefix holds exactly one copy of the engine. The assets adapter
 *     takes values from the engine it is given at run time, so a second copy
 *     anywhere under the prefix would hand it a different one;
 *   - the engine's native SQLite module loads;
 *   - ts-tap and @ts-tap/beignet are installed at the top of the prefix,
 *     load, and resolve that one engine copy;
 *   - the adapter's peer range admits the engine installed.
 *
 * It prints what it found, and whether the engine carries the host extension
 * contract. An engine that predates the contract is not a failure: the app
 * runs on it with assets off. Pass --require-assets to make it one.
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const fail = (message) => {
	console.error(`check-engine-prefix: ${message}`);
	process.exit(1);
};

const args = process.argv.slice(2);
const requireAssets = args.includes('--require-assets');
const prefixArg = args.find((arg) => !arg.startsWith('--'));
if (!prefixArg) fail('usage: node scripts/check-engine-prefix.js <prefix> [--require-assets]');

let modules;
try {
	modules = fs.realpathSync(path.join(path.resolve(prefixArg), 'node_modules'));
} catch (_) {
	fail(`${prefixArg} has no node_modules`);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Every installed package under a node_modules directory whose manifest names the engine. */
function engineCopies(nodeModules, found = []) {
	const visit = (dir) => {
		try {
			if (readJson(path.join(dir, 'package.json')).name === 'beignet') found.push(dir);
		} catch (_) {
			/* not a package */
		}
		const nested = path.join(dir, 'node_modules');
		if (fs.existsSync(nested)) engineCopies(nested, found);
	};
	for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const full = path.join(nodeModules, entry.name);
		if (entry.name.startsWith('@')) {
			for (const scoped of fs.readdirSync(full, { withFileTypes: true })) {
				if (scoped.isDirectory()) visit(path.join(full, scoped.name));
			}
		} else {
			visit(full);
		}
	}
	return found;
}

const copies = engineCopies(modules);
const engineDir = path.join(modules, 'beignet');
if (copies.length !== 1 || copies[0] !== engineDir) {
	fail(`expected one engine at ${engineDir}, found ${copies.length ? copies.join(', ') : 'none'}`);
}
const engine = readJson(path.join(engineDir, 'package.json'));

try {
	const Database = createRequire(path.join(engineDir, 'package.json'))('better-sqlite3');
	new Database(':memory:').prepare('select 1').get();
} catch (err) {
	fail(`the engine's SQLite module does not load (${err.message})`);
}

/** Compare dotted versions; enough for the plain ranges the adapter uses. */
function cmp(a, b) {
	const pa = String(a).split('-')[0].split('.').map(Number);
	const pb = String(b).split('-')[0].split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
	}
	return 0;
}
function satisfies(version, range) {
	return String(range)
		.trim()
		.split(/\s+/)
		.every((part) => {
			const m = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/.exec(part);
			if (!m) fail(`the adapter's engine range "${range}" is not one this check can read`);
			const c = cmp(version, m[2]);
			return { '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '=': c === 0, undefined: c === 0 }[m[1]];
		});
}

const fromPrefix = createRequire(path.join(modules, 'noop.js'));
const tap = {};
for (const name of ['ts-tap', '@ts-tap/beignet']) {
	const dir = path.join(modules, ...name.split('/'));
	if (!fs.existsSync(path.join(dir, 'package.json'))) {
		if (requireAssets) fail(`${name} is not installed in ${modules}`);
		continue;
	}
	const manifest = readJson(path.join(dir, 'package.json'));
	let loaded;
	try {
		loaded = fromPrefix(name);
	} catch (err) {
		fail(`${name} does not load (${err.message})`);
	}
	tap[name] = { version: manifest.version, commit: typeof loaded.buildInfo === 'function' ? (loaded.buildInfo() || {}).commit || null : null, manifest, dir };
}

const adapter = tap['@ts-tap/beignet'];
if (adapter) {
	if (!tap['ts-tap']) fail('@ts-tap/beignet is installed without ts-tap');
	const range = (adapter.manifest.peerDependencies || {}).beignet;
	if (!range) fail('@ts-tap/beignet names no engine range');
	if (!satisfies(engine.version, range)) {
		fail(`@ts-tap/beignet needs beignet ${range} and the prefix holds ${engine.version}. Vendor a ts-tap build for this engine (scripts/vendor-ts-tap.sh).`);
	}
	// The adapter must find the one engine copy, not one of its own.
	const seen = fs.realpathSync(path.dirname(createRequire(path.join(adapter.dir, 'package.json')).resolve('beignet/package.json')));
	if (seen !== engineDir) fail(`@ts-tap/beignet resolves the engine at ${seen}, not ${engineDir}`);
}

let contract = false;
try {
	contract = fs.readFileSync(path.join(engineDir, 'dist', 'cli', 'extension.js'), 'utf8').includes('beignet-extension-api/1');
} catch (_) {
	/* an engine that predates the contract */
}
if (requireAssets && !(contract && adapter)) {
	fail(`this prefix cannot run assets: ${contract ? 'the packages are missing' : `beignet ${engine.version} has no host extension contract`}`);
}

console.log(`engine: beignet ${engine.version}, one copy, SQLite loads`);
for (const [name, info] of Object.entries(tap)) console.log(`${name}: ${info.version}${info.commit ? ` at ${info.commit}` : ''}`);
console.log(
	contract && adapter
		? 'assets: available on this prefix'
		: `assets: off on this prefix (${!adapter ? 'ts-tap is not installed' : `beignet ${engine.version} predates the host extension contract`})`
);
