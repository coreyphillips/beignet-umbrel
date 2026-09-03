'use strict';

/**
 * Recovery Protocol rules the manager enforces before a daemon is spawned
 * (docs/RECOVERY-PROTOCOL.md section 8 in the beignet repository). Kept
 * pure so the contract can be tested without a registry or a process.
 *
 * The daemon validates everything here again and refuses to start on a
 * mistake, but a refusal at spawn time only ever shows up in the Logs tab
 * after a restart loop. Validating in the manager turns the same mistake
 * into a 400 on the request that made it.
 */

const RECOVERY_MODES = ['off', 'peer-storage', 'async-remote', 'quorum'];
const GUARDIAN_SET_SIZE = 3;
// The only profile protocol v1 accepts (2-of-3, crash-fault). The daemon
// defaults to it; it is passed explicitly so the wallet's env reads whole.
const RECOVERY_PROFILE = 'crash-v1';

function isRecoveryMode(mode) {
	return RECOVERY_MODES.includes(mode);
}

function isGuardianMode(mode) {
	return mode === 'async-remote' || mode === 'quorum';
}

/**
 * One guardian entry, `<64-hex-x-only-pubkey>@<http(s) url>`. Returns the
 * normalized entry (lowercase key, URL as given) or throws with a message
 * that names what is wrong. Whether the key is a valid x-only secp256k1
 * point is left to the daemon; the manager has no curve library and a key
 * copied from a guardian is a point.
 */
function parseGuardianEntry(input) {
	const entry = String(input || '').trim();
	const at = entry.indexOf('@');
	if (at < 0) {
		throw new Error(
			`guardian entry "${entry}" is missing the pubkey@url separator; expected <64-hex-x-only-pubkey>@<http(s) url>`
		);
	}
	const pubkey = entry.slice(0, at);
	const url = entry.slice(at + 1);
	if (!/^[0-9a-fA-F]{64}$/.test(pubkey)) {
		throw new Error(`guardian entry "${entry}" does not start with a 64-hex-character x-only pubkey`);
	}
	let parsed;
	try {
		parsed = new URL(url);
	} catch (_) {
		throw new Error(`guardian URL "${url}" is not a valid URL`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`guardian URL "${url}" must use http or https`);
	}
	return { pubkey: pubkey.toLowerCase(), url, entry: `${pubkey.toLowerCase()}@${url}` };
}

/**
 * A guardian set is all or nothing: an empty list (no guardians configured)
 * or exactly three distinct entries, the crash-v1 profile's only shape.
 * Returns the normalized entries.
 */
function validateGuardianSet(list) {
	if (!Array.isArray(list)) throw new Error('guardians must be a list');
	const entries = list.map((g) => String(g || '').trim()).filter((g) => g.length > 0);
	if (entries.length === 0) return [];
	if (entries.length !== GUARDIAN_SET_SIZE) {
		throw new Error(
			`a guardian set is exactly ${GUARDIAN_SET_SIZE} entries (crash-v1 is 2-of-3); got ${entries.length}`
		);
	}
	const parsed = entries.map(parseGuardianEntry);
	const keys = new Set(parsed.map((g) => g.pubkey));
	if (keys.size !== parsed.length) {
		throw new Error('guardian entries must have three distinct pubkeys');
	}
	return parsed.map((g) => g.entry);
}

/** True when two guardian sets name the same keys, in any order. */
function sameGuardianSet(a, b) {
	const keys = (list) =>
		(list || [])
			.map((g) => String(g).slice(0, 64).toLowerCase())
			.sort()
			.join(',');
	return keys(a) === keys(b);
}

/**
 * The daemon env fragment for a wallet record's recovery field. Off (or an
 * absent field) contributes nothing, so a daemon that predates the feature
 * sees the env it always saw. Guardians ride only with the guardian modes:
 * the daemon refuses a guardian list under off or peer-storage.
 */
function recoveryEnv(recovery) {
	const mode = recovery && recovery.mode;
	if (!mode || mode === 'off' || !isRecoveryMode(mode)) return {};
	const env = { BEIGNET_RECOVERY_MODE: mode };
	if (isGuardianMode(mode)) {
		env.BEIGNET_RECOVERY_GUARDIANS = (recovery.guardians || []).join(',');
		env.BEIGNET_RECOVERY_PROFILE = RECOVERY_PROFILE;
	}
	// The daemon applying a peer-storage checkpoint by itself on an empty
	// database (beignet #690). Peer storage only: the daemon refuses to
	// start with the flag under any other mode, so it never rides there.
	if (mode === 'peer-storage' && recovery.autoApply === true) {
		env.BEIGNET_RECOVERY_AUTO_APPLY = 'true';
	}
	return env;
}

module.exports = {
	RECOVERY_MODES,
	GUARDIAN_SET_SIZE,
	RECOVERY_PROFILE,
	isRecoveryMode,
	isGuardianMode,
	parseGuardianEntry,
	validateGuardianSet,
	sameGuardianSet,
	recoveryEnv
};
