// A wallet with Tor enabled routes every peer dial through Umbrel's Tor
// SOCKS proxy; when that proxy cannot build circuits, connections fail with no
// clue why. A dead proxy surfaces as more than just a timeout (SOCKS/refused/
// unreachable wording too), so match the common connection-failure shapes and
// make the failure self-explanatory.
const CONN_FAILURE =
	/timed? ?out|timeout|socks|proxy|refused|unreachable|no route|network is unreachable|econn|etimedout|ehostunreach|failed to connect|connection (failed|closed|reset|refused)/i;

// The peer completed the encrypted handshake and then hung up without saying
// anything. That is what a node refusing the connection outright looks like on
// the wire, and it is a policy decision on their side, not a fault on ours.
const HANDSHAKE_CLOSED = /closed during handshake|closed before read completed/i;

export function withTorHint(rec, message) {
	if (!rec?.tor || !CONN_FAILURE.test(String(message || ''))) return message;
	return (
		`${message}. This wallet routes peer connections through Tor. ` +
		'If Tor on your Umbrel is unhealthy, connections fail. ' +
		'Edit the wallet to turn Tor off, or restart Tor and retry.'
	);
}

/**
 * Explain a failed peer dial.
 *
 * Large custodial and exchange nodes commonly cap how many peers they will hold
 * a connection open for when there is no channel between you, and drop the rest
 * straight after the handshake. Dialling them to open a channel simply will not
 * work, however many times it is retried, and the raw error ("connection closed
 * during handshake") gives no hint of that.
 */
export function withPeerHint(rec, message) {
	const text = String(message || '');
	if (HANDSHAKE_CLOSED.test(text)) {
		return (
			`${text}. The peer accepted the connection and then closed it without a reason. ` +
			'Large custodial and exchange nodes routinely refuse connections from nodes ' +
			'they have no channel with, so an open to them cannot get started. ' +
			'Try a node that accepts incoming channels, or ask this one to open the channel to you.'
		);
	}
	return withTorHint(rec, message);
}
