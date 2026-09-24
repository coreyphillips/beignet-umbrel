/**
 * The network mode (umbrel #193) as the dashboard reads it off a wallet
 * record: which addresses the mode uses, and the connection URIs a peer can
 * be handed, one per way in, each with a reason when it is not there.
 */
export const MODES = ['tor', 'clearnet', 'hybrid'];
export const MODE_LABELS = { tor: 'Tor', clearnet: 'Clearnet', hybrid: 'Hybrid' };

export function modeOf(rec) {
	return MODES.includes(rec?.networkMode) ? rec.networkMode : 'hybrid';
}

export const usesOnion = (mode) => mode === 'tor' || mode === 'hybrid';
export const usesPublic = (mode) => mode === 'clearnet' || mode === 'hybrid';

/** A host as it goes before a port: IPv6 in brackets, the rest as is. */
export function hostForUri(host) {
	const h = String(host || '').trim();
	return h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
}

const ANNOUNCE_OFF = 'Announcing is off for this wallet. Turn it on with Edit above.';

/**
 * The ways a peer can reach this node, in the order worth sharing: the
 * public address (Clearnet and Hybrid), the Tor address (Tor and Hybrid),
 * and the address on the home network, which every wallet has because the
 * app publishes the wallet ports on the Umbrel. `uri` is null with a `hint`
 * saying why when a way is not there yet.
 */
export function nodeUris({ nodeId, rec, lanHost }) {
	const mode = modeOf(rec);
	const out = [];
	if (usesPublic(mode)) {
		let hint;
		if (rec?.publicAddress) {
			hint = 'Your public address. Peers anywhere reach it once the port is forwarded on your router to this Umbrel.';
		} else if (!rec?.publicHost) {
			hint = 'No public address set for this wallet. Add one with Edit above.';
		} else if (!rec?.announce) {
			hint = ANNOUNCE_OFF;
		} else if (rec?.listenPort && !rec?.publicPort) {
			hint =
				'This wallet is past the thirty ports the app publishes and the onion maps, so it has no public port and no Tor address; only wallets in this app reach it.';
		} else {
			hint = 'Not available yet.';
		}
		out.push({
			key: 'clearnet',
			label: 'Clearnet',
			uri: nodeId && rec?.publicAddress ? `${nodeId}@${rec.publicAddress}` : null,
			hint
		});
	}
	if (usesOnion(mode)) {
		let hint;
		if (rec?.onionAddress) {
			hint = 'Reachable over Tor with no port forwarding. Share this to receive inbound channels.';
		} else if (!rec?.announce) {
			hint = ANNOUNCE_OFF;
		} else {
			hint = 'The app has not published its Tor address yet, or this wallet is past the ports it maps.';
		}
		out.push({
			key: 'tor',
			label: 'Tor',
			uri: nodeId && rec?.onionAddress ? `${nodeId}@${rec.onionAddress}` : null,
			hint
		});
	}
	out.push({
		key: 'local',
		label: 'Local network',
		uri: nodeId && lanHost && rec?.publicPort ? `${nodeId}@${lanHost}:${rec.publicPort}` : null,
		hint:
			rec?.listenPort && !rec?.publicPort
				? 'This wallet is past the thirty ports the app publishes and the onion maps, so only wallets in this app reach it.'
				: rec?.publicPort
				? 'Reachable from other machines on your home network, at the address you use to open this dashboard.'
				: 'Not available yet.'
	});
	return out;
}
