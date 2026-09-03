// P2WPKH size approximation: ~10.5 vB overhead + ~68 vB per input + ~31 vB per output.
export const vbytes = (nIn, nOut) => Math.ceil(10.5 + nIn * 68 + nOut * 31);

// How far above the fast estimate a fee slider may be pushed. Taken from
// moonshine, which caps its fee slider at the recommended rate times four "to
// prevent any user accidents": a slider with no ceiling lets one careless drag
// hand the balance to miners.
export const FEE_CAP_MULTIPLE = 4;

// sat/vB to the sat/kw the splice routes take: a vbyte is four weight units,
// so 1 sat/vB is 250 sat/kw, and 253 sat/kw is the floor bitcoind relays
// (the fee rate floor of 1 sat/vB rounded up to a whole kw).
export const SATVB_TO_PERKW = 250;
export const MIN_FEERATE_PERKW = 253;
export function perkwFromSatVb(satsPerVbyte) {
	const rate = Number(satsPerVbyte);
	if (!Number.isFinite(rate) || rate <= 0) return MIN_FEERATE_PERKW;
	return Math.max(MIN_FEERATE_PERKW, Math.round(rate * SATVB_TO_PERKW));
}
