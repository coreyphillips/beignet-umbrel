// A wallet with Tor enabled routes every peer dial through Umbrel's Tor
// SOCKS proxy; when that proxy cannot build circuits, every connection
// times out with no clue why. Make the failure self-explanatory.
export function withTorHint(rec, message) {
	if (!rec?.tor || !/timed? ?out|timeout/i.test(message)) return message;
	return (
		`${message}. This wallet routes peer connections through Tor. ` +
		'If Tor on your Umbrel is unhealthy, all connections time out. ' +
		'Edit the wallet to turn Tor off, or restart Tor and retry.'
	);
}
