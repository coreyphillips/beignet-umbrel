/**
 * Why a Lightning payment has no route, in the wallet's own figures.
 *
 * The daemon answers a failed estimate with one code, NO_ROUTE, for four
 * different situations: no channel to send from, a channel that takes no new
 * payment yet, too little to send at all, and a network map that reaches the
 * recipient from none of the channels that could carry the amount. Everything
 * it decided from is readable from its own API (the channel list, the
 * liquidity figures, the peer list and the graph), so the card reads the same
 * facts and says which one it was. The phone wallet's engine does this for
 * its single primary node (portable/no-route.ts); this is the same reading
 * for any wallet, with the invoice's routing hints naming the node the
 * payment has to pass through.
 *
 * The field case this was written for: a wallet holding 96,713 sats over two
 * channels could not pay 50,000 sats, because the invoice was reachable only
 * through one peer, the channel with that peer held 10,033 sats, and the
 * other channel led to a node with no other public channel in the map. The
 * daemon said "no route or invalid invoice" and nothing else.
 */
import { fmtSats, shortId } from './format.js';

/** Codes after which pressing Pay cannot do better than the estimate did. */
export const BLOCKS_PAY = new Set(['NO_CHANNEL', 'CHANNEL_NOT_READY', 'INSUFFICIENT_FUNDS']);

// The daemon's states for a channel on its way out, in any spelling.
const CLOSING = /CLOS|SHUTTING_DOWN/;

// Same rule as the Send tab: the daemon marks channels that take a new HTLC
// with htlcUsable (NORMAL, or mid-splice and still paying); older daemons
// lack the flag, so NORMAL remains the fallback.
const usable = (c) => c.htlcUsable ?? c.state === 'NORMAL';

/**
 * Whether a payment's failure text is the router's no-route, as
 * /invoice/pay-safe reports it ("[NO_ROUTE] No route found ...") and as the
 * demo mock words it.
 */
export function isNoRouteFailure(failureDescription) {
	const said = String(failureDescription || '');
	return /^\[NO_ROUTE\]/.test(said) || /\bno route\b/i.test(said);
}

const hintRoutes = (decoded) => (Array.isArray(decoded?.routingHints) ? decoded.routingHints : []);

/** The first hop of each hint route: the node the payment has to reach. */
function hintNodes(decoded) {
	const out = [];
	for (const route of hintRoutes(decoded)) {
		const first = Array.isArray(route) ? route[0] : route;
		const pk = first && first.pubkey;
		if (typeof pk === 'string' && pk && !out.includes(pk)) out.push(pk);
	}
	return out;
}

/**
 * The nodes this payment can enter the recipient through. A hinted invoice
 * names them; one without hints can only be reached at the recipient itself.
 * A recipient we hold a channel with is reached over that channel whatever
 * the hints say, so it is listed first.
 */
function gateways(decoded, channels) {
	const payee = decoded?.payeeNodeKey || null;
	const hinted = hintNodes(decoded);
	const direct = payee && channels.some((c) => c.peerPubkey === payee && !CLOSING.test(String(c.state)));
	if (direct) return [payee, ...hinted.filter((pk) => pk !== payee)];
	if (hinted.length > 0) return hinted;
	return payee ? [payee] : [];
}

/** The pubkeys worth asking GET /graph/node about before explaining. */
export function noRouteLookups(decoded, channels) {
	const rows = Array.isArray(channels) ? channels : [];
	const out = [];
	for (const pk of [...gateways(decoded, rows), ...rows.filter(usable).map((c) => c.peerPubkey)]) {
		if (typeof pk === 'string' && pk && !out.includes(pk)) out.push(pk);
	}
	return out;
}

// A node as the card names it: the alias the map has for it, with the short
// id so two "Node" aliases stay apart, or the short id alone.
const nameOf = (pk, graph) => {
	const known = graph && graph[pk];
	return known && known.alias ? `${known.alias} (${shortId(pk)})` : shortId(pk);
};

const list = (names) =>
	names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const sum = (rows) => rows.reduce((total, c) => total + (Number(c.localBalanceSats) || 0), 0);

const inWords = (state) => String(state || 'not ready').toLowerCase().replace(/_/g, ' ');

// An unknown peer list must not turn into "your peer is down": only a list
// that names the peer as anything but ready says so.
const connected = (peers, pk) =>
	!Array.isArray(peers) || peers.some((p) => p.pubkey === pk && /^(ready|connected)$/i.test(String(p.state)));

