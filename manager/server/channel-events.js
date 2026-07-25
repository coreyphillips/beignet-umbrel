'use strict';

const fs = require('fs');
const path = require('path');

// Durable per-wallet channel history. The daemon reports a channel's life
// (opening, ready, closing, and the reason an automatic force-close fired)
// only as transient events on its stream; the manager's in-memory rings die
// with the process. This log is the record that survives: without it, a
// channel that closed while nobody was watching has no story to tell, which
// is exactly the complaint that motivated it (a force-closed channel whose
// detail view could not say what happened or when).
const MAX_EVENTS = 500;

// The daemon SSE events that narrate a channel's lifecycle. `channel:voided`
// exists but is not relayed on the stream, so it cannot be recorded here.
const LIFECYCLE_EVENTS = new Set([
	'channel:opening',
	'channel:ready',
	'channel:pending-close',
	'channel:force-closing',
	'channel:closed'
]);

class ChannelEventLog {
	constructor(dir) {
		this.file = path.join(dir, 'channel-events.jsonl');
		this.entries = null; // loaded lazily so a stopped wallet is still readable
	}

	_load() {
		if (this.entries) return;
		this.entries = [];
		let raw;
		try {
			raw = fs.readFileSync(this.file, 'utf8');
		} catch (_) {
			return; // no history yet
		}
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			try {
				this.entries.push(JSON.parse(line));
			} catch (_) {
				/* a torn write loses one line, not the log */
			}
		}
	}

	/**
	 * Record a daemon event if it tells a channel's story: a lifecycle event,
	 * or a node:error that names a channel (automatic force-close reasons like
	 * REESTABLISH_TIMEOUT_FORCE_CLOSED arrive that way and nowhere else).
	 * Returns the recorded entry, or null if the event was not channel-shaped.
	 */
	record(name, data) {
		if (!data || typeof data !== 'object') return null;
		const isError = name === 'node:error' && data.channelId;
		if (!isError && !LIFECYCLE_EVENTS.has(name)) return null;
		if (!data.channelId) return null;
		const entry = {
			timestamp: data.timestamp || Date.now(),
			event: name,
			channelId: String(data.channelId)
		};
		if (data.initiator) entry.initiator = data.initiator;
		if (data.fundingTxid) entry.fundingTxid = String(data.fundingTxid);
		if (isError) {
			entry.code = data.code || 'ERROR';
			entry.message = data.message || 'Unknown error';
		}
		this._load();
		this.entries.push(entry);
		try {
			if (this.entries.length > MAX_EVENTS) {
				// Compact: keep the newest MAX_EVENTS and rewrite atomically, so a
				// crash mid-write leaves the old file rather than half a file.
				this.entries = this.entries.slice(-MAX_EVENTS);
				const tmp = `${this.file}.tmp`;
				fs.writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
				fs.renameSync(tmp, this.file);
			} else {
				fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
			}
		} catch (_) {
			/* an unwritable disk keeps the in-memory history for this session */
		}
		return entry;
	}

	/** Entries oldest first, optionally for one channel. */
	list({ channelId } = {}) {
		this._load();
		const all = channelId
			? this.entries.filter((e) => e.channelId === channelId)
			: this.entries;
		return all.slice();
	}
}

module.exports = { ChannelEventLog };
