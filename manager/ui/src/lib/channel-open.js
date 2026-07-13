import { manager } from '../api.js';

// Once the funding transaction is built and broadcast the channel moves into one
// of these states, and the on-chain funds have left the wallet. Anything before
// them is still negotiation, and can still fail with nothing spent.
const FUNDED_STATES = new Set([
	'SENT_FUNDING_CREATED',
	'SENT_FUNDING_SIGNED',
	'AWAITING_FUNDING_CONFIRMED',
	'AWAITING_CHANNEL_READY',
	'NORMAL'
]);

const POLL_MS = 2000;
const TIMEOUT_MS = 120000;

/**
 * Watches a channel open through to a real outcome.
 *
 * `POST /channel/connect-and-open` returns as soon as `open_channel` is sent, so
 * a 200 means only that we asked. The open can still be rejected by the peer, or
 * fail to fund, seconds later. Treating that 200 as success is what made failed
 * opens look like they had worked: the pending channel appeared, then quietly
 * disappeared, and the on-chain balance never moved.
 *
 * The channel cannot be followed by the id the open returned: that is the
 * *temporary* channel id, and it is replaced by the permanent one as soon as
 * funding is created, so it disappears on success just as it does on failure.
 * We therefore look for a channel with this peer that was not there before.
 *
 * Resolves to one of:
 *   { status: 'funded',    channel }  funding broadcast, on-chain funds committed
 *   { status: 'failed',    reason }   rejected, disconnected, or funding failed
 *   { status: 'pending',   reason }   still negotiating when we stopped watching
 *   { status: 'abandoned' }           the caller aborted; nothing to report
 */
export async function watchChannelOpen({
	api,
	id,
	peerPubkey,
	tempChannelId,
	knownIds,
	since,
	timeoutMs = TIMEOUT_MS,
	signal
}) {
	const deadline = Date.now() + timeoutMs;
	let seen = null;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, POLL_MS));
		// The caller went away (the modal was closed). Stop polling rather than
		// running on for the rest of the timeout and reporting to nobody.
		if (signal?.aborted) return { status: 'abandoned' };

		// While the open is still alive, only an error that is definitely ours may
		// end it, so an unrelated channel failing alongside cannot abort this one.
		const failure = await firstFailure({ id, tempChannelId, since, strict: true });
		if (failure) return { status: 'failed', reason: failure };

		const channels = await api.get('/channels').catch(() => null);
		if (!channels) continue;

		const opened = channels.find(
			(c) => c.peerPubkey === peerPubkey && !knownIds.has(c.channelId)
		);
		if (opened) {
			seen = opened;
			if (FUNDED_STATES.has(opened.state)) return { status: 'funded', channel: opened };
		} else if (seen) {
			// It was there and now it is gone, so the open failed regardless of what
			// the error stream says. Give it a beat to deliver the reason, then take
			// the best one going, even unattributed, rather than reporting a bare
			// failure with nothing to act on.
			await new Promise((r) => setTimeout(r, POLL_MS));
			const reason = await firstFailure({ id, tempChannelId, since, strict: false });
			return {
				status: 'failed',
				reason:
					reason ||
					'The peer rejected the channel or disconnected before it was funded. No on-chain funds were spent.'
			};
		}
	}

	return {
		status: 'pending',
		reason: seen
			? `The channel is still negotiating (${seen.state}) and has not been funded yet. Check the Logs tab.`
			: 'The channel did not reach a funded state in time. Check the Logs tab.'
	};
}

// Raised while building or broadcasting the funding transaction, before the
// channel has an id to hang them off, so they arrive unattributed.
const FUNDING_CODES = new Set(['AUTO_FUNDING_FAILED', 'FUNDING_BROADCAST_FAILED']);

/**
 * The first genuine failure belonging to this open, or null.
 *
 * Peer warnings arrive on the same channel as errors (a peer declining to store
 * our backup blob, for instance, reports as CHANNEL_ERROR "Remote warning: ...")
 * and are not failures, so they are always skipped.
 *
 * An error that names a channel must name ours, so an unrelated channel failing
 * mid-open cannot be mistaken for this one. Funding failures name none: they are
 * raised before the channel has an id.
 *
 * Under `strict` only those funding failures are accepted unattributed, so a
 * stray error cannot abort an open that is otherwise healthy. Once the channel is
 * known to be gone the caller drops `strict`, because the open has certainly
 * failed by then and a reason without an id still beats no reason at all.
 */
async function firstFailure({ id, tempChannelId, since, strict = true }) {
	const errors = await manager.errors(id, since).catch(() => []);
	const hit = (errors || []).find((e) => {
		if (/^Remote warning:/i.test(String(e.message || ''))) return false;
		if (e.channelId) return e.channelId === tempChannelId;
		return FUNDING_CODES.has(e.code) || !strict;
	});
	return hit ? formatNodeError(hit) : null;
}

/** Turn a raw node error into something a person can act on. */
export function formatNodeError(err) {
	const msg = String(err.message || '').replace(/^Remote error:\s*/i, '');
	if (err.code === 'AUTO_FUNDING_FAILED') {
		return `Could not fund the channel: ${msg}. No on-chain funds were spent.`;
	}
	if (err.code === 'FUNDING_BROADCAST_FAILED') {
		return `The funding transaction could not be broadcast: ${msg}.`;
	}
	return `The peer rejected the channel: ${msg}`;
}
