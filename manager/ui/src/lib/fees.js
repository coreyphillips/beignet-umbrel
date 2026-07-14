// P2WPKH size approximation: ~10.5 vB overhead + ~68 vB per input + ~31 vB per output.
export const vbytes = (nIn, nOut) => Math.ceil(10.5 + nIn * 68 + nOut * 31);

// How far above the fast estimate a fee slider may be pushed. Taken from
// moonshine, which caps its fee slider at the recommended rate times four "to
// prevent any user accidents": a slider with no ceiling lets one careless drag
// hand the balance to miners.
export const FEE_CAP_MULTIPLE = 4;
