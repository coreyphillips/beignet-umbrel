// A wallet with Tor enabled routes every peer dial through Umbrel's Tor
// SOCKS proxy; when that proxy cannot build circuits, connections fail with no
// clue why. A dead proxy surfaces as more than just a timeout (SOCKS/refused/
// unreachable wording too), so match the common connection-failure shapes and
// make the failure self-explanatory.
const CONN_FAILURE =
	/timed? ?out|timeout|socks|proxy|refused|unreachable|no route|network is unreachable|econn|etimedout|ehostunreach|failed to connect|connection (failed|closed|reset|refused)/i;

export function withTorHint(rec, message) {
	if (!rec?.tor || !CONN_FAILURE.test(String(message || ''))) return message;
	return (
		`${message}. This wallet routes peer connections through Tor. ` +
		'If Tor on your Umbrel is unhealthy, connections fail. ' +
		'Edit the wallet to turn Tor off, or restart Tor and retry.'
	);
}
