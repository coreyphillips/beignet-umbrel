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

/** True when the engine behind `bin` serves JIT receive and direct funding. */
function lfbwAvailable(bin = process.env.BEIGNET_BIN) {
	if (!bin) return false;
	const openapi = path.join(path.dirname(path.resolve(bin)), 'openapi.js');
	let text;
	try {
		text = fs.readFileSync(openapi, 'utf8');
	} catch (_) {
		return false;
	}
	return LFBW_ROUTE_MARKERS.every((marker) => text.includes(marker));
}

module.exports = { engineVersion, recoveryAvailable, lfbwAvailable, RECOVERY_MIN_VERSION, LFBW_ROUTE_MARKERS };
