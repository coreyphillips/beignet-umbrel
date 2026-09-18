'use strict';

/**
 * FFOR offline receive (Fast-Forward Offline Receive, spec at
 * github.com/coreyphillips/ffor, beignet #729 and #865): the pure rules the
 * manager applies before it spawns a daemon or asks one to act. A wallet
 * that opts in settles offline receives for its siblings (the settlement
 * peer, S in the spec); any Lightning wallet can be the receiver (R). The
 * daemon validates the same switches and refuses by name, but a refusal at
 * spawn time only ever shows up in the Logs tab after a restart loop, so
 * the manager checks first and answers the request that made it with a 400.
 *
 * Nothing here does I/O. wallet-manager.js is the I/O around it.
 */

// The settlement peer's terms. The caps are what the daemon reads from
// BEIGNET_FFOR_MAX_BUDGET_MSAT and BEIGNET_FFOR_MAX_EPOCH_BLOCKS (unset
// means no cap), the fees are the floor a receiver's book must meet.
const SETTLE_DEFAULTS = Object.freeze({
	enabled: false,
	maxBudgetMsat: null,
	maxEpochBlocks: null,
	feeBaseMsat: 0,
	feePpm: 0
});

// [min, max, optional]. An optional cap clears with null or ''.
const SETTLE_BOUNDS = Object.freeze({
	maxBudgetMsat: [1, Number.MAX_SAFE_INTEGER, true],
	// The engine refuses a book whose voucher expiry sits under the
	// settlement deadline plus 1008 blocks, so a cap below that would
	// refuse every epoch; a year is the upper bound for a pre-signed book.
	maxEpochBlocks: [1008, 52560, true],
	feeBaseMsat: [0, 1000000, false],
	feePpm: [0, 100000, false]
});

// The epoch states the daemon reports (its FforState enum, as strings).
const EPOCH_STATES = Object.freeze([
	'NEGOTIATING',
	'VOUCHERS_COMMITTED',
	'ACTIVATING',
	'ACTIVE',
	'DRAINING',
	'CLOSED',
	'ABORTED'
]);

// A receiver's epoch in one of these states has a settlement peer that
// may hold credits for it, so a fresh start reconciles it.
const RETURN_STATES = Object.freeze(['ACTIVE', 'DRAINING']);

// Every event the daemon relays for the feature (beignet #729).
const FFOR_EVENTS = Object.freeze([
	'ffor:state',
	'ffor:settled',
	'ffor:delegated-failed',
	'ffor:enforce',
	'ffor:witness-provisioned',
	'ffor:witness-recorded',
	'ffor:witness-released',
	'ffor:issuer-provisioned',
	'ffor:issuer-issued'
]);

// The two that name the epoch's channel and belong in its history.
const FFOR_CHANNEL_EVENTS = Object.freeze(['ffor:state', 'ffor:enforce']);

// How long a fresh start waits for the channel to the settlement peer to
// reestablish before asking the daemon to reconcile anyway. A sibling on
// loopback is back within seconds; a peer through Tor can take a minute.
const RETURN_REESTABLISH_TIMEOUT_MS = 90000;
const RETURN_POLL_MS = 2000;
// How long a return waits for the cooperative close to drain after the
// peer accepted it, before recording whatever the epoch reads; and how
// long the manager keeps watching a drain that outlasted that, updating
// the record when it completes.
const RETURN_DRAIN_TIMEOUT_MS = 30000;
const DRAIN_TRACK_TIMEOUT_MS = 10 * 60 * 1000;
const DRAIN_TRACK_POLL_MS = 5000;

// A channel in one of these states takes no channel actions any more: an
// epoch on it is enforced on-chain (or long gone), never reconciled.
const CLOSED_CHANNEL_STATES = Object.freeze(['CLOSED', 'FORCE_CLOSED']);

function httpError(status, code, message) {
	const err = new Error(message);
	err.status = status;
	err.statusCode = status;
	err.code = code;
	return err;
}

