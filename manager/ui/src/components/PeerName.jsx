import { peerLabel } from '../lib/node-names.js';

/**
 * A peer's name as the tables show it: its alias from the network map, or a
 * muted word for why it has none, "Private peer" for a node that never
 * announced itself (with the reason on hover).
 */
export default function PeerName({ name }) {
	const label = peerLabel(name);
	return (
		<span className={label.muted ? 'peer-alias muted' : 'peer-alias'} title={label.title || undefined}>
			{label.text}
		</span>
	);
}
