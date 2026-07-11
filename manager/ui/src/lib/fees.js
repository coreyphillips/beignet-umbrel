// P2WPKH size approximation: ~10.5 vB overhead + ~68 vB per input + ~31 vB per output.
export const vbytes = (nIn, nOut) => Math.ceil(10.5 + nIn * 68 + nOut * 31);
