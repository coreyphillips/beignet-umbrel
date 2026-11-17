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

// A restore of channel state that holds an asset channel is refused by the
// engine, whole: these are its two codes for it. The same sentences as the
// manager's table (server/wallet-manager.js, ENGINE_ASSET_REFUSALS), kept
// here too because a restore is asked of the daemon directly.
const ASSET_RESTORE_REFUSALS = {
	ASSET_RESTORE_REFUSED:
		'The channel state that was to be restored holds an asset channel, which a restore does not bring back, so nothing was restored and nothing was written. The wallet is as it was.',
	AUXILIARY_GUARDIAN_RESTORE_REFUSED:
		'The channel state the guardians keep for this wallet holds an asset channel, which a guardian backup does not cover, so nothing was restored and nothing was written. The wallet is as it was.',
	// A restore met with no extension running to take the asset channels.
	ASSET_PROVIDER_REQUIRED:
		'The channel state that was to be restored holds an asset channel, and the assets part of this wallet is not running to take it, so nothing was restored and nothing was written. The wallet is as it was.'
};

/** What is typed to restore a checkpoint without the asset channels it holds. */
export const OMIT_ASSET_CHANNELS_PHRASE = 'leave them out';

/**
 * How many payments a restore left unresolved: those that were under way on
 * the asset channels it left out. The daemon lists their payment hashes in
 * its answer (`unresolvedPayments`), and only when there are any. Each
 * stays pending for good on the daemon's rows, marked as unresolved, and
 * its cancel is refused (409 PAYMENT_UNRESOLVED).
 */
export function unresolvedPayments(answer) {
	const said = answer ? answer.unresolvedPayments : null;
	if (Array.isArray(said)) return said.length;
	return Number.isInteger(said) && said > 0 ? said : 0;
}

/** Asset channels as a restore names them, [{ channelId, peerPubkey, capacitySats }], with anything malformed left out. */
export function restoreAssetChannels(list) {
	return (Array.isArray(list) ? list : [])
		.filter((c) => c && typeof c.channelId === 'string' && c.channelId && typeof c.peerPubkey === 'string' && c.peerPubkey)
		.map((c) => ({ channelId: c.channelId, peerPubkey: c.peerPubkey, capacitySats: Number.isFinite(Number(c.capacitySats)) && c.capacitySats !== null ? Number(c.capacitySats) : null }));
}

/**
 * The asset channels a checkpoint that was a backup only (the engine's Tier
 * 1, which has no channel state to install) had entries for and skipped,
 * recovering the rest. Read from the answer of a restore, and from
 * `autoApply` on the status when the daemon applied it by itself: both
 * name them `skippedAssetChannels`. Nobody chose this, where a channel
 * that was left out (`omittedAssetChannels`) was left out by choice.
 */
export function skippedAssetChannels(said) {
	return restoreAssetChannels(said && said.skippedAssetChannels);
}

/**
 * The asset channels the daemon's own apply of a checkpoint was refused
 * over, { code, channels }, or null. `said` is `autoApply` of the status
 * route or the data of a `capsule:auto-refused` restore-progress event:
 * both carry `refusal: { code, assetChannels }`, the list the restore
 * route refuses with. A refusal that is not about asset channels has no
 * such field, and the daemon drops it once a restore is installed.
 */
export function autoApplyRefusal(said) {
	const refusal = said && said.refusal;
	if (!refusal || typeof refusal !== 'object') return null;
	const channels = restoreAssetChannels(refusal.assetChannels);
	if (channels.length === 0) return null;
	return { code: typeof refusal.code === 'string' && refusal.code ? refusal.code : 'ASSET_RESTORE_REFUSED', channels };
}

/**
 * The asset channels a capsule restore was refused over, as the daemon
 * names them under `error.details.assetChannels`, or null: for another
 * refusal, and for one that names none (a daemon that does not say, which
 * is answered with the sentence alone and no way round).
 */
export function refusedAssetChannels(error) {
	const code = error && error.code;
	if (code !== 'ASSET_RESTORE_REFUSED' && code !== 'ASSET_PROVIDER_REQUIRED') return null;
	const list = restoreAssetChannels(error.details && error.details.assetChannels);
	return list.length > 0 ? list : null;
}

/** The sentence for a restore the engine refused over an asset channel, or null for any other error. */
export function assetRestoreRefusal(error) {
	const code = error && error.code;
	return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ASSET_RESTORE_REFUSALS, code) ? ASSET_RESTORE_REFUSALS[code] : null;
}

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
 * Returns { tier, detail, about, tone, degraded }: `tier` is the short
 * label, `detail` what is happening now (empty when a steady state has
 * nothing to add), `about` what the steady tier means, which the Backup row
 * keeps behind a "?", `tone` a Badge tone, and `degraded` true only for the
 * states the header should wave about.
 */
