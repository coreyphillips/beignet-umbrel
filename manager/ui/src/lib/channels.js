// States in which a channel no longer routes and takes no channel actions:
// no HTLCs, no splices, nothing to reconnect for. Every place that counts or
// lists channels for OPERATING purposes must exclude these, and they must all
// agree on the set. Note the two states are not equivalent as history:
// FORCE_CLOSED may still have funds resolving on-chain (the daemon reports
// them in pendingCloseBalanceSats, CSV/CLTV timelocks included), while CLOSED
// is fully resolved. Anything presenting close PROGRESS must distinguish
// them; this helper only answers "does it still operate?".
export const CLOSED_CHANNEL_STATES = new Set(['CLOSED', 'FORCE_CLOSED']);

export function isClosedChannelState(state) {
	return CLOSED_CHANNEL_STATES.has(state);
}

export function isClosedChannel(c) {
	return isClosedChannelState(c.state);
}

/**
 * An asset channel: one that carries a Taproot Asset. The daemon lists it on
 * GET /channels beside the bitcoin channels, marked `auxiliary: true`, and
 * marks no other channel so. The sats in it are there to carry the asset.
 * They cannot be sent or received as bitcoin, spliced, or lent to a sibling
 * for offline receives, so a bitcoin screen that listed or summed it would
 * promise liquidity the wallet does not have. It is listed on the Asset
 * channels card, from the assets host, and closed there.
 */
export function isAssetChannel(c) {
	return !!c && c.auxiliary === true;
}

/**
 * The bitcoin channels of a GET /channels answer. Every screen that lists,
 * sums or chooses among bitcoin channels reads the list through this; the
 * places that only ask "does this wallet still have a channel of any kind"
 * read it whole. An answer that is not a list is handed back as it came.
 */
export function bitcoinChannels(list) {
	return Array.isArray(list) ? list.filter((c) => !isAssetChannel(c)) : list;
}
