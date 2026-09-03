/**
 * What a lightning-first wallet's page says, derived once from what the
 * daemon and the manager report (the pattern of lib/recovery.js).
 *
 * A lightning-first wallet has one balance the user sees. Underneath it are
 * three kinds of sats: spendable over Lightning now, arriving (on-chain
 * deposits waiting to confirm, confirmed deposits waiting to move into the
 * home channel, channel funding not yet usable), and receivable (the primary's
 * side of the home channel). This module is where those three are told
 * apart, so every card reads them the same way.
 */

// The manager moves confirmed on-chain funds into the home channel at or
// above this (manager/server/lfbw.js CHANNELIZE_FLOOR_SATS).
export const CHANNELIZE_FLOOR_SATS = 25000;
// Headroom asked of a JIT provisioning so the channel is not exhausted by
// the very payment that created it.
export const INBOUND_HEADROOM_SATS = 10000;

const CLOSED = new Set(['CLOSED', 'FORCE_CLOSED']);
const usable = (c) => (c.htlcUsable != null ? !!c.htlcUsable : c.state === 'NORMAL');

/** The wallet's channels with its primary, live ones only. */
export function primaryChannels(channels, primaryPubkey) {
	return (channels || []).filter((c) => c.peerPubkey === primaryPubkey && !CLOSED.has(c.state));
}

/** The one usable channel with the primary, or null. */
export function homeChannel(channels, primaryPubkey) {
	return primaryChannels(channels, primaryPubkey).find(usable) || null;
}

/**
 * The wallet's live channels with its PREVIOUS primary (the manager records
 * one when the primary is re-pointed and forgets it once these are gone):
 * their balance is part of Total and must stay findable on the page.
 */
export function previousPrimaryChannels(channels, previousPrimary) {
	if (!previousPrimary || !previousPrimary.pubkey) return [];
	return primaryChannels(channels, previousPrimary.pubkey);
}

/**
 * Which invoice to mint. `plain` when the home channel can take the amount
 * as it stands, so a briefly offline primary does not block a receive the
 * channel already covers; `jit` when the primary has to provision inbound
 * first (POST /jit/invoice registers the intent with the primary, which
 * opens a channel when none exists and splices the existing one bigger
 * when the payment outgrows it); a refusal when nothing can be minted yet.
 */
export function planInvoice({
	wantedSats = 0,
	channels,
	primaryPubkey,
	setup,
	primaryRunning = true,
	primaryConnected = true
}) {
	if (setup !== 'ready' || !primaryPubkey) return { kind: 'refuse', code: 'NOT_READY' };
	const inbound = primaryChannels(channels, primaryPubkey)
		.filter(usable)
		.reduce((sum, c) => sum + (c.remoteBalanceSats || 0), 0);
	const covered = wantedSats > 0 ? inbound >= wantedSats : inbound > 0;
	if (covered) return { kind: 'plain' };
	if (!primaryRunning) return { kind: 'refuse', code: 'PRIMARY_DOWN', reason: 'not-running' };
	// A primary whose daemon is up but whose peer connection is down (a Tor
	// reestablish window, say) cannot provision either: the intent never
	// reaches it, and the invoice would be minted only to fail.
	if (!primaryConnected) return { kind: 'refuse', code: 'PRIMARY_DOWN', reason: 'not-connected' };
	return { kind: 'jit' };
}

/**
 * What to say when a payment is larger than Can send but not larger than
 * Total: the difference is arriving, and the figures say how (umbrel #89).
 * Null when the amount is payable now or exceeds Total, which stays the
 * plain refusal. `status` is lfbwStatus().
 */
export function arrivingFundsNote(amountSats, status) {
	if (!status || !(amountSats > 0)) return null;
	if (amountSats <= status.canSend || amountSats > status.total) return null;
	const short = amountSats - status.canSend;
	const parts = [];
	if (status.unconfirmed > 0) {
		parts.push(
			`${fmt(status.unconfirmed)} sats are arriving on-chain: they need one confirmation, and then a move into your channel, so about two blocks`
		);
	}
	if (status.confirmedOnchain > 0) {
		parts.push(
			status.feeWait
				? `${fmt(status.confirmedOnchain)} sats have confirmed and are waiting on the fee rate; "Move now anyway" on the Overview moves them at today's fee, about one block`
				: status.confirmedOnchain >= CHANNELIZE_FLOOR_SATS
				? `${fmt(status.confirmedOnchain)} sats are moving into your channel, about one block from now`
				: `${fmt(status.confirmedOnchain)} sats are waiting for more to arrive before they move (amounts under ${fmt(CHANNELIZE_FLOOR_SATS)} sats stay put)`
		);
	}
	const openingSats = status.pendingChannels
		? status.pendingChannels.reduce((s, c) => s + (c.localBalanceSats || 0), 0)
		: 0;
	if (openingSats > 0) {
		parts.push(`${fmt(openingSats)} sats are in a channel that is still confirming, about one block from now`);
	}
	const splicing = Math.max(0, status.pending - status.unconfirmed - status.confirmedOnchain - openingSats);
	if (splicing > 0) {
		parts.push(`${fmt(splicing)} sats rejoin your balance when the current splice locks, about one block from now`);
	}
	const arriving = parts.length > 0 ? parts.join('; ') : `${fmt(status.pending)} sats are on their way into your channel`;
	return `This asks for ${fmt(short)} sats more than you can send right now, but it is within your total balance. ${arriving}. Once that lands, you can pay this; the request stays here so you can try again.`;
}

