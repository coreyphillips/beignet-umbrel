'use strict';

/**
 * Sibling wallets: two Lightning wallets in this container on the same
 * network. When they share a channel the manager keeps them connected over
 * loopback. Left to the engine, a payer that is not connected to a sibling
 * at send time dials whatever address it has, and a lightning-first request
 * names the primary's onion, so the dial goes out to Tor and back into this
 * same machine (beignet #853: up to 30 s per dial, twice).
 */

// How long after a sibling drops before it is dialed again. The engine's own
// reconnect gets the first try; this is the backstop for one that gave up or
// is dialing an onion address.
const SIBLING_REDIAL_MS = 5000;

/** The other Lightning wallets on this wallet's network with a known node id. */
function siblingsOf(rec, records) {
	if (!rec || rec.onchainOnly) return [];
	return (records || []).filter(
		(other) =>
			other.id !== rec.id &&
			other.network === rec.network &&
			!other.onchainOnly &&
			!!other.nodeId &&
			other.nodeId !== rec.nodeId
	);
}

/**
 * Both ends of a dropped link see the drop. The end with the lower node id
 * redials first and the other waits longer, so the two do not dial each
 * other at the same moment and each hold a socket for one peer. The later
 * redial only dials if the first did not connect.
 */
function redialDelay(ownNodeId, peerNodeId, baseMs = SIBLING_REDIAL_MS) {
	return String(ownNodeId) < String(peerNodeId) ? baseMs : baseMs * 3;
}

/** The siblings this wallet holds a channel with that still needs its peer. */
function channelSiblings(siblings, channels) {
	const peers = new Set(
		(channels || [])
			.filter((c) => c.state !== 'CLOSED' && c.state !== 'FORCE_CLOSED')
			.map((c) => c.peerPubkey)
	);
	return siblings.filter((s) => peers.has(s.nodeId));
}

module.exports = { SIBLING_REDIAL_MS, siblingsOf, redialDelay, channelSiblings };