const PAY_STAYS = 'Pay stays available because the wallet may still split the payment across channels when it tries.';

const REMEDY =
	"To pay through that node, put more of this wallet's funds on the channel with it: have that node pay an invoice from this wallet, or open a larger channel to it. Funds on channels with other nodes only reach it through public channels.";

/**
 * The reason, in the order a user can act on it: a channel to send from,
 * whether it takes a new payment, whether the wallet holds enough at all, and
 * only then where the map runs out. Returns { code, message, remedy }, where
 * remedy is the line for the "?" beside the note when moving funds onto one
 * channel is the answer, and null otherwise.
 *
 * facts: amountSats; decoded (payeeNodeKey, routingHints); channels (the
 * /channels rows); liquidity (/liquidity, or null); peers (/peers, or null);
 * graph ({ [pubkey]: { alias, channelCount } | null }, null meaning the map
 * does not know the node, a missing key meaning the lookup failed); graphInfo
 * (/graph/info, or null); lightningFirst.
 */
export function explainNoRoute(facts) {
	const f = facts || {};
	const amount = Number(f.amountSats) || 0;
	const payee = f.decoded?.payeeNodeKey || null;
	const graph = f.graph || {};
	const answer = (code, message, remedy = null) => ({ code, message, remedy });

	if (!(amount > 0) || !payee) {
		return answer('INVALID_INVOICE', 'The wallet could not read the amount or the recipient of this invoice.');
	}

	const channels = Array.isArray(f.channels) ? f.channels : [];
	const open = channels.filter((c) => !CLOSING.test(String(c.state)));
	if (open.length === 0) {
		return answer(
			'NO_CHANNEL',
			f.lightningFirst
				? 'This wallet has no Lightning channel yet. Deposit bitcoin or receive a Lightning payment on the Receive tab, and your channel appears by itself.'
				: 'This wallet has no Lightning channel to send from. Open one in the Channels tab.'
		);
	}

	const ready = open.filter(usable);
	if (ready.length === 0) {
		const down = open.find((c) => !connected(f.peers, c.peerPubkey));
		if (down) {
			return answer(
				'CHANNEL_NOT_READY',
				`Your channel with ${nameOf(down.peerPubkey, graph)} is open, but its peer is not connected right now, so nothing can be sent through it. It resumes by itself when the peer comes back.`
			);
		}
		if (open.some((c) => c.state === 'SPLICING')) {
			return answer(
				'CHANNEL_NOT_READY',
				'Your channel is mid-splice, and payments resume when the splice transaction confirms and locks.'
			);
		}
		return answer('CHANNEL_NOT_READY', `Your channel cannot send yet (${inWords(open[0].state)}). Payments resume once it is ready.`);
	}

	const sendable = Number.isFinite(f.liquidity?.sendableSats) ? f.liquidity.sendableSats : sum(ready);
	if (amount >= sendable) {
		const reserve = Number(f.liquidity?.reserveSats) || 0;
		return answer(
			'INSUFFICIENT_FUNDS',
			`This wallet can send up to ${fmtSats(sendable)} over Lightning right now, which does not cover this ${fmtSats(
				amount
			)} payment and its routing fee.${reserve > 0 ? ` ${fmtSats(reserve)} of the channel balance is held back as the channel reserve.` : ''}`
		);
	}

	const head = `No route found for ${fmtSats(amount)}.`;
	const G = gateways(f.decoded, open);
	const viaOpen = open.filter((c) => G.includes(c.peerPubkey));
	const via = viaOpen.filter(usable);
	const gatewayNames = list(G.filter((pk) => viaOpen.some((c) => c.peerPubkey === pk)).map((pk) => nameOf(pk, graph)));
	const those = viaOpen.length > 1 && new Set(viaOpen.map((c) => c.peerPubkey)).size > 1 ? 'those nodes' : 'that node';
	// A recipient we hold a channel with is its own gateway, and the sentence
	// says so rather than calling the recipient a node the invoice passes.
	const direct = G[0] === payee && viaOpen.some((c) => c.peerPubkey === payee);
	const reachedThrough = direct
		? `This wallet has a direct channel with the recipient, ${nameOf(payee, graph)}`
		: `This invoice can be reached only through ${gatewayNames}`;

	if (via.length > 0) {
		const held = sum(via);
		const lead = direct
			? `${reachedThrough}, and holds ${fmtSats(held)} on it`
			: `${reachedThrough}, and this wallet holds ${fmtSats(held)} on its ${via.length > 1 ? 'channels' : 'channel'} with ${those}`;
		if (held < amount) {
			const others = ready.filter((c) => !G.includes(c.peerPubkey));
			const parts = [`${head} ${lead}, less than the payment.`];
			if (others.length > 0) {
				const peers = [...new Set(others.map((c) => c.peerPubkey))];
				let cause = '';
				if (peers.length === 1) {
					const known = graph[peers[0]];
					const ours = others.find((c) => c.peerPubkey === peers[0]);
					if (known === null) cause = ', which the map does not know';
					else if (known && Number(known.channelCount) <= 1 && ours && ours.isPrivate === false) {
						cause = ', whose only public channel in the map is this one';
					}
				}
				parts.push(
					`The other ${fmtSats(sum(others))} sit on ${others.length > 1 ? 'channels' : 'a channel'} with ${list(
						peers.map((pk) => nameOf(pk, graph))
					)}, and this wallet's map of the Lightning network shows no path from there to ${those === 'those nodes' ? 'them' : 'that node'}${cause}.`
				);
			}
			parts.push(PAY_STAYS);
			return answer('NO_ROUTE', parts.join(' '), REMEDY);
		}
		const past = direct
			? 'the estimate could not fit the payment on it'
			: `the estimate found no path from ${those === 'those nodes' ? 'them' : 'that node'} to the recipient with enough capacity`;
		return answer(
			'NO_ROUTE',
			`${head} ${lead}, but the channel reserve and the routing fee come out of that, and ${past}. ${PAY_STAYS}`,
			REMEDY
		);
	}

	if (viaOpen.length > 0) {
		const stuck = viaOpen[0];
		const why = connected(f.peers, stuck.peerPubkey) ? inWords(stuck.state) : 'its peer is not connected';
		const which = direct ? 'and it' : `and this wallet's channel with ${those}`;
		return answer(
			'CHANNEL_NOT_READY',
			`${head} ${reachedThrough}, ${which} cannot send right now (${why}). It resumes by itself once the channel is ready.`
		);
	}

	const mapEmpty = f.graphInfo != null && Number(f.graphInfo.channelCount) === 0;
	const hinted = hintNodes(f.decoded);
	if (hinted.length > 0) {
		const it = hinted.length > 1 ? 'them' : 'it';
		const lead = `${head} This invoice can be reached only through ${list(hinted.map((pk) => nameOf(pk, graph)))}, and this wallet has no channel with ${
			hinted.length > 1 ? 'those nodes' : 'that node'
		}`;
		if (mapEmpty) {
			return answer(
				'NO_ROUTE',
				`${lead}, and its map of the Lightning network is empty, so it cannot reach ${it} through anyone else yet. The map fills in by itself as the node syncs.`
			);
		}
		if (hinted.every((pk) => graph[pk] === null)) {
			return answer('NO_ROUTE', `${lead} and its map of the Lightning network does not know ${it} either.`);
		}
		return answer('NO_ROUTE', `${lead}, and its map of the Lightning network found no path to ${it} with enough capacity. ${PAY_STAYS}`);
	}

	if (graph[payee] === null) {
		return answer(
			'NO_ROUTE',
			`${head} The recipient (${shortId(
				payee
			)}) is not in this wallet's map of the Lightning network, and the invoice carries no routing hints, so there is nothing to find a path to. Ask the recipient for an invoice that includes routing hints.`
		);
	}
	if (mapEmpty) {
		return answer(
			'NO_ROUTE',
			`${head} This wallet's map of the Lightning network is empty, so it cannot reach anyone it has no channel with. It fills in by itself as the node syncs, so try again in a few minutes.`
		);
	}
	const peers = [...new Set(ready.map((c) => c.peerPubkey))];
	const deadEnd = (pk) => graph[pk] === null || (graph[pk] && Number(graph[pk].channelCount) <= 1);
	if (peers.every(deadEnd)) {
		const names = list(peers.map((pk) => nameOf(pk, graph)));
		const plural = peers.length > 1;
		return answer(
			'NO_ROUTE',
			`${head} This wallet's map of the Lightning network shows no way past ${names}, which ${
				peers.every((pk) => graph[pk] === null) ? 'the map does not know at all' : `${plural ? 'have' : 'has'} no public channel there leading anywhere else`
			}. Open a channel with a well connected node.`
		);
	}
	return answer('NO_ROUTE', `No route to the recipient (${nameOf(payee, graph)}) was found with enough capacity for ${fmtSats(amount)}. ${PAY_STAYS}`);
}
