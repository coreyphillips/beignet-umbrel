import { Field, Help, Segmented } from './ui.jsx';
import { MODE_LABELS, MODES, hostForUri, usesPublic } from '../lib/node-uris.js';

/**
 * The per-wallet network mode (umbrel #193), shared by the create form and
 * the edit dialog so both read the same: Tor, Clearnet or Hybrid, the public
 * address the two direct modes announce, and whether the wallet announces at
 * all. What each mode does stays in one line under the choice; the privacy
 * cost and the port on the home network stay behind the "?".
 */
const NOTES = {
	tor: 'Every peer is reached over Tor and only the Tor address is announced. Peers never see your home IP; connections take the longest to set up.',
	clearnet: 'Clearnet peers are dialed directly and Tor peers over Tor. Only your public address is announced, so peers find you there and not over Tor.',
	hybrid: 'Clearnet peers are dialed directly and Tor peers over Tor. Both the Tor address and your public address are announced.'
};

export default function NetworkModeField({
	mode,
	onMode,
	publicHost,
	onPublicHost,
	announce,
	onAnnounce,
	// The host port peers dial, known once the wallet has its port.
	publicPort = null,
	torAvailable = true,
	// The engine's onion-only proxy scope (beignet #963); without it the two
	// direct modes dial with no proxy at all.
	torProxyScopeAvailable = true
}) {
	const host = String(publicHost || '').trim();
	const portHint = publicPort
		? `Peers reach this wallet at ${host ? hostForUri(host) : 'that address'}:${publicPort}. Forward TCP port ${publicPort} on your router to this Umbrel.`
		: 'The port to forward on your router is shown on the Overview tab once the wallet exists.';
	return (
		<>
			<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
				Network
				<Help>
					How this wallet reaches its peers and where they reach it, the Tor and Clearnet choice of
					Umbrel&apos;s Lightning Node app. Tor: every peer over Tor, only the Tor address announced.
					Clearnet: clearnet peers dialed directly, Tor peers over Tor, only your public address
					announced. Hybrid: the same dials, with both addresses announced. Clearnet and Hybrid put
					your public address in the public Lightning gossip and show it to every peer you connect
					to. Whatever the mode, the wallet&apos;s port also answers on your home network, because
					the app publishes the wallet ports on this Umbrel. Behind a home router nothing reaches
					it from the internet unless you forward the port; an Umbrel with a public IPv6 address
					is reachable on it directly. Either way a peer gets nowhere without this node&apos;s
					public key: the Lightning transport is authenticated and encrypted end to end.
				</Help>
			</div>
			<Segmented
				id="network-mode"
				value={mode}
				onChange={onMode}
				options={MODES.map((key) => [key, MODE_LABELS[key], key === 'tor' && !torAvailable, 'This app has no Tor proxy'])}
			/>
			<span className="field-hint" style={{ display: 'block', margin: '8px 0 12px' }} data-testid="network-note">
				{NOTES[mode] || NOTES.hybrid}
			</span>
			{!torProxyScopeAvailable && mode !== 'tor' && (
				<div className="info-note">
					This app&apos;s engine cannot keep Tor for onion peers only, so in this mode clearnet peers are
					dialed without a proxy and onion peers are out of reach until the app updates its engine.
				</div>
			)}
			{usesPublic(mode) && (
				<Field
					label="Public address"
					help="Your public IP or domain name, as peers on the internet see it. Nothing looks it up for you: your router's status page or a dynamic DNS name is where to find it. A host only; the port is fixed by the app."
					hint={
						mode === 'clearnet' && !host
							? 'Clearnet needs a public address. Choose Hybrid to keep the Tor address without one.'
							: portHint
					}
				>
					<input
						data-testid="public-host"
						value={publicHost}
						placeholder="node.example.com or 203.0.113.4"
						onChange={(e) => onPublicHost(e.target.value)}
					/>
				</Field>
			)}
			<label className="checkbox field">
				<input
					type="checkbox"
					data-testid="announce"
					checked={!!announce}
					onChange={(e) => onAnnounce(e.target.checked)}
				/>
				Announce this node so peers can find it and open channels to you
				<Help>
					On: the addresses the mode uses go into the public Lightning gossip, onto the Overview
					tab to share, and into this wallet&apos;s payment requests so a payer can reach it
					directly. Off: nothing is announced and no address is handed out; the wallet still dials
					out, and wallets in this app still reach it.
				</Help>
			</label>
		</>
	);
}
