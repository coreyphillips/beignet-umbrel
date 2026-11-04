/**
 * Sorting the daemon's node errors into what is actually wrong and what is
 * only worth knowing.
 *
 * Everything the daemon reports on its `node:error` stream arrives as an
 * error, but two kinds are not failures of this wallet:
 *
 * - Peer warnings. A BOLT 1 `warning` leaves the connection and every channel
 *   alone, and the daemon forwards it as CHANNEL_ERROR "Remote warning: ...",
 *   usually on the all-zero channel id and with no sender (beignet #1956).
 *   Core Lightning sends these about gossip it discards (beignet #1955).
 * - Payments a channel turned away because they did not fit: not enough
 *   spendable balance, too many HTLCs in flight, and so on. Most of these are
 *   other people's payments routing through this node, which the daemon
 *   reports exactly like a local send (beignet #1957).
 *
 * The manager's channel history applies the same split server-side
 * (manager/server/channel-events.js), so keep the two lists in step.
 */

const PEER_WARNING_RE = /^Remote warning:/i;

// The refusals Channel.addHtlc raises before an HTLC goes anywhere. None of
// them changes the channel; the payment simply did not fit this time.
const TURNED_AWAY = [
	'Insufficient balance for HTLC',
	'Max pending HTLCs exceeded',
	'Max HTLC value in flight exceeded',
	'HTLC amount below remote minimum',
	'Dust HTLC exposure limit exceeded'
];
const TURNED_AWAY_RE = new RegExp(`^(${TURNED_AWAY.join('|')})$`, 'i');

// Words that only appear in a warning about the network map.
const GOSSIP_RE =
	/channel_update|channel_announcement|node_announcement|gossip|dont_forward|\butxo\b|query_channel_range|query_short_channel_ids|reply_channel_range/i;

// The same two kinds anywhere in a raw log line, e.g. the manager's
// "node error [CHANNEL_ERROR] Remote warning: ..." echo.
const WARNING_LINE_RE = new RegExp(`Remote warning:|${TURNED_AWAY.join('|')}`, 'i');

/** True for a log line that reports one of the two kinds above. */
export function isWarningLogLine(line) {
	return WARNING_LINE_RE.test(String(line || ''));
}

export function isPeerWarning(err) {
	return PEER_WARNING_RE.test(String((err && err.message) || ''));
}

export function isTurnedAway(err) {
	return TURNED_AWAY_RE.test(String((err && err.message) || '').trim());
}

/** A warning's own words, without the daemon's prefix. */
export function peerWarningText(err) {
	return String((err && err.message) || '').replace(PEER_WARNING_RE, '').trim();
}

export function isGossipWarning(err) {
	return isPeerWarning(err) && GOSSIP_RE.test(peerWarningText(err));
}

/**
 * The channel an error is about, or null. Connection-level messages carry the
 * all-zero channel id, which names no channel at all.
 */
export function errorChannelId(err) {
	const id = err && err.channelId ? String(err.channelId) : '';
	return id && !/^0+$/.test(id) ? id : null;
}

/** 'warning' for the two kinds above, 'error' for everything else. */
export function nodeErrorKind(err) {
	return isPeerWarning(err) || isTurnedAway(err) ? 'warning' : 'error';
}

/**
 * Collapse repeats into one entry each, newest first. A node that is unhappy
 * repeats itself, and a peer re-sends the same gossip warning every day, so
 * without this a short window fills with copies and pushes the one line that
 * explains anything off the card.
 *
 * Each group is the newest occurrence plus `count` and `firstTimestamp`.
 */
export function groupNodeErrors(errors, limit = 15) {
	const groups = new Map();
	for (const e of errors || []) {
		if (!e) continue;
		const key = `${e.code || ''}|${errorChannelId(e) || ''}|${e.message || ''}`;
		const ts = Number(e.timestamp) || 0;
		const g = groups.get(key);
		if (!g) {
			groups.set(key, { ...e, count: 1, firstTimestamp: ts });
			continue;
		}
		g.count += 1;
		if (ts < g.firstTimestamp) g.firstTimestamp = ts;
		if (ts >= (Number(g.timestamp) || 0)) {
			Object.assign(g, e, { count: g.count, firstTimestamp: g.firstTimestamp });
		}
	}
	return [...groups.values()]
		.sort((a, b) => (Number(b.timestamp) || 0) - (Number(a.timestamp) || 0))
		.slice(0, limit);
}
