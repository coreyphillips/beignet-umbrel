/**
 * Channel backup (the beignet Recovery Protocol), read for people.
 *
 * The daemon's GET /recovery/status answers in four layers (the daemon's own
 * state, the node's startup gate, a few node booleans, and a status per
 * channel), and the dashboard shows one line. This module is that reduction,
 * kept pure so the table is tested once and every surface reads the same.
 *
 * Wire facts it leans on: `state` is disabled | running | restore-required |
 * restoring | fenced; `state: running` coexists with `node.gate:
 * quarantined` (guardians not yet confirming, peer traffic held); sequence
 * numbers are decimal strings and are shown, never computed.
 */

export const RECOVERY_MODES = ['off', 'peer-storage', 'async-remote', 'quorum'];

export const MODE_LABELS = {
	off: 'Seed only',
	'peer-storage': 'Peer storage',
	'async-remote': 'Guardians (async)',
	quorum: 'Guardians (strict quorum)'
};

export function isGuardianMode(mode) {
	return mode === 'async-remote' || mode === 'quorum';
}

/** A Lightning node URI, `<66-hex node id>@host:port`, as pasted from another wallet. */
const NODE_URI = /^([0-9a-fA-F]{66})@(\[[0-9a-fA-F:]+\]|[^:\s@/]+):(\d{1,5})$/;

/** True for a plain node URI, which resolves to a guardian entry through the daemon. */
export function isNodeUri(text) {
	return NODE_URI.test(String(text || '').trim());
}

/** True for a guardian entry that names a beignet node (bolt8), not an HTTP service. */
export function isBolt8Entry(entry) {
	return /^[0-9a-fA-F]{64}@bolt8:\/\//.test(String(entry || '').trim());
}

/**
 * A guardian entry, read for people: where it lives and what kind it is.
 * `<64-hex>@bolt8://<66-hex>@host:port` reads as a beignet node at host:port;
 * an http(s) entry reads as its host.
 */
export function guardianEntryLabel(entry) {
	const text = String(entry || '').trim();
	const at = text.indexOf('@');
	if (at < 0) return text;
	const url = text.slice(at + 1);
	if (isBolt8Entry(text)) {
		const m = /^bolt8:\/\/([0-9a-fA-F]{66})@(.+)$/.exec(url);
		return m ? `beignet node ${m[1].slice(0, 8)}… at ${m[2]}` : url;
	}
	try {
		const parsed = new URL(url);
		return `${parsed.protocol === 'https:' ? 'https ' : ''}guardian at ${parsed.host}`;
	} catch (_) {
		return url;
	}
}

const SEED_ONLY_DETAIL =
	'Only the seed is backed up. If this Umbrel is lost, importing the seed elsewhere recovers the on-chain funds; open channels are closed by their peers and the funds return on-chain over time.';

/**
 * One line for the Backup row and the header badge.
 *
 * `status` is the /recovery/status result, or null / `{ state:
 * 'unsupported' }` when the daemon answered 404 (an engine that predates
 * the feature). `rec` is the wallet record.
 * Returns { tier, detail, tone, degraded }: `tier` is the short label,
 * `detail` the sentence under it, `tone` a Badge tone, and `degraded` true
 * only for the states the header should wave about.
 */
