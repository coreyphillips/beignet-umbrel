// A block explorer for the chain this wallet is on.
//
// Nothing here is ever fetched. Looking a transaction up on mempool.space tells
// mempool.space which transaction you are interested in, and that is the user's
// call to make, so these are links to click and never something loaded on their
// behalf. Regtest is a chain only this machine can see, so there is nothing to
// link to and the caller gets null.
//
// A wallet's `testnet` is testnet3. One whose Electrum server is on testnet4
// is on that chain instead, and a caller that knows so (the Assets tab, from
// its host) asks for testnet4 by name.
const BASES = {
	mainnet: 'https://mempool.space',
	testnet: 'https://mempool.space/testnet',
	testnet4: 'https://mempool.space/testnet4'
};

export function txUrl(network, txid) {
	const base = BASES[network];
	return base && txid ? `${base}/tx/${txid}` : null;
}

export function addressUrl(network, address) {
	const base = BASES[network];
	return base && address ? `${base}/address/${address}` : null;
}
