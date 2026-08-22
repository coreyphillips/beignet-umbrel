import { useEffect, useRef, useState } from 'react';
import { usePoll } from '../hooks/usePoll.js';
import { Badge, Button, Card } from './ui.jsx';
import { shortId } from '../lib/format.js';
import { describeRecovery, restoreProgress } from '../lib/recovery.js';

/**
 * The guardian restore, from the hold to the channels landing.
 *
 * The daemon booted against a fresh database whose recovery namespace its
 * guardians hold, and serves nothing but its recovery surface until the
 * restore runs. POST /recovery/restore is the trigger and blocks through
 * the takeover, the download and the node build; the status route is the
 * truth the panel renders from, polled every two seconds (SSE frames only
 * prompt an earlier poll, since they can be missed and the status cannot).
 *
 * The one rule the panel keeps: a restore is never presented as finished
 * while a channel is still quarantined or reestablishing. After the node
 * boots, every channel is listed with where it landed, and the ones that
 * fall to the DLP path read as closing safely, not as errors.
 */

// The daemon's refusals, which leave it holding; anything else is the wire.
const REFUSALS = new Set([
	'RESTORE_NO_QUORUM',
	'RESTORE_CAS_EXHAUSTED',
	'RESTORE_CONFLICT',
	'RESTORE_UNKNOWN_NAMESPACE',
	'RESTORE_HEAD_UNVERIFIABLE',
	'RESTORE_TARGET_UNSUPPORTED',
	'INVALID_PARAMS'
]);

export const markerKey = (id) => `beignet-restore-${id}`;

export function readRestoreMarker(id) {
	try {
		return sessionStorage.getItem(markerKey(id)) === '1';
	} catch (_) {
		return false;
	}
}

function writeRestoreMarker(id, on) {
	try {
		if (on) sessionStorage.setItem(markerKey(id), '1');
		else sessionStorage.removeItem(markerKey(id));
	} catch (_) {
		/* storage unavailable; the panel still works for this page load */
	}
}