export function describeRecovery(status, rec = {}) {
	const lightning = !rec.onchainOnly;
	if (!status || status.state === 'unsupported') {
		return {
			tier: 'Seed only',
			detail: 'This engine has no channel backup. ' + SEED_ONLY_DETAIL,
			tone: lightning ? 'yellow' : 'muted',
			degraded: false
		};
	}
	const node = status.node || null;
	const guardianMode = isGuardianMode(status.mode);

	if (status.state === 'restore-required') {
		return {
			tier: 'Restore required',
			detail:
				'The guardians hold channel state for this seed that this wallet has not restored yet. Until the restore runs, the wallet has no channels and cannot use Lightning.',
			tone: 'yellow',
			degraded: true
		};
	}
	if (status.state === 'restoring') {
		// The daemon's own checkpoint restore rebuilds the node in-process
		// and says restoring for that moment (beignet #690).
		if (status.autoApply?.enabled) {
			return {
				tier: AUTO_APPLY_TIERS.applying,
				detail: status.restore?.lastEvent?.detail || 'Rebuilding the node on the checkpoint.',
				tone: 'yellow',
				degraded: true
			};
		}
		return {
			tier: 'Restoring',
			detail: status.restore?.lastEvent?.detail || 'Taking the channels over from the guardians.',
			tone: 'yellow',
			degraded: true
		};
	}
	if (status.state === 'restart-required') {
		return {
			tier: 'Restarting on restored state',
			detail:
				'A checkpoint restore replaced this wallet\'s database. The wallet restarts on the restored state and its channels resume from there.',
			tone: 'yellow',
			degraded: true
		};
	}
	if (status.state === 'fenced' || node?.fenced || node?.gate === 'fenced') {
		return {
			tier: "Another device took over this wallet's channels",
			detail:
				'This copy can never use these channels again; the device that restored them has them now. To bring them back to this Umbrel, delete this copy and import the seed with the same guardians.',
			tone: 'red',
			degraded: true
		};
	}
	if (node?.backfillLost) {
		return {
			tier: 'Recovery journal broken',
			detail:
				'Journal entries were pruned before the guardians received them, so the journal cannot continue and the channels are held. Restoring from the guardians elsewhere is not possible either; the channels fall back to seed-only recovery.',
			tone: 'red',
			degraded: true
		};
	}
	if (status.state === 'disabled' || status.mode === 'off') {
		return {
			tier: 'Seed only (channels close on restore)',
			detail: SEED_ONLY_DETAIL,
			tone: lightning ? 'yellow' : 'muted',
			degraded: false
		};
	}
	if (status.mode === 'peer-storage') {
		const auto = autoApplyState(status);
		if (auto) {
			return {
				tier: AUTO_APPLY_TIERS[auto.phase] || AUTO_APPLY_TIERS.idle,
				detail: auto.detail,
				tone: auto.phase === 'refused' ? 'yellow' : auto.phase === 'applied' || auto.phase === 'idle' ? 'blue' : 'yellow',
				degraded: auto.phase === 'settling' || auto.phase === 'applying' || auto.phase === 'refused'
			};
		}
		return {
			tier: 'Checkpoints via peer storage',
			detail:
				'Encrypted channel checkpoints ride with the peers that offer storage. Importing the seed elsewhere with peer storage and reconnecting to those peers offers a recovery from the newest checkpoint: the funds return on-chain, or the channels come back held until each peer confirms them. There is no fencing between devices in this mode.',
			tone: 'blue',
			degraded: false
		};
	}
	if (guardianMode && node && (node.gate === 'quarantined' || node.startupRepairPending)) {
		return {
			tier: 'Waiting for guardians to confirm',
			detail:
				'Two of the three guardians must confirm this device still owns the channels before any peer traffic is allowed. Peers are held until they do; payments through this wallet wait with them.',
			tone: 'yellow',
			degraded: true
		};
	}
	const seq = node?.lastDurableSequence ?? '0';
	const waiting = node?.awaitingDurabilityCount || 0;
	const waitingNote =
		waiting > 0
			? ` ${waiting} channel${waiting === 1 ? '' : 's'} waiting on guardian receipts right now.`
			: '';
	if (status.mode === 'quorum') {
		return {
			tier: `Continuity: quorum, durable to seq ${seq}`,
			detail:
				'Every channel step waits until two of the three guardians have stored it. Importing the seed with the same guardians restores the channels exactly and fences this device.' +
				waitingNote,
			tone: 'green',
			degraded: false
		};
	}
	return {
		tier: `Guardians (async), durable to seq ${seq}`,
		detail:
			'Channel state is copied to the three guardians in the background. Importing the seed with the same guardians restores and resumes the channels; a step mid-flight at the moment of loss closes safely instead.' +
			waitingNote,
		tone: 'green',
		degraded: false
	};
}

const AUTO_APPLY_TIERS = {
	idle: 'Checkpoints via peer storage, restored by itself',
	settling: 'Checkpoint found, about to apply it',
	applying: 'Applying the checkpoint',
	applied: 'Restored from a peer checkpoint',
	refused: 'Checkpoint found, not applied'
};

/**
 * Where the daemon's own checkpoint restore stands (beignet #690): a
 * peer-storage wallet whose owner answered, once, that the previous device
 * is stopped applies the newest checkpoint its peers return by itself. The
 * daemon reports that on the status route as `autoApply`. Returns null when
 * the wallet did not opt in (or the engine predates it), else the phase,
 * a sentence for it, and the daemon's reason when it refused.
 */
export function autoApplyState(status) {
	const a = status?.autoApply;
	if (!a || !a.enabled) return null;
	const phase = a.phase || 'idle';
	const last = status?.restore?.lastEvent || null;
	const uncovered =
		last && last.type === 'capsule:uncovered' && last.detail
			? ` Channels the checkpoint did not carry close safely and their funds return on-chain: ${last.detail}`
			: '';
	const detail =
		phase === 'settling'
			? 'A peer returned a checkpoint. Waiting a moment for the other peers to answer, then the newest one is applied.'
			: phase === 'applying'
			? 'Applying the newest checkpoint. The wallet comes back on the restored state by itself.'
			: phase === 'applied'
			? 'The newest checkpoint was applied and the channels came back from it, held: they take no new payments in until each peer confirms them, and closing one means accepting that a peer may hold a newer state.' +
			  uncovered
			: phase === 'refused'
			? `The checkpoint a peer returned was not applied${a.lastReason ? `: ${a.lastReason}` : ''}. Nothing was changed; the wallet runs on its own state.`
			: 'Encrypted channel checkpoints ride with the peers that offer storage. When this wallet is empty and a peer returns one, the newest is applied by itself. Nothing fences the old device in this mode.';
	return { phase, detail, lastReason: a.lastReason || null, settleUntil: a.settleUntil || null };
}

/**
 * What a channel's recovery status means to its owner after a restore.
 * `closing` covers the two must-never-broadcast states (the peer closes,
 * the DLP path) and a force close alike: the funds return on-chain, and
 * none of the three is an error.
 */
