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
 * Which invoice to mint. `plain` when the home channel can take the amount
 * as it stands, so a briefly offline primary does not block a receive the
 * channel already covers; `jit` when the primary has to provision inbound
 * first (POST /jit/invoice registers the intent with the primary, which
 * opens a channel when none exists and splices the existing one bigger
 * when the payment outgrows it); a refusal when nothing can be minted yet.
 */
export function planInvoice({ wantedSats = 0, channels, primaryPubkey, setup, primaryRunning = true }) {
	if (setup !== 'ready' || !primaryPubkey) return { kind: 'refuse', code: 'NOT_READY' };
	const inbound = primaryChannels(channels, primaryPubkey)
		.filter(usable)
		.reduce((sum, c) => sum + (c.remoteBalanceSats || 0), 0);
	const covered = wantedSats > 0 ? inbound >= wantedSats : inbound > 0;
	if (covered) return { kind: 'plain' };
	if (!primaryRunning) return { kind: 'refuse', code: 'PRIMARY_DOWN' };
	return { kind: 'jit' };
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

	return {
		lf,
		primaryPubkey,
		home,
		pendingChannels,
		channels: withPrimary,
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