/** Validated FFOR block for a record, defaults filled in, or throws. */
function normalizeFfor(input, existing) {
	const base = { settle: { ...SETTLE_DEFAULTS, ...((existing && existing.settle) || {}) } };
	if (input === undefined || input === null) return base;
	if (typeof input !== 'object') throw httpError(400, 'BAD_FFOR', 'ffor must be an object');
	const out = { settle: { ...base.settle } };
	if ('settle' in input && input.settle !== undefined) {
		const settle = input.settle;
		if (settle === null || typeof settle !== 'object') {
			throw httpError(400, 'BAD_FFOR', 'ffor.settle must be an object');
		}
		if ('enabled' in settle) out.settle.enabled = !!settle.enabled;
		for (const key of Object.keys(SETTLE_BOUNDS)) {
			if (!(key in settle)) continue;
			const raw = settle[key];
			const [lo, hi, optional] = SETTLE_BOUNDS[key];
			if (raw === null || raw === '') {
				if (optional) {
					out.settle[key] = null;
					continue;
				}
				throw httpError(400, 'BAD_FFOR', `${key} must be a whole number`);
			}
			if (typeof raw !== 'number' && typeof raw !== 'string') {
				throw httpError(400, 'BAD_FFOR', `${key} must be a whole number`);
			}
			const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
			if (!Number.isInteger(n) || n < lo || n > hi) {
				throw httpError(400, 'BAD_FFOR', `${key} must be a whole number between ${lo} and ${hi}`);
			}
			out.settle[key] = n;
		}
	}
	return out;
}

/** True when the record opts in as a settlement peer and runs Lightning. */
function isSettler(rec) {
	return !!(rec && !rec.onchainOnly && rec.ffor && rec.ffor.settle && rec.ffor.settle.enabled);
}

/**
 * The env fragment for a wallet that settles offline receives. Nothing for
 * anyone else, so a wallet that does not opt in sees the env it always saw
 * and an engine that predates the feature never meets the switch. The
 * daemon reads exactly the string 'true'; the caps ride only when set.
 */
function fforEnv(rec) {
	if (!isSettler(rec)) return {};
	const settle = normalizeFfor(undefined, rec.ffor).settle;
	const env = {
		BEIGNET_FFOR_SETTLE: 'true',
		BEIGNET_FFOR_FEE_BASE_MSAT: String(settle.feeBaseMsat),
		BEIGNET_FFOR_FEE_PPM: String(settle.feePpm)
	};
	if (settle.maxBudgetMsat !== null && settle.maxBudgetMsat !== undefined) {
		env.BEIGNET_FFOR_MAX_BUDGET_MSAT = String(settle.maxBudgetMsat);
	}
	if (settle.maxEpochBlocks !== null && settle.maxEpochBlocks !== undefined) {
		env.BEIGNET_FFOR_MAX_EPOCH_BLOCKS = String(settle.maxEpochBlocks);
	}
	return env;
}

/** True when a running daemon spawned with `spawned` needs a restart for the FFOR role the record wants. */
function fforRoleChanged(spawnedEnv, rec) {
	const want = fforEnv(rec);
	const have = spawnedEnv || {};
	const keys = new Set([...Object.keys(want), ...Object.keys(have).filter((k) => /^BEIGNET_FFOR_/.test(k))]);
	for (const k of keys) {
		if ((want[k] || null) !== (have[k] || null)) return true;
	}
	return false;
}

/**
 * The siblings a wallet can pick as its settlement peer: same network, not
 * itself, opted in, with a node id the dashboard can match against the
 * wallet's channels. Every beignet node advertises the FFOR feature bit
 * whether or not it settles, so the record is the only honest source.
 */
function settlementCandidates(records, self, runningOf = () => false) {
	return (records || [])
		.filter((rec) => rec && rec.id !== self.id && rec.network === self.network && isSettler(rec) && rec.nodeId)
		.map((rec) => ({
			id: rec.id,
			name: rec.name,
			nodeId: rec.nodeId,
			running: !!runningOf(rec)
		}));
}

/**
 * The channel ids of this wallet's own epochs a fresh start should
 * reconcile: ACTIVE or DRAINING, on a channel that still operates. An
 * epoch on a force-closed channel is being claimed on-chain; asking the
 * daemon to recover it would only report the peer as unreachable.
 */
function returnJobs(epochs, channels) {
	const closed = new Set(
		(Array.isArray(channels) ? channels : [])
			.filter((c) => c && CLOSED_CHANNEL_STATES.includes(c.state))
			.map((c) => String(c.channelId))
	);
	return (Array.isArray(epochs) ? epochs : [])
		.filter((e) => e && e.role === 'R' && RETURN_STATES.includes(e.state) && e.channelId && !closed.has(String(e.channelId)))
		.map((e) => String(e.channelId));
}

