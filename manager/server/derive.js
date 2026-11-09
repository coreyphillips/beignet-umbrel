'use strict';

/**
 * Keys derived from a wallet's seed for things that are not the wallet:
 * LNURL-auth linking keys (LUD-05) and the wallet's Pubky identity (BIP85).
 * Nothing here is stored; the seed file is read, used and dropped by the
 * caller, and these keys come back the same from the same phrase, so
 * restoring the wallet restores them.
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

/* ------------------------------------------------------------- Pubky */

// BIP85: a child BIP39 phrase, English (language 0), 12 words, index 0.
const PUBKY_PHRASE_PATH = "m/83696968'/39'/0'/12'/0'";

/** BIP85 entropy: HMAC-SHA512 keyed "bip-entropy-from-k" over the private key at `path`, truncated. */
function bip85Entropy(root, path, bytes) {
	const k = root.derive(path).privateKey;
	const full = crypto.createHmac('sha512', 'bip-entropy-from-k').update(Buffer.from(k)).digest();
	return Buffer.from(full.subarray(0, bytes));
}

/**
 * The wallet's Pubky identity phrase: a BIP85 child of its seed, so it needs
 * no backup of its own, and it can be typed into Pubky Ring to hold the same
 * identity there. It is a full BIP39 phrase, so anyone holding it controls
 * the identity; it is not the wallet's seed and spends nothing.
 */
function pubkyPhrase(mnemonic) {
	return bip39.entropyToMnemonic(bip85Entropy(masterKey(mnemonic), PUBKY_PHRASE_PATH, 16));
}

/**
 * The identity secret a phrase stands for, the way Pubky Ring and
 * paykit-discovery read one: the first 32 bytes of its BIP39 seed, with no
 * passphrase.
 */
function pubkySecret(phrase) {
	const seed = bip39.mnemonicToSeedSync(String(phrase).trim());
	try {
		return Buffer.from(seed.subarray(0, 32));
	} finally {
		seed.fill(0);
	}
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ZBASE32 = 'ybndrfg8ejkmcpqxot1uwisza345h769';

function zBase32(bytes) {
	let out = '';
	let bits = 0;
	let value = 0;
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ZBASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ZBASE32[(value << (5 - bits)) & 31];
	return out;
}

/** The z-base32 public key (the pubky) for a 32-byte ed25519 identity secret. */
function pubkyOf(secret) {
	const key = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secret)]), format: 'der', type: 'pkcs8' });
	const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' });
	return zBase32(spki.subarray(spki.length - 32));
}

module.exports = { masterKey, lnurlLinkingKey, signK1, bip85Entropy, pubkyPhrase, pubkySecret, pubkyOf, zBase32, PUBKY_PHRASE_PATH };
