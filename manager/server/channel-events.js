'use strict';

const path = require('path');
const { JsonlLog } = require('./jsonl-log');

// Durable per-wallet channel history. The daemon reports a channel's life
// (opening, ready, closing, and the reason an automatic force-close fired)
// only as transient events on its stream; the manager's in-memory rings die
// with the process. This log is the record that survives: without it, a
// channel that closed while nobody was watching has no story to tell, which
// is exactly the complaint that motivated it (a force-closed channel whose
// detail view could not say what happened or when).
const MAX_EVENTS = 500;

// The daemon SSE events that narrate a channel's lifecycle. channel:resolved
// (every on-chain output of a close irrevocably swept, relayed since beignet
// 0.9.0) is the terminal one: after it the story is complete.
const LIFECYCLE_EVENTS = new Set([
	'channel:opening',
	'channel:ready',
	'channel:pending-close',
	'channel:force-closing',
	'channel:closed',
	'channel:resolved',
	// FFOR offline receive (beignet #729): the epoch's committed state
	// changes and a peer contradicting an ACTIVE epoch at reconnect. An
	// epoch's start, activation, settlements while the wallet was away and
	// its close are exactly the history a user asks about later.
	'ffor:state',
	'ffor:enforce'
]);

// node:error messages that tell no channel's story, kept in step with the
// dashboard's split in manager/ui/src/lib/node-errors.js. A peer warning
// leaves every channel alone and usually arrives on the all-zero channel id
// (beignet #1956); a refused HTLC add is a payment that did not fit, most
// often someone else's forward (beignet #1957). Both repeat daily, and the
// log is capped at MAX_EVENTS across every channel, so recording them would
// slowly push out the opens and closes this log exists to keep.
const NOT_CHANNEL_HISTORY_RE =
	/^(Remote warning:|(Insufficient balance for HTLC|Max pending HTLCs exceeded|Max HTLC value in flight exceeded|HTLC amount below remote minimum|Dust HTLC exposure limit exceeded)$)/i;

function namesAChannel(channelId) {
	return Boolean(channelId) && !/^0+$/.test(String(channelId));
}

class ChannelEventLog {
	constructor(dir, { warn } = {}) {
		this.log = new JsonlLog(path.join(dir, 'channel-events.jsonl'), {
			max: MAX_EVENTS,
			label: 'channel history',
			warn
		});
	}

	/**
	 * Record a daemon event if it tells a channel's story: a lifecycle event,
	 * or a node:error that names a channel (automatic force-close reasons like
	 * REESTABLISH_TIMEOUT_FORCE_CLOSED arrive that way and nowhere else), less
	 * the warnings and refused adds in NOT_CHANNEL_HISTORY_RE.
	 *
	 * Returns null for events that are not channel-shaped, otherwise
	 * { entry, persisted }: persisted is false when the entry lives only in
	 * this process's memory (unwritable disk, unreadable log), so the caller
	 * never mistakes a session-only note for the durable record.
	 */
	record(name, data) {
		if (!data || typeof data !== 'object') return null;
		if (!namesAChannel(data.channelId)) return null;
		const isError = name === 'node:error';
		if (!isError && !LIFECYCLE_EVENTS.has(name)) return null;
		if (isError && NOT_CHANNEL_HISTORY_RE.test(String(data.message || '').trim())) {
			return null;
		}
		const entry = {
			timestamp: data.timestamp || Date.now(),
			event: name,
			channelId: String(data.channelId)
		};
		if (data.initiator) entry.initiator = data.initiator;
		if (name === 'ffor:state' && data.state) entry.state = String(data.state);
		if (data.fundingTxid) entry.fundingTxid = String(data.fundingTxid);
		if (isError) {
			entry.code = data.code || 'ERROR';
			entry.message = data.message || 'Unknown error';
		}
		return this.log.append(entry);
	}

	/** Entries oldest first, optionally for one channel. */
	list({ channelId } = {}) {
		const all = this.log.all();
		return channelId ? all.filter((e) => e.channelId === channelId) : all;
	}
}

module.exports = { ChannelEventLog, MAX_EVENTS };
