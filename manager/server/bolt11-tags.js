'use strict';

/**
 * Just enough of a BOLT11 reader to check an invoice an LNURL service handed
 * back before it is paid: the network and amount in its prefix, and the
 * description hash (`h`) it commits to. The daemon's own decode floors the
 * amount to whole sats and leaves the description hash out, and LUD-06 needs
 * both exactly.
 *
 * The signature is not checked here: the daemon checks it when it pays, and
 * nothing here acts on who signed it.
 */
const { bech32 } = require('bech32');

const PREFIXES = [
	['lnbcrt', 'regtest'],
	['lntbs', 'signet'],
	['lnbc', 'mainnet'],
	['lntb', 'testnet']
];
const MSAT_PER_BTC = 100000000000n;
const MULTIPLIER = { '': 1n, m: 1000n, u: 1000000n, n: 1000000000n, p: 1000000000000n };
const TIMESTAMP_WORDS = 7;
const SIGNATURE_WORDS = 104;
const TAG = { p: 1, d: 13, h: 23, x: 6 };

function fail(code, message) {
	const err = new Error(message);
	err.code = code;
	return err;
}

function wordsToInt(words) {
	return words.reduce((n, w) => n * 32 + w, 0);
}

function wordsToBytes(words) {
	return Buffer.from(bech32.fromWordsUnsafe(words) || []);
}

/**
 * `{ network, amountMsat, paymentHash, descriptionHash, description, timestamp, expiry }`
 * for a BOLT11 invoice, with `amountMsat` a bigint or null and the hashes hex
 * or null. Throws with a code on anything that is not an invoice.
 */
function decodeBolt11(invoice) {
	if (typeof invoice !== 'string' || !invoice) throw fail('BOLT11_INVALID', 'Not an invoice');
	const text = invoice.trim().replace(/^lightning:/i, '');
	let decoded;
	try {
		decoded = bech32.decode(text, Number.MAX_SAFE_INTEGER);
	} catch (_) {
		throw fail('BOLT11_INVALID', 'The invoice does not decode');
	}
	const hrp = decoded.prefix;
	const hit = PREFIXES.find(([prefix]) => hrp.startsWith(prefix));
	if (!hit) throw fail('BOLT11_INVALID', 'The invoice has an unknown prefix');
	const [prefix, network] = hit;
	const rest = hrp.slice(prefix.length);
	let amountMsat = null;
	if (rest !== '') {
		const m = /^(\d+)([munp]?)$/.exec(rest);
		if (!m) throw fail('BOLT11_INVALID', 'The invoice amount does not parse');
		const scaled = BigInt(m[1]) * MSAT_PER_BTC;
		const divisor = MULTIPLIER[m[2]];
		if (scaled % divisor !== 0n) throw fail('BOLT11_INVALID', 'The invoice amount is a fraction of a millisatoshi');
		amountMsat = scaled / divisor;
	}
	const words = decoded.words;
	if (words.length < TIMESTAMP_WORDS + SIGNATURE_WORDS) throw fail('BOLT11_INVALID', 'The invoice is too short');
	const timestamp = wordsToInt(words.slice(0, TIMESTAMP_WORDS));
	const fields = words.slice(TIMESTAMP_WORDS, words.length - SIGNATURE_WORDS);
	let paymentHash = null;
	let descriptionHash = null;
	let description = null;
	let expiry = 3600;
	for (let i = 0; i + 3 <= fields.length; ) {
		const type = fields[i];
		const length = fields[i + 1] * 32 + fields[i + 2];
		const data = fields.slice(i + 3, i + 3 + length);
		if (data.length !== length) throw fail('BOLT11_INVALID', 'The invoice is cut short');
		i += 3 + length;
		// BOLT11: a reader skips a p or h field of the wrong length rather than
		// reading it, and takes the first of each.
		if (type === TAG.p && length === 52 && paymentHash === null) {
			paymentHash = wordsToBytes(data).subarray(0, 32).toString('hex');
		} else if (type === TAG.h && length === 52 && descriptionHash === null) {
			descriptionHash = wordsToBytes(data).subarray(0, 32).toString('hex');
		} else if (type === TAG.d && description === null) {
			description = wordsToBytes(data).toString('utf8');
		} else if (type === TAG.x) {
			expiry = wordsToInt(data);
		}
	}
	return { network, amountMsat, paymentHash, descriptionHash, description, timestamp, expiry };
}

module.exports = { decodeBolt11 };