/**
 * The page's figures. `balance` is GET /balance, `liquidity` GET /liquidity,
 * `channels` GET /channels, `utxos` GET /utxos, `peers` GET /peers; each may
 * be null while it loads.
 */
export function lfbwStatus({ rec, info, balance, liquidity, channels, utxos, peers }) {
	const lf = (rec && rec.lfbw) || null;
	const primaryPubkey = (lf && lf.primaryPubkey) || null;
	const withPrimary = primaryChannels(channels, primaryPubkey);
	const home = withPrimary.find(usable) || null;
	const pendingChannels = withPrimary.filter((c) => !usable(c));

	const onchain = balance ? balance.onchain || 0 : (info && info.onchainBalanceSats) || 0;
	const unconfirmed = (utxos || []).filter((u) => !u.height || u.height <= 0).reduce((s, u) => s + (u.valueSats || 0), 0);
	const confirmedOnchain = Math.max(0, onchain - unconfirmed);
	const openingSats = pendingChannels.reduce((s, c) => s + (c.localBalanceSats || 0), 0);
	const splicingSats = balance ? balance.splicingSats || 0 : (info && info.splicingBalanceSats) || 0;

	const canSend = liquidity
		? liquidity.sendableSats ?? liquidity.totalLocalBalanceSats ?? 0
		: home
		? home.localBalanceSats || 0
		: 0;
	const canReceive = withPrimary.filter(usable).reduce((s, c) => s + (c.remoteBalanceSats || 0), 0);
	const lightning = balance ? balance.lightning || 0 : (info && info.lightningBalanceSats) || 0;
	const pending = unconfirmed + confirmedOnchain + openingSats + splicingSats;
	const total = lightning + onchain + openingSats + splicingSats;

	// The manager's last channelize decision rides on the record. A wait on
	// the fee is the one the owner can override ("Move now anyway"); it is
	// only current while confirmed funds are still sitting there.
	const last = (lf && lf.lastChannelize) || null;
	const feeWait =
		last && last.reason === 'fee-too-high' && confirmedOnchain >= CHANNELIZE_FLOOR_SATS
			? { feeSats: last.feeSats || 0, amountSats: last.amountSats || confirmedOnchain }
			: null;

	const notes = [];
	if (lf && lf.setup === 'ready') {
		if (unconfirmed > 0) {
			notes.push(
				`${fmt(unconfirmed)} sats are arriving on-chain and move into your Lightning balance once the deposit confirms (about one block). Until then the sender could still replace their transaction, so nothing is spent against it.`
			);
		}
		if (confirmedOnchain > 0) {
			notes.push(
				feeWait
					? `${fmt(confirmedOnchain)} sats have confirmed and are waiting for the fee rate to come down, or for more to arrive: moving them now would pay about ${fmt(feeWait.feeSats)} sats in fees, more than a twentieth of the amount.`
					: confirmedOnchain >= CHANNELIZE_FLOOR_SATS
					? `${fmt(confirmedOnchain)} sats have confirmed and are moving into your Lightning balance.`
					: `${fmt(confirmedOnchain)} sats are waiting: amounts under ${fmt(CHANNELIZE_FLOOR_SATS)} sats stay put until more arrives, because a channel has minimums and an on-chain fee to cover.`
			);
		}
		if (openingSats > 0) {
			notes.push(`${fmt(openingSats)} sats are in a channel that is still confirming.`);
		}
		if (splicingSats > 0) {
			notes.push(`${fmt(splicingSats)} sats rejoin your balance when the current splice locks.`);
		}
	}

	const primaryConnected = !!primaryPubkey && (peers || []).some((p) => p.pubkey === primaryPubkey && (p.state === 'connected' || p.state === 'ready' || p.connected === true));

	// Re-pointed primary: the channel with the old one stays open until it
	// is moved, and it is listed here so its balance is not a figure the
	// user cannot find (umbrel #86).
	const previousPrimary = (lf && lf.previousPrimary) || null;
	const previousChannels = previousPrimaryChannels(channels, previousPrimary);

	return {
		lf,
		primaryPubkey,
		home,
		pendingChannels,
		channels: withPrimary,
		previousPrimary,
		previousChannels,
		total,
		canSend,
		canReceive,
		pending,
		lightning,
		onchain,
		unconfirmed,
		confirmedOnchain,
		notes,
		feeWait,
		primaryConnected,
		setup: lf ? lf.setup : null
	};
}

function fmt(n) {
	return Number(n || 0).toLocaleString('en-US');
}
