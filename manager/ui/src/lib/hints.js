// A wallet with Tor enabled routes every peer dial through Umbrel's Tor
// SOCKS proxy; when that proxy cannot build circuits, connections fail with no
// clue why. A dead proxy surfaces as more than just a timeout (SOCKS/refused/
// unreachable wording too), so match the common connection-failure shapes and
// make the failure self-explanatory.
const CONN_FAILURE =
	/timed? ?out|timeout|socks|proxy|refused|unreachable|no route|network is unreachable|econn|etimedout|ehostunreach|failed to connect|connection (failed|closed|reset|refused)/i;

// The peer accepted the TCP connection and then hung up during the encrypted
// handshake, without saying why. Several different causes look identical here,
// so the hint lists them rather than asserting one.
const HANDSHAKE_CLOSED = /closed during handshake|closed before read completed/i;

// umbrelOS hands each installed app a web page on a port in this range. They are
// HTTP servers, not Lightning listeners: dialling one completes the TCP connect
// and then dies in the handshake, because the web server is being fed binary
// noise and hangs up. Reaching for the port shown in the browser is an easy
// mistake, so call it out specifically.
const UMBREL_APP_PORT_MIN = 2000;
const UMBREL_APP_PORT_MAX = 2999;

// The conventional Lightning p2p ports. When the dial already used one of these
// the port is not worth raising as a suspect.
const LIGHTNING_PORTS = new Set([9735, 9736, 9737, 9738, 9739, 9740]);

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
 * A peer that completes the TCP connect and then closes during the handshake
 * gives us nothing to go on: the same failure covers a wrong port, a wrong
 * pubkey for that address, and a node that simply refuses unknown peers. Rather
 * than pick one and be confidently wrong, name the likely causes, cheapest to
 * check first, and lead with the wrong-port case when the port looks like an
 * Umbrel app's web page rather than a Lightning listener.
 */
export function withPeerHint(rec, message, { port } = {}) {
	const text = String(message || '');
	if (!HANDSHAKE_CLOSED.test(text)) return withTorHint(rec, message);

	const p = parseInt(port, 10);
	const looksLikeAppPort =
		Number.isFinite(p) && p >= UMBREL_APP_PORT_MIN && p <= UMBREL_APP_PORT_MAX;

	const lead =
		`${text}. The peer accepted the connection and then closed it during the ` +
		'encrypted handshake, without giving a reason. That usually means one of:';

	const causes = [];
	if (looksLikeAppPort) {
		causes.push(
			`Port ${p} is the port of an app's web page on Umbrel, not a Lightning port. ` +
				"Use the node's Lightning peer port instead, which is 9735 for Umbrel's " +
				'Core Lightning and Lightning Node apps. The port shown in the browser is ' +
				'not the one to connect to.'
		);
	} else if (!LIGHTNING_PORTS.has(p)) {
		// Already a conventional Lightning port, so do not send them chasing it.
		causes.push(
			"The port is not the node's Lightning peer port (usually 9735). A web or API " +
				'port accepts the connection and then hangs up.'
		);
	}
	causes.push('The pubkey does not match the node actually listening at that address.');
	causes.push(
		'The node refuses peers it has no channel with. Large custodial and exchange ' +
			'nodes commonly do this, and an open to them cannot get started.'
	);

	return `${lead} ${causes.map((c, i) => `(${i + 1}) ${c}`).join(' ')}`;
}
