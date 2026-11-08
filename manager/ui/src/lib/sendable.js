/**
 * What can leave over Lightning right now, as the daemon itself judges it.
 *
 * A channel's local balance is not all sendable. The peer holds this side to
 * a channel reserve, and on a channel this wallet opened the commitment fee
 * (kept with room for a fee spike and the next HTLC) comes out of this side
 * too. The daemon reports what is left after all of that as maxSendableSats,
 * per channel on GET /channels and summed on GET /liquidity. It is the same
 * ceiling the daemon checks every outgoing HTLC against: an amount above it
 * fails before it leaves, as "Insufficient balance for HTLC".
 *
 * The dashboard used to bound the send form by the raw local balance, so Max
 * filled in a figure the channel could never carry. An older daemon that
 * reports no maxSendableSats falls back to the nearest figure it does report.
 */

const finite = (n) => typeof n === 'number' && Number.isFinite(n);

/** The most one channel (a GET /channels row) can send right now, in sats. */
export function channelSendableSats(channel) {
	if (!channel) return 0;
	if (finite(channel.maxSendableSats)) return Math.max(0, channel.maxSendableSats);
	return Number(channel.localBalanceSats) || 0;
}

/**
 * The most the wallet can send right now, in sats, from GET /liquidity: the
 * daemon's exact ceiling, else its balance above the reserve, else the raw
 * local balance.
 */
export function liquiditySendableSats(liquidity) {
	if (!liquidity) return 0;
	if (finite(liquidity.maxSendableSats)) return Math.max(0, liquidity.maxSendableSats);
	if (finite(liquidity.sendableSats)) return Math.max(0, liquidity.sendableSats);
	return Number(liquidity.totalLocalBalanceSats) || 0;
}