export default function RestorePanel({ id, api, rec, tick = 0, onStarted, onDone }) {
	const [busy, setBusy] = useState(false);
	const [refusal, setRefusal] = useState(null);
	const [result, setResult] = useState(null);
	const { data: status, refresh } = usePoll(() => api.get('/recovery/status'), 2000, [id]);
	// A recovery event over SSE (the page bumps tick on every event) is a
	// reason to look now rather than at the next two-second mark.
	const lastTick = useRef(tick);
	useEffect(() => {
		if (tick !== lastTick.current) {
			lastTick.current = tick;
			refresh();
		}
	}, [tick, refresh]);

	const start = async () => {
		setBusy(true);
		setRefusal(null);
		// The page keeps this panel up past the moment the manager reports the
		// wallet running (the node boots before the channels land); it learns
		// that here and from the session marker after a reload.
		writeRestoreMarker(id, true);
		if (onStarted) onStarted();
		try {
			const r = await api.post('/recovery/restore', { confirm: true });
			setResult(r);
		} catch (e) {
			const code = e && e.code;
			if (code === 'RESTORE_IN_PROGRESS' || code === 'RESTORE_NOT_PENDING') {
				// Already running (a reload, a double click) or already done.
			} else if (REFUSALS.has(code)) {
				setRefusal(e.message);
			} else {
				// The wire gave out under a long call (a proxy, a tunnel, the
				// manager restarting); the daemon is most likely still at it.
				// The status poll decides; only a daemon still holding with
				// nothing started gets the button back.
				setRefusal(null);
			}
		} finally {
			setBusy(false);
			refresh();
		}
	};

	// `landed` says whether the node is up (the channel phase): the page then
	// waits for the manager to report the wallet running before it leaves
	// the panel, rather than bouncing to the list for a second or two.
	const finish = (landed) => {
		writeRestoreMarker(id, false);
		if (onDone) onDone(landed);
	};

	if (!status) {
		return (
			<Card title="Restore from guardians">
				<div className="empty">Reading the wallet's recovery status…</div>
			</Card>
		);
	}

	const progress = restoreProgress(status);
	const guardians = status.guardians || [];

	if (progress.phase === 'ready') {
		return (
			<Card title="Restore from guardians">
				<p className="restore-lead">
					The guardians hold channel state for this seed. This wallet's database is fresh, so
					the daemon is holding: until the restore runs it has no channels and cannot use
					Lightning.
				</p>
				<p className="restore-lead">
					Restoring takes the channels over from the guardians. If the device that used this
					seed before is still running, it is fenced off and can never use these channels
					again; the channels continue here. Fencing holds between beignet instances that
					follow the protocol; it cannot revoke keys on a device that does not.
				</p>
				{guardians.length > 0 && (
					<div className="wallet-meta" style={{ marginBottom: 12 }}>
						Guardians: {guardians.map((g) => g.url).join(', ')}
					</div>
				)}
				{refusal && (
					<div className="error-note">
						The guardians refused the restore: {refusal} The wallet keeps holding; try again
						once the guardians are reachable.
					</div>
				)}
				<div className="center-actions">
					<Button variant="primary" busy={busy} onClick={start}>
						Restore channels
					</Button>
					<Button onClick={() => finish(false)}>Back</Button>
				</div>
			</Card>
		);
	}

	if (progress.phase === 'restoring') {
		return (
			<Card title="Restoring from guardians">
				<StepList steps={progress.steps} />
				<div className="wallet-meta" style={{ marginTop: 12 }}>
					This can take a while: the takeover needs two of the three guardians, and the node
					starts once the state is rebuilt. Leaving this page does not stop it.
				</div>
			</Card>
		);
	}

	if (progress.phase === 'fenced') {
		const d = describeRecovery(status, rec || {});
		return (
			<Card title="Restore from guardians">
				<div className="error-note">
					{d.tier}. {d.detail}
				</div>
				<div className="center-actions">
					<Button onClick={() => finish(true)}>Back</Button>
				</div>
			</Card>
		);
	}

	// The node is up: every restore step is behind us and the channels are
	// reconciling with their peers, one outcome each.
	const { channels, complete } = progress;
	const landed = channels.resumed + channels.closing;
	return (
		<Card title={complete ? 'Restore complete' : 'Channels resuming'}>
			<StepList steps={progress.steps} />
			<div className="restore-channels">
				<div className="restore-summary">
					{channels.total === 0 ? (
						'No channels to resume: the restored state holds none.'
					) : (
						<>
							Channels resuming: {landed} of {channels.total}
							{channels.closing > 0
								? ` (${channels.closing} closing safely, funds return on-chain)`
								: ''}
						</>
					)}
				</div>
				{result && (
					<div className="wallet-meta">
						{result.exact
							? 'The restored state was proven exact, so channels resume where they were.'
							: 'The restored state could not be proven exact; channels that cannot prove they are current close safely, with the funds returning on-chain.'}
						{result.framesApplied !== undefined ? ` ${result.framesApplied} journal entries applied.` : ''}
					</div>
				)}
				<ul className="restore-channel-list">
					{channels.items.map((c) => (
						<li key={c.channelId}>
							<code>{shortId(c.channelId)}</code>{' '}
							<Badge tone={c.outcome.kind === 'resumed' ? 'green' : c.outcome.kind === 'closing' ? 'blue' : 'yellow'}>
								{c.outcome.label}
							</Badge>
						</li>
					))}
				</ul>
				{!complete && channels.total > 0 && (
					<div className="wallet-meta">
						Waiting on {channels.pending} channel{channels.pending === 1 ? '' : 's'}: each
						reconciles with its peer the moment the peer is reachable, and the guardians must
						confirm this device owns them before any payment moves.
					</div>
				)}
			</div>
			<div className="center-actions">
				<Button variant={complete ? 'primary' : 'ghost'} onClick={() => finish(true)}>
					{complete ? 'Go to overview' : 'Leave this for now'}
				</Button>
			</div>
		</Card>
	);
}

function StepList({ steps }) {
	return (
		<ol className="restore-steps">
			{steps.map((s) => (
				<li key={s.key} className={s.done ? 'done' : s.current ? 'current' : 'todo'}>
					<span className="restore-step-mark" aria-hidden="true">
						{s.done ? '✓' : s.current ? '…' : ''}
					</span>
					<span className="restore-step-label">{s.label}</span>
					{s.detail ? <span className="restore-step-detail">{s.detail}</span> : null}
				</li>
			))}
		</ol>
	);
}
