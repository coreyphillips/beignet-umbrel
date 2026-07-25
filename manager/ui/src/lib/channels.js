// A closed channel is history, not workload: it holds no funds, carries no
// HTLCs, and has no actions left. Every place that counts or lists "channels"
// for operating purposes must exclude these states, and they must all agree
// on what closed means.
export const CLOSED_CHANNEL_STATES = new Set(['CLOSED', 'FORCE_CLOSED']);

export function isClosedChannel(c) {
	return CLOSED_CHANNEL_STATES.has(c.state);
}
