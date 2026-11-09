import { buildBip21, parsePayment } from './payment-uri.js';

/** A pubky as people can check it at a glance: the first and last few characters. */
export function shortPubky(pubky) {
	const key = String(pubky || '');
	return key.length > 16 ? `${key.slice(0, 8)}…${key.slice(-6)}` : key;
}

// Which identifiers carry what, in the order a payee's own list has no say in.
const ADDRESS_IDS = new Set(['btc-bitcoin-p2wpkh', 'btc-bitcoin-p2tr']);
const LIGHTNING_IDS = ['btc-lightning-bolt12', 'btc-lightning-bolt11'];

/**
 * What a pubky's published payment details let this wallet pay, as one
 * request the Send tab already knows how to read.
 *
 * `endpoints` are the manager's lookup ({ identifier, value }), in the
 * payee's order. Each one is read with the same parser a pasted string goes
 * through, so a value for another network, or one that does not parse, is
 * skipped rather than paid. From what is left:
 *
 * - the on-chain half is a published BIP21 (it carries a direct funding
 *   request) when there is one, else a plain address;
 * - the Lightning half is an offer when there is one, else an invoice.
 *
 * Returns `{ text, address, lightning, funding }`: `text` is a unified
 * `bitcoin:` request when there is an address, else the Lightning string
 * alone. Throws, naming what the pubky does publish, when nothing is payable.
 */
export function requestFromEndpoints(endpoints, { network } = {}) {
	const list = Array.isArray(endpoints) ? endpoints : [];
	let onchain = null;
	let lightning = null;
	for (const e of list) {
		const value = String(e?.value ?? '').trim();
		if (!value) continue;
		if (e.identifier === 'btc-bitcoin-bip21') {
			const read = parsePayment(value, { network });
			if (read.kind === 'onchain' && (!onchain || (!onchain.funding && read.funding))) onchain = read;
		} else if (ADDRESS_IDS.has(e.identifier)) {
			const read = parsePayment(value, { network });
			if (read.kind === 'onchain' && !onchain) onchain = read;
		}
	}
	for (const id of LIGHTNING_IDS) {
		for (const e of list.filter((x) => x.identifier === id)) {
			const read = parsePayment(String(e.value ?? '').trim(), { network });
			if (read.kind === 'bolt12') lightning = read.offer;
			else if (read.kind === 'bolt11') lightning = read.invoice;
			if (lightning) break;
		}
		if (lightning) break;
	}
	const funding = onchain?.funding?.envelope || null;
	if (onchain) {
		return {
			text: buildBip21({ address: onchain.address, lightning, funding }),
			address: onchain.address,
			lightning,
			funding
		};
	}
	if (lightning) return { text: lightning, address: null, lightning, funding: null };
	const named = [...new Set(list.map((e) => e.identifier))];
	const err = new Error(
		named.length
			? `That pubky publishes no way this wallet can pay (${named.join(', ')}).`
			: 'That pubky has no payment details published.'
	);
	err.code = 'PAYKIT_NOTHING_PAYABLE';
	throw err;
}
