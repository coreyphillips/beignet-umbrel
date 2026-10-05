/**
 * Peer names from a wallet's network map (GET /graph/node), remembered so a
 * table polled every few seconds asks the daemon once per peer rather than
 * once per row on every poll.
 *
 * A node that announced itself has its alias. A node the map does not know
 * is a private peer: it never announced itself, as a phone wallet never does,
 * and the daemon answers NOT_FOUND, logging the miss each time. That answer
 * is remembered too, so a private peer stops filling the wallet's log. A
 * request that fails any other way (the daemon restarting, a timeout) is not
 * remembered, and the next poll asks again.
 */

/** How long an alias, or a node known without one, is trusted. */
export const KNOWN_MS = 10 * 60 * 1000;
/**
 * How long a node the map does not know is taken to be private. Shorter, so a
 * public node the map has not heard from yet (a wallet's first minutes, a
 * brand new node) is named soon after its announcement arrives.
 */
export const PRIVATE_MS = 5 * 60 * 1000;

const isNotFound = (err) => err?.code === 'NOT_FOUND' || err?.status === 404;

/**
 * A cache of peer names, keyed by wallet and pubkey, since every wallet has a
 * map of its own. `now` is the clock, for tests.
 */
export function createNodeNames({ now = () => Date.now() } = {}) {
	const entries = new Map();
	const pending = new Map();

	const fresh = (entry) => entry && now() - entry.at < (entry.name.private ? PRIVATE_MS : KNOWN_MS);

	function ask(api, wallet, pubkey) {
		const key = `${wallet}:${pubkey}`;
		const cached = entries.get(key);
		if (fresh(cached)) return Promise.resolve(cached.name);
		if (pending.has(key)) return pending.get(key);
		const asking = api
			.get(`/graph/node?pubkey=${pubkey}`)
			.then(
				(node) => {
					// The daemon answers with the node or not at all; anything else
					// is not an answer to remember.
					if (!node || typeof node !== 'object') return null;
					const name = { alias: node.alias || null, private: false };
					entries.set(key, { name, at: now() });
					return name;
				},
				(err) => {
					if (!isNotFound(err)) return null;
					const name = { alias: null, private: true };
					entries.set(key, { name, at: now() });
					return name;
				}
			)
			.finally(() => pending.delete(key));
		pending.set(key, asking);
		return asking;
	}

	return {
		/**
		 * The names of `pubkeys` on `wallet`'s map, asking only for those not
		 * already known, each once however many rows name it. Resolves to an
		 * object from pubkey to `{ alias, private }`, or to null for a pubkey
		 * whose lookup failed.
		 */
		async lookup(api, wallet, pubkeys) {
			const unique = [...new Set((pubkeys || []).filter((pk) => typeof pk === 'string' && pk))];
			const names = await Promise.all(unique.map((pk) => ask(api, wallet, pk)));
			return Object.fromEntries(unique.map((pk, i) => [pk, names[i]]));
		}
	};
}

/** The dashboard's one cache, shared by the tables that name peers. */
export const nodeNames = createNodeNames();

/**
 * How a table names a peer: its alias, or a muted word for why it has none.
 * `title` explains a private peer on hover.
 */
export function peerLabel(name) {
	if (name?.alias) return { text: name.alias, muted: false, title: null };
	if (name?.private)
		return {
			text: 'Private peer',
			muted: true,
			title: 'This node has not announced itself to the network, so the map has no name for it. A phone wallet never does.'
		};
	if (name) return { text: 'Unnamed node', muted: true, title: null };
	return { text: 'Unknown node', muted: true, title: null };
}