/**
 * What a return came to, read off the epoch and the channel rather than
 * the daemon's action: the action says what the recover call initiated,
 * and it answers 'nothing' for a drain in progress and for an epoch that
 * already closed as well as for a peer that is not there.
 *
 *   closed      the epoch closed cooperatively (credit through the bitmap)
 *   force-closed the recover call force-closed the channel
 *   draining    the peer accepted the close; the vouchers are settling
 *   enforced    the channel is closed on-chain while the epoch reads
 *               ACTIVE: the settled vouchers are claimed as it confirms
 *   unreachable the epoch is live and the peer did not answer
 *   failed      the daemon refused the call
 */
function returnOutcome({ action, epoch, channelState, error }) {
	if (error) return 'failed';
	const state = epoch ? epoch.state : null;
	if (state === 'CLOSED' || state === 'ABORTED') return action === 'force-closed' ? 'force-closed' : 'closed';
	if (action === 'force-closed') return 'force-closed';
	if (state === 'DRAINING') return 'draining';
	if (channelState && CLOSED_CHANNEL_STATES.includes(channelState)) return 'enforced';
	return 'unreachable';
}

/**
 * What a return produced, from the daemon's /ffor/recover answer. Never
 * complete while the peer was unreachable (action 'nothing') or a slot the
 * wallet could still be owed reads unsettled: the credit is only real once
 * the epoch closed with the settled bitmap in hand.
 */
function describeReturn(result) {
	if (!result || typeof result !== 'object') return null;
	const epoch = result.epoch || null;
	const slots = (epoch && Array.isArray(epoch.slots) ? epoch.slots : []).map((s) => s.state);
	const settled = slots.filter((s) => s === 'settled').length;
	const unsettled = slots.filter((s) => s === 'unsettled').length;
	// preimagesKnown is what the witnesses returned before the close; a
	// cooperative close credits through the settled bitmap, so the larger of
	// the two is what the wallet can claim.
	const credited = Math.max(Array.isArray(result.preimagesKnown) ? result.preimagesKnown.length : 0, settled);
	const action = result.action || 'nothing';
	const outcome = result.outcome || returnOutcome({ action, epoch, channelState: result.channelState, error: result.error });
	return {
		action,
		outcome,
		credited,
		settled,
		unsettled,
		total: slots.length,
		state: epoch ? epoch.state : null,
		complete: (outcome === 'closed' || outcome === 'force-closed') && unsettled === 0
	};
}

/** One log line for a return outcome. */
function returnLogLine(channelId, result, err) {
	const short = String(channelId || '').slice(0, 16);
	if (err) return `ffor return ${short}: failed, ${err.message}`;
	const d = describeReturn(result);
	if (!d) return `ffor return ${short}: no answer`;
	switch (d.outcome) {
		case 'unreachable':
			return `ffor return ${short}: settlement peer not reachable, ${d.settled} of ${d.total} slots settled so far`;
		case 'draining':
			return `ffor return ${short}: closing with the peer, ${d.settled} of ${d.total} slots settled so far`;
		case 'enforced':
			return `ffor return ${short}: the channel is closed on-chain, ${d.settled} of ${d.total} slots claimed through it`;
		default:
			return `ffor return ${short}: ${d.outcome}, ${d.settled} of ${d.total} slots settled, ${d.credited} preimage${
				d.credited === 1 ? '' : 's'
			} known`;
	}
}

module.exports = {
	SETTLE_DEFAULTS,
	SETTLE_BOUNDS,
	EPOCH_STATES,
	RETURN_STATES,
	FFOR_EVENTS,
	FFOR_CHANNEL_EVENTS,
	RETURN_REESTABLISH_TIMEOUT_MS,
	RETURN_POLL_MS,
	RETURN_DRAIN_TIMEOUT_MS,
	DRAIN_TRACK_TIMEOUT_MS,
	DRAIN_TRACK_POLL_MS,
	CLOSED_CHANNEL_STATES,
	returnOutcome,
	normalizeFfor,
	isSettler,
	fforEnv,
	fforRoleChanged,
	settlementCandidates,
	returnJobs,
	describeReturn,
	returnLogLine
};
