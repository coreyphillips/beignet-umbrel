'use strict';

/**
 * Keys derived from a wallet's seed for things that are not the wallet:
 * LNURL-auth linking keys (LUD-05). Nothing here is stored; the seed file is
 * read, used and dropped by the caller, and these keys come back the same
 * from the same phrase, so restoring the wallet restores them.
 *
 * The seed is BIP39 with no passphrase, the way the engine derives its own
 * (beignet-node mnemonicToSeedSync).
 */
const crypto = require('crypto');
const bip39 = require('bip39');
const { HDKey } = require('@scure/bip32');
const { secp256k1 } = require('@noble/curves/secp256k1.js');

function masterKey(mnemonic) {
	const seed = bip39.mnemonicToSeedSync(String(mnemonic).trim());
	try {
		return HDKey.fromMasterSeed(seed);
	} finally {
		seed.fill(0);
	}
}

/**
 * LUD-05: the hashing key is the private key at m/138'/0; HMAC-SHA256 of the
 * service's domain name under it gives the first 16 bytes that, read as four
 * big-endian u32s, are the rest of the linking key's path m/138'/a/b/c/d.
 * Returns the derived HDKey; the caller signs with it and lets it go.
 */
function lnurlLinkingKey(mnemonic, domain) {
	const root = masterKey(mnemonic);
	const hashingKey = root.derive("m/138'/0").privateKey;
	const material = crypto.createHmac('sha256', Buffer.from(hashingKey)).update(String(domain), 'utf8').digest();
	// Each element is a raw u32 child index, so one at 2^31 or above is a
	// hardened child, as reference wallets derive it. A path string cannot
	// say that (an index that large reads as ambiguous), hence deriveChild.
	let key = root.derive("m/138'");
	for (let i = 0; i < 4; i += 1) key = key.deriveChild(material.readUInt32BE(i * 4));
	return key;
}

/**
 * LUD-04: sign the service's 32-byte k1 as it stands (no further hashing),
 * DER encoded, low-S. Returns hex signature and hex compressed public key.
 */
function signK1(key, k1Hex) {
	if (!/^[0-9a-f]{64}$/i.test(String(k1Hex))) {
		const err = new Error('The login challenge (k1) is not 32 bytes of hex.');
		err.code = 'LNURL_BAD_K1';
		throw err;
	}
	const sig = secp256k1.sign(Buffer.from(k1Hex, 'hex'), key.privateKey, { prehash: false, format: 'der', lowS: true });
	return {
		sig: Buffer.from(sig).toString('hex'),
		key: Buffer.from(key.publicKey).toString('hex')
	};
}

module.exports = { masterKey, lnurlLinkingKey, signK1 };