export function channelOutcome(status) {
	switch (status) {
		case 'active':
			return { kind: 'resumed', label: 'resumed' };
		case 'reestablishing':
			return { kind: 'pending', label: 'resuming' };
		case 'replay_required':
			return { kind: 'pending', label: 'replaying the last messages' };
		case 'quarantined':
			return { kind: 'pending', label: 'waiting for the peer' };
		case 'local_data_loss':
		case 'state_uncertain':
		case 'force_closing':
			return { kind: 'closing', label: 'closing safely, funds return on-chain' };
		default:
			return { kind: 'pending', label: String(status || 'unknown') };
	}
}

/**
 * The restore, step by step, in the engine's order. Each step lists the
 * progress events that belong to it; the step holding the latest event is
 * the current one, everything before it is done.
 */
export const RESTORE_STEPS = [
	{ key: 'heads', label: 'Asking the guardians what they hold', events: ['heads:read'] },
	{ key: 'adopt', label: 'Choosing the newest certified copy', events: ['head:adopted'] },
	{
		key: 'epoch',
		label: 'Taking ownership (the previous device is fenced)',
		events: ['guardian:repaired', 'epoch:cas-retry', 'epoch:resumed', 'epoch:abandoned', 'epoch:acquired']
	},
	{ key: 'frames', label: 'Downloading channel state', events: ['frames:downloaded'] },
	{ key: 'verify', label: 'Checking the state is exact', events: ['restore:exactness'] },
	{ key: 'node', label: 'Reconstructing and starting the node', events: ['restore:complete'] }
];

/**
 * Where a restore stands, from the status route alone (SSE frames can be
 * missed; the status route cannot). Returns:
 *   phase: 'ready' (restore-required, nothing started) | 'restoring' |
 *          'channels' (the node is up, channels reconciling) | 'fenced'
 *   steps: [{ key, label, done, current, detail }]
 *   channels: { total, resumed, closing, pending, items: [{ channelId, outcome }] }
 *   complete: true only when every channel has landed and the gate is open,
 *             the rule being that a restore is never presented as finished
 *             while a channel is still quarantined or reestablishing.
 */
export function restoreProgress(status) {
	const node = status?.node || null;
	const state = status?.state;
	let phase;
	let currentIndex = -1;
	let allDone = false;
	if (state === 'restore-required') {
		phase = 'ready';
	} else if (state === 'restoring') {
		phase = 'restoring';
		const type = status.restore?.lastEvent?.type;
		const idx = RESTORE_STEPS.findIndex((s) => s.events.includes(type));
		currentIndex = idx < 0 ? 0 : idx;
		if (type === 'restore:complete') {
			allDone = true;
		}
	} else if (state === 'fenced' || node?.fenced || node?.gate === 'fenced') {
		phase = 'fenced';
		allDone = true;
	} else {
		phase = 'channels';
		allDone = true;
	}
	const detail = status?.restore?.lastEvent?.detail || '';
	const steps = RESTORE_STEPS.map((s, i) => ({
		key: s.key,
		label: s.label,
		done: allDone || i < currentIndex,
		current: !allDone && i === currentIndex,
		detail: !allDone && i === currentIndex ? detail : ''
	}));
	const items = (node?.channels || []).map((c) => ({
		channelId: c.channelId,
		status: c.status,
		outcome: channelOutcome(c.status)
	}));
	const count = (kind) => items.filter((c) => c.outcome.kind === kind).length;
	const channels = {
		total: items.length,
		resumed: count('resumed'),
		closing: count('closing'),
		pending: count('pending'),
		items
	};
	const gateOpen = node ? node.gate === 'confirmed' || node.gate === 'disabled' : false;
	const complete = phase === 'channels' && channels.pending === 0 && gateOpen;
	return { phase, steps, channels, complete };
}

/**
 * Whether the wallet should be offered a restore from a Recovery Capsule a
 * storage peer returned (beignet 0.9.3+, peer-storage mode). The offer is
 * for a wallet that has nothing yet: one that already runs channels is not
 * a restore target (the daemon refuses a dirty database anyway). Returns
 * the capsule's summary, or null.
 */
export function capsuleOffer(status, info) {
	if (!status || status.mode !== 'peer-storage' || status.state !== 'running') return null;
	// A wallet that applies checkpoints by itself needs no offer; the Backup
	// row says where that stands. One whose daemon refused to apply it by
	// itself (a checkpoint naming guardians, say) is offered the manual
	// ways out, with the reason on the row.
	if (status.autoApply?.enabled && status.autoApply.phase !== 'refused') return null;
	const best = status.capsules?.best;
	if (!best) return null;
	const open = info ? info.openChannelCount ?? info.channelCount ?? 0 : 0;
	if (open > 0) return null;
	return {
		channelCount: best.channelCount,
		sequence: best.latestSequence,
		epoch: best.writerEpoch,
		inline: !!best.inline,
		fromPeer: best.fromPeer,
		guardians: best.guardians || [],
		candidates: status.capsules.candidates
	};
}