export function describeRecovery(status, rec = {}) {
	const lightning = !rec.onchainOnly;
	if (!status || status.state === 'unsupported') {
		return {
			tier: 'Seed only',
			detail: 'This engine has no channel backup.',
			about: SEED_ONLY_DETAIL,
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
			detail: '',
			about: SEED_ONLY_DETAIL,
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
			detail: '',
			about:
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
			? `${waiting} channel${waiting === 1 ? '' : 's'} waiting on guardian receipts right now.`
			: '';
	if (status.mode === 'quorum') {
		return {
			tier: `Continuity: quorum, durable to seq ${seq}`,
			detail: (waitingNote + barrierLatencyNote(node?.barrierLatency)).trim(),
			about:
				'Every channel step waits until two of the three guardians have stored it. Importing the seed with the same guardians restores the channels exactly and fences this device.',
			tone: 'green',
			degraded: false
		};
	}
	return {
		tier: `Guardians (async), durable to seq ${seq}`,
		detail: waitingNote,
		about:
			'Channel state is copied to the three guardians in the background. Importing the seed with the same guardians restores and resumes the channels; a step mid-flight at the moment of loss closes safely instead.',
		tone: 'green',
		degraded: false
	};
}

/**
 * What the quorum barrier has cost on this node (beignet #702): the waits
 * that actually parked a channel step, and how long the guardians took to
 * release them. Nothing until a step has waited; the steps that were
 * already durable never waited and are not counted.
 */
export function barrierLatencyNote(latency) {
	if (!latency || !latency.sampled) {
		return latency && latency.refused
			? ` ${latency.refused} step${latency.refused === 1 ? '' : 's'} timed out waiting for the guardians and had to be withheld.`
			: '';
	}
	const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
	const refused = latency.refused
		? ` ${latency.refused} step${latency.refused === 1 ? '' : 's'} timed out and had to be withheld.`
		: '';
	return (
		` Guardian receipts have held ${latency.released} step${latency.released === 1 ? '' : 's'} so far,` +
		` typically ${ms(latency.p50Ms)} each (95% within ${ms(latency.p95Ms)}, the last one ${ms(latency.lastMs)}).` +
		refused
	);
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
 *
 * A refusal over asset channels is said in words with `refusal` beside it
 * ({ code, channels }, see autoApplyRefusal): the checkpoint still waits,
 * and the card that offers the restore has the way round. An apply that
 * skipped asset channels lists them under `skipped`.
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
	const over = phase === 'refused' ? autoApplyRefusal(a) : null;
	const skipped = phase === 'applied' ? skippedAssetChannels(a) : [];
	const passed =
		skipped.length > 0
			? ` ${skipped.length === 1 ? 'One asset channel of the backup was' : `${skipped.length} asset channels of the backup were`} skipped: the backup carried no state for ${
					skipped.length === 1 ? 'it' : 'them'
			  }, so this wallet has no record of ${skipped.length === 1 ? 'it' : 'them'}.`
			: '';
	const detail =
		phase === 'settling'
			? 'A peer returned a checkpoint. Waiting a moment for the other peers to answer, then the newest one is applied.'
			: phase === 'applying'
			? 'Applying the newest checkpoint. The wallet comes back on the restored state by itself.'
			: phase === 'applied'
			? 'The newest checkpoint was applied and the channels came back from it, held: they take no new payments in until each peer confirms them, and closing one means accepting that a peer may hold a newer state.' +
			  uncovered +
			  passed
			: over
			? `The checkpoint a peer returned was not applied by itself: it holds ${
					over.channels.length === 1 ? 'an asset channel' : `${over.channels.length} asset channels`
			  }, which this wallet cannot bring back from it. Nothing was changed, and the checkpoint still waits. It can be restored without ${
					over.channels.length === 1 ? 'it' : 'them'
			  } from the card on this page.`
			: phase === 'refused'
			? `The checkpoint a peer returned was not applied${a.lastReason ? `: ${a.lastReason}` : ''}. Nothing was changed; the wallet runs on its own state.`
			: 'Encrypted channel checkpoints ride with the peers that offer storage. When this wallet is empty and a peer returns one, the newest is applied by itself. Nothing fences the old device in this mode.';
	return { phase, detail, lastReason: a.lastReason || null, settleUntil: a.settleUntil || null, refusal: over, skipped };
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
 *
 * `refused` on the summary is the asset channels the daemon's own apply
 * was refused over ({ code, channels }), or null. It is read from the
 * status, and from `heard`, the data of a `capsule:auto-refused` event,
 * which can arrive before the status has been read again.
 */
export function capsuleOffer(status, info, heard) {
	if (!status || status.mode !== 'peer-storage' || status.state !== 'running') return null;
	// A wallet that applies checkpoints by itself needs no offer; the Backup
	// row says where that stands. One whose daemon refused to apply it by
	// itself (a checkpoint naming guardians, say) is offered the manual
	// ways out, with the reason on the row.
	const said = status.autoApply?.phase === 'applied' ? null : autoApplyRefusal(heard);
	if (status.autoApply?.enabled && status.autoApply.phase !== 'refused' && !said) return null;
	const refused = (status.autoApply?.enabled && status.autoApply.phase === 'refused' ? autoApplyRefusal(status.autoApply) : null) || (status.autoApply?.enabled ? said : null);
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
		candidates: status.capsules.candidates,
		refused: refused || null
	};
}
