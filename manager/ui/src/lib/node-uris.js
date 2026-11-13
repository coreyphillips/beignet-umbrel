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
 * The Iroh phone link and what it lets others see. Without relay-only the
 * phone connects directly when it can, so the link is for the owner's own
 * phone. With relay-only (beignet #1982) every connection stays on the
 * relay and the link can be handed out, which this only says once the
 * running daemon reports the mode: a link is never shown as private on the
 * record's word alone.
 */
function irohWay({ rec, info, relayOnlyAvailable }) {
	const custom = !!rec.iroh.relays?.length;
	const relayOnly = rec.iroh.relayOnly === true;
	const way = { key: 'iroh', label: 'Iroh phone link', uri: info.irohUri || null, relayOnly };
	if (!relayOnly) {
		return {
			...way,
			hint: info.irohListenError?.message || (way.uri
				? `Scan with Chicory to pair your own phone. Your phone and the relay can see this Umbrel's IP address. ${custom ? 'Custom relays disable n0 discovery.' : 'n0 discovery also sees your IP and publishes the endpoint record.'}`
				: 'Starting the Iroh listener. Its address will appear when ready.')
		};
	}
	if (relayOnlyAvailable === false) {
		return {
			...way,
			uri: null,
			hint: 'Relay only is set for this link and the bundled engine cannot provide it, so the link is off instead of being offered with direct connections.'
		};
	}
	if (info.irohListenError?.message) return { ...way, uri: null, hint: info.irohListenError.message };
	// `pending` marks a link that is on its way rather than off: the card
	// stays on it meanwhile instead of opening on another way and jumping back.
	if (!way.uri) {
		return {
			...way,
			pending: true,
			hint: 'Starting the Iroh listener. With relay only on, the link appears after a check of about 12 seconds that no address of this Umbrel is offered.'
		};
	}
	if (info.irohRelayOnly !== true) {
		return { ...way, uri: null, pending: true, hint: 'Relay only is set and the wallet has not started with it yet. The link appears once it has.' };
	}
	return {
		...way,
		hint:
			"Scan with Chicory to pair a phone. Relay only is on: every connection stays on the relay, so whoever holds this link cannot learn this Umbrel's IP address from it. " +
			(custom
				? "The relay's operator still sees it. Custom relays disable n0 discovery."
				: "The relay's operator still sees it: with the default relays that is n0, whose discovery also sees it and publishes the relay only."),
		warnings: relayOnlyWarnings(rec)
	};
}

/**
 * What still gives this Umbrel's address away while the link itself does
 * not. The link carries the wallet's Lightning node id, so anything that
 * ties that id to an address undoes Relay only from outside Iroh. These are
 * shown apart from the hint, as warnings: each one is a reason not to hand
 * the link out yet, and the tail of a long hint is where nobody reads.
 */
function relayOnlyWarnings(rec) {
	const out = [];
	const mode = modeOf(rec);
	if (rec.announce && rec.publicAddress) {
		out.push(
			'This wallet announces its public address, and the link carries the node id that address is listed under. Turn announcing off, or use Tor mode, before handing the link out.'
		);
	}
	if (usesPublic(mode)) {
		out.push(
			`This wallet is in ${MODE_LABELS[mode]} mode: peers you connect to yourself, and peers it saved before Relay only was turned on, are dialed directly and see this Umbrel's IP address. Use Tor mode for a link you post publicly.`
		);
	}
	return out;
}

/**
 * The private Iroh phone link, followed by the ways other peers can reach this node: the
 * public address (Clearnet and Hybrid), the Tor address (Tor and Hybrid),
 * and the address on the home network, which every wallet has because the
 * app publishes the wallet ports on the Umbrel. `uri` is null with a `hint`
 * saying why when a way is not there yet.
 */
export function nodeUris({ nodeId, rec, lanHost, info, relayOnlyAvailable }) {
	const mode = modeOf(rec);
	const out = [];
	if (rec?.iroh?.enabled && !rec?.onchainOnly && info?.irohAvailable) {
		out.push(irohWay({ rec, info, relayOnlyAvailable }));
	}
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
