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

// The daemon SSE events that narrate a channel's lifecycle. channel:resolved
// (every on-chain output of a close irrevocably swept, relayed since beignet
// 0.9.0) is the terminal one: after it the story is complete.
const LIFECYCLE_EVENTS = new Set([
	'channel:opening',
	'channel:ready',
	'channel:pending-close',
	'channel:force-closing',
	'channel:closed',
	'channel:resolved'
]);

class ChannelEventLog {
	constructor(dir, { warn } = {}) {
		this.file = path.join(dir, 'channel-events.jsonl');
		this.entries = null; // loaded lazily so a stopped wallet is still readable
		this.warn = warn || (() => {});
		// Set when the file exists but cannot be read. Writing through that would
		// compact over history we could not see, destroying it; a broken log
		// records in memory only, and says so.
		this.broken = false;
	}

	_load() {
		if (this.entries) return;
		this.entries = [];
		let raw;
		try {
			raw = fs.readFileSync(this.file, 'utf8');
		} catch (err) {
			if (err && err.code === 'ENOENT') return; // genuinely no history yet
			this.broken = true;
			this.warn(
				`channel history unreadable (${err.message}); recording in memory only for this session`
			);
			return;
		}
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			try {
				this.entries.push(JSON.parse(line));
			} catch (err) {
				// A torn write loses one line, not the log; but say so rather than
				// silently presenting a shortened history as complete.
				this.warn(`ignoring malformed channel-event entry: ${err.message}`);
			}
		}
	}

	/**
	 * Record a daemon event if it tells a channel's story: a lifecycle event,
	 * or a node:error that names a channel (automatic force-close reasons like
	 * REESTABLISH_TIMEOUT_FORCE_CLOSED arrive that way and nowhere else).
	 *
	 * Returns null for events that are not channel-shaped, otherwise
	 * { entry, persisted }: persisted is false when the entry lives only in
	 * this process's memory (unwritable disk, unreadable log), so the caller
	 * never mistakes a session-only note for the durable record.
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
		let persisted = false;
		if (!this.broken) {
			try {
				if (this.entries.length > MAX_EVENTS) {
					// Compact: keep the newest MAX_EVENTS and rewrite atomically, so a
					// crash mid-write leaves the old file rather than half a file.
					this.entries = this.entries.slice(-MAX_EVENTS);
					const tmp = `${this.file}.tmp`;
					fs.writeFileSync(
						tmp,
						this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
					);
					fs.renameSync(tmp, this.file);
				} else {
					fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
				}
				persisted = true;
			} catch (err) {
				this.warn(
					`channel history write failed (${err.message}); entry kept in memory only`
				);
			}
		}
		return { entry, persisted };
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

module.exports = { ChannelEventLog, MAX_EVENTS };
