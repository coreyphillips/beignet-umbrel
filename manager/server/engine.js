'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Which beignet the manager is about to spawn. Nothing else in the manager
 * needs the engine version, but the dashboard hides controls for features
 * the bundled engine predates, and the only honest source for that is the
 * package the binary belongs to.
 *
 * BEIGNET_BIN points at dist/cli/cli.js inside the installed package (the
 * image sets it; local dev sets it to a checkout's build), so the package
 * manifest is found by walking up from the binary. A bare `beignet` on
 * PATH gives nothing to walk from, so the version is unknown there.
 */
function engineVersion(bin = process.env.BEIGNET_BIN) {
	if (!bin) return null;
	let dir = path.dirname(path.resolve(bin));
	for (let i = 0; i < 8; i++) {
		const manifest = path.join(dir, 'package.json');
		try {
			const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
			if (parsed && parsed.name === 'beignet' && typeof parsed.version === 'string') {
				return parsed.version;
			}
		} catch (_) {
			/* no manifest here, keep walking */
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return null;
}

// The Recovery Protocol daemon surface (env vars, /recovery routes, the six
// recovery events) shipped in beignet 0.9.1.
const RECOVERY_MIN_VERSION = [0, 9, 1];

function parseVersion(version) {
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ''));
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(version, floor) {
	const v = parseVersion(version);
	if (!v) return false;
	for (let i = 0; i < 3; i++) {
		if (v[i] > floor[i]) return true;
		if (v[i] < floor[i]) return false;
	}
	return true;
}

/** True when the given engine version carries the recovery surface. */
function recoveryAvailable(version) {
	return atLeast(version, RECOVERY_MIN_VERSION);
}

// The routes and the policy field lightning-first wallets consume. Probed
// on the bundled engine's OpenAPI module rather than gated on a version
// number: they landed on the engine's master well before a release carried
// them, and a checkout run through BEIGNET_BIN reports the last released
// version whatever it contains.
const LFBW_ROUTE_MARKERS = ["'/jit/invoice'", "'/direct-funding/send'", 'allowSplice'];
// A fee quote for a just-in-time receive that registers nothing with the
// primary (beignet #687), so the Receive tab can say the price before the
// invoice exists.
const JIT_QUOTE_MARKERS = ['/jit/quote'];
// The daemon applying a peer-storage checkpoint by itself on an empty
// database (beignet #690). The env name is a literal in the engine's config
// module, which is the one file certain to carry it.
const RECOVERY_AUTO_APPLY_MARKERS = ['BEIGNET_RECOVERY_AUTO_APPLY'];

/** The text of a module beside the daemon binary, or null when absent. */
function siblingModule(bin, file) {
	if (!bin) return null;
	try {
		return fs.readFileSync(path.join(path.dirname(path.resolve(bin)), file), 'utf8');
	} catch (_) {
		return null;
	}
}

function probe(bin, file, markers) {
	const text = siblingModule(bin, file);
	return !!text && markers.every((marker) => text.includes(marker));
}

/** True when the engine behind `bin` serves JIT receive and direct funding. */
function lfbwAvailable(bin = process.env.BEIGNET_BIN) {
	return probe(bin, 'openapi.js', LFBW_ROUTE_MARKERS);
}

/** True when the engine behind `bin` quotes a JIT receive without an intent. */
function jitQuoteAvailable(bin = process.env.BEIGNET_BIN) {
	return probe(bin, 'openapi.js', JIT_QUOTE_MARKERS);
}

/** True when the engine behind `bin` can apply a peer-storage checkpoint by itself. */
function recoveryAutoApplyAvailable(bin = process.env.BEIGNET_BIN) {
	// The env name is a literal in the config module (it parses it) and in
	// the OpenAPI module (it documents it); either is proof.
	return probe(bin, 'config.js', RECOVERY_AUTO_APPLY_MARKERS) || probe(bin, 'openapi.js', RECOVERY_AUTO_APPLY_MARKERS);
}

module.exports = {
	engineVersion,
	recoveryAvailable,
	lfbwAvailable,
	jitQuoteAvailable,
	recoveryAutoApplyAvailable,
	RECOVERY_MIN_VERSION,
	LFBW_ROUTE_MARKERS,
	JIT_QUOTE_MARKERS,
	RECOVERY_AUTO_APPLY_MARKERS
};
