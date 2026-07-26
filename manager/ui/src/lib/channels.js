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
