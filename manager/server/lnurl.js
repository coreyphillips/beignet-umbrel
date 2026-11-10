'use strict';

/**
 * LNURL for a wallet on this Umbrel: paying an LNURL-pay link or a Lightning
 * address (LUD-06, LUD-16), pulling from an LNURL-withdraw link (LUD-03), and
 * logging in with LNURL-auth (LUD-04, keys per LUD-05).
 *
 * The manager does the talking to the service, over the wallet's own route
 * (outbound.js), and checks everything it is handed back before the
 * dashboard acts on it. The paying itself stays with the dashboard and the
 * daemon, the same route every other invoice takes, so the payment shows up,
 * is capped and is reported exactly like one pasted in.
 *
 * A resolved link is held here as a session (ten minutes, one wallet), so the
 * dashboard never hands back a callback URL for the manager to fetch: what
 * the manager fetches is only ever what the service itself named.
 */
const crypto = require('crypto');
const { bech32 } = require('bech32');
const { decodeBolt11 } = require('./bolt11-tags');
const { lnurlLinkingKey, signK1 } = require('./derive');
const { vetUrl, isOnion } = require('./outbound');

const SESSION_TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 200;
const MAX_REASON_CHARS = 300;
const LOGIN_ACTIONS = ['register', 'login', 'link', 'auth'];

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	// A 502 or 504 here is the remote service misbehaving or out of reach,
	// and a 503 is Tor being unavailable: neither is a fault in the manager,
	// so they are logged as one line, without a stack.
	if (status === 502 || status === 503 || status === 504) err.upstream = true;
	return err;
}

/* ------------------------------------------------------------------ parse */

/** The scheme LUD-17 names for each tag, and what replaces it. */
const LUD17 = { 'lnurlp:': 'pay', 'lnurlw:': 'withdraw', 'keyauth:': 'login', 'lnurlc:': 'channel' };

function decodeBech32Lnurl(text) {
	let decoded;
	try {
		decoded = bech32.decode(text.toLowerCase(), Number.MAX_SAFE_INTEGER);
	} catch (_) {
		throw httpError(400, 'LNURL_INVALID', 'That LNURL does not decode. Check it was copied whole.');
	}
	if (decoded.prefix !== 'lnurl') throw httpError(400, 'LNURL_INVALID', 'That is not an LNURL.');
	return Buffer.from(bech32.fromWords(decoded.words)).toString('utf8');
}

const ADDRESS_RE = /^([a-z0-9\-_.+]+)@([a-z0-9.-]+\.[a-z0-9-]+|[a-z0-9.-]+\.onion)$/i;

/**
 * What a pasted string points at: `{ url, lightningAddress }`, or throws.
 * Accepts lnurl1..., lightning:lnurl1..., the LUD-17 schemes, a Lightning
 * address (user@domain, LUD-16) and the LUD-01 fallback (an https link
 * carrying ?lightning=lnurl1...).
 */
function parseLnurl(input) {
	let text = String(input ?? '').trim();
	if (!text) throw httpError(400, 'LNURL_INVALID', 'Paste an LNURL or a Lightning address.');
	text = text.replace(/^lightning:(\/\/)?/i, '');
	// A Lightning address, with or without the ₿ some apps write before a
	// human-readable name: the LNURL form of it is what is fetched here.
	const address = text.replace(/^₿/, '');
	if (ADDRESS_RE.test(address)) {
		const [, user, domain] = ADDRESS_RE.exec(address);
		const lowerDomain = domain.toLowerCase();
		const scheme = isOnion(lowerDomain) ? 'http' : 'https';
		return {
			url: `${scheme}://${lowerDomain}/.well-known/lnurlp/${user.toLowerCase()}`,
			lightningAddress: `${user.toLowerCase()}@${lowerDomain}`
		};
	}
	if (/^lnurl1/i.test(text)) return { url: decodeBech32Lnurl(text), lightningAddress: null };
	const colon = text.indexOf(':');
	const scheme = colon > 0 ? text.slice(0, colon + 1).toLowerCase() : '';
	if (LUD17[scheme]) {
		const rest = text.slice(colon + 1).replace(/^\/\//, '');
		const host = rest.split(/[/?#]/)[0];
		const hostname = host.replace(/:\d+$/, '');
		return { url: `${isOnion(hostname) ? 'http' : 'https'}://${rest}`, lightningAddress: null };
	}
	if (scheme === 'https:' || scheme === 'http:') {
		let url;
		try {
			url = new URL(text);
		} catch (_) {
			throw httpError(400, 'LNURL_INVALID', 'That link does not parse.');
		}
		const inner = url.searchParams.get('lightning');
		if (inner && /^lnurl1/i.test(inner)) return { url: decodeBech32Lnurl(inner), lightningAddress: null };
	}
	throw httpError(400, 'LNURL_INVALID', 'That is not an LNURL or a Lightning address.');
}

/* ---------------------------------------------------------------- helpers */

/** A service's own error reason, trimmed to something fit for a toast. */
function serviceReason(json, host) {
	const reason = typeof json?.reason === 'string' ? json.reason.trim().slice(0, MAX_REASON_CHARS) : '';
	return reason ? `${host} says: ${reason}` : `${host} refused the request.`;
}

function refuseOnError(json, url) {
	if (json && typeof json === 'object' && String(json.status).toUpperCase() === 'ERROR') {
		throw httpError(502, 'LNURL_SERVICE_ERROR', serviceReason(json, url.host));
	}
}

/** A positive safe-integer millisatoshi amount from a service, or throws. */
function msatField(json, field, url) {
	const value = json[field];
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw httpError(502, 'LNURL_BAD_ANSWER', `${url.host} sent an unusable ${field}.`);
	}
	return value;
}

/**
 * A callback URL a service named: vetted like any other, and on the same
 * security footing as where it came from (an https service cannot send the
 * wallet to plain http).
 */
function callbackUrl(raw, from, rec) {
	if (typeof raw !== 'string' || !raw) throw httpError(502, 'LNURL_BAD_ANSWER', `${from.host} sent no callback.`);
	let url;
	try {
		url = new URL(raw, from);
	} catch (_) {
		throw httpError(502, 'LNURL_BAD_ANSWER', `${from.host} sent a callback that does not parse.`);
	}
	if (from.protocol === 'https:' && url.protocol !== 'https:') {
		throw httpError(502, 'LNURL_BAD_ANSWER', `${from.host} sent a callback on plain http.`);
	}
	return vetUrl(url, { relaxed: rec?.network === 'regtest' });
}

/** A URL with more query parameters on it, keeping the ones it had. */
function withParams(url, params) {
	const next = new URL(url.href);
	for (const [k, v] of Object.entries(params)) next.searchParams.set(k, String(v));
	return next;
}

/** The text/plain description and the identifier entries in LUD-06 metadata. */
function readMetadata(raw, host) {
	let entries;
	try {
		entries = JSON.parse(raw);
	} catch (_) {
		throw httpError(502, 'LNURL_BAD_ANSWER', `${host} sent metadata that does not parse.`);
	}
	if (!Array.isArray(entries)) throw httpError(502, 'LNURL_BAD_ANSWER', `${host} sent metadata that is not a list.`);
	const get = (type) => {
		const hit = entries.find((e) => Array.isArray(e) && e[0] === type && typeof e[1] === 'string');
		return hit ? hit[1] : null;
	};
	const description = get('text/plain');
	if (description === null) throw httpError(502, 'LNURL_BAD_ANSWER', `${host} sent no description for the payment.`);
	return {
		description: description.slice(0, 640),
		longDescription: (get('text/long-desc') || '').slice(0, 2000) || null,
		identifier: get('text/identifier') || get('text/email')
	};
}

/** Whole sats inside a millisatoshi range: min rounded up, max rounded down. */
function satsRange(minMsat, maxMsat, host) {
	const minSats = Math.max(1, Math.ceil(minMsat / 1000));
	const maxSats = Math.floor(maxMsat / 1000);
	if (minMsat > maxMsat) throw httpError(502, 'LNURL_BAD_ANSWER', `${host} sent a minimum above its maximum.`);
	if (maxSats < minSats) {
		throw httpError(502, 'LNURL_SUBSAT', `${host} only takes amounts in fractions of a satoshi, which this wallet cannot pay.`);
	}
	return { minSats, maxSats };
}

/** LUD-09 success actions, kept only in the shapes the spec allows. */
function vetSuccessAction(action, callback) {
	if (!action || typeof action !== 'object') return null;
	const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
	if (action.tag === 'message') {
		const message = text(action.message, 144);
		return message ? { tag: 'message', message } : null;
	}
	if (action.tag === 'url') {
		let url;
		try {
			url = new URL(action.url);
		} catch (_) {
			return null;
		}
		// LUD-09: the URL is on the callback's own domain. Anything else is a
		// link to somewhere the payer never chose to go.
		if (url.hostname !== callback.hostname) return null;
		if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isOnion(url.hostname))) return null;
		return { tag: 'url', description: text(action.description, 144), url: url.href };
	}
	if (action.tag === 'aes') {
		const ciphertext = typeof action.ciphertext === 'string' ? action.ciphertext : '';
		const iv = typeof action.iv === 'string' ? action.iv : '';
		if (!ciphertext || ciphertext.length > 4096 || !iv) return null;
		return { tag: 'aes', description: text(action.description, 144), ciphertext, iv };
	}
	return null;
}

/* ---------------------------------------------------------------- service */

/**
 * The LNURL service for the manager. `outbound` is createOutbound()'s client;
 * `now` and `randomId` are seams for tests.
 */
function createLnurl({ outbound, now = () => Date.now(), randomId = () => crypto.randomBytes(16).toString('hex') }) {
	const sessions = new Map();

	function prune() {
		const t = now();
		for (const [id, s] of sessions) if (t - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
		while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
	}

	function remember(walletId, data) {
		prune();
		const id = randomId();
		sessions.set(id, { ...data, walletId, createdAt: now() });
		return id;
	}

	function session(walletId, id, tag) {
		prune();
		const s = sessions.get(String(id || ''));
		if (!s || s.walletId !== walletId) {
			throw httpError(410, 'LNURL_EXPIRED', 'That link was read too long ago. Paste it again.');
		}
		if (tag && s.tag !== tag) throw httpError(400, 'LNURL_WRONG_KIND', 'That link is for something else.');
		return s;
	}

	/**
	 * Read a link: what it is for, from whom, and the limits it sets. What
	 * the dashboard gets back is for showing; the session id is the handle
	 * to act on it.
	 */
	async function resolve(walletId, rec, input) {
		const { url: rawUrl, lightningAddress } = parseLnurl(input);
		const relaxed = rec?.network === 'regtest';
		const url = vetUrl(rawUrl, { relaxed });
		const domain = url.hostname.replace(/\.$/, '');

		// LUD-04: a login link says what it is in its own query and is not
		// fetched until the wallet signs.
		if (url.searchParams.get('tag') === 'login') {
			const k1 = url.searchParams.get('k1') || '';
			if (!/^[0-9a-f]{64}$/i.test(k1)) throw httpError(400, 'LNURL_BAD_K1', 'That login link carries no valid challenge.');
			const actionRaw = (url.searchParams.get('action') || 'login').toLowerCase();
			const action = LOGIN_ACTIONS.includes(actionRaw) ? actionRaw : 'login';
			const id = remember(walletId, { tag: 'login', url: url.href, domain, k1 });
			return { session: id, tag: 'login', domain, action };
		}

		const { json, url: finalUrl } = await outbound.getJson(url, { rec });
		refuseOnError(json, finalUrl);
		if (!json || typeof json !== 'object') throw httpError(502, 'LNURL_BAD_ANSWER', `${finalUrl.host} did not answer with an LNURL.`);

		if (json.tag === 'payRequest') {
			const callback = callbackUrl(json.callback, finalUrl, rec);
			const minMsat = msatField(json, 'minSendable', finalUrl);
			const maxMsat = msatField(json, 'maxSendable', finalUrl);
			const { minSats, maxSats } = satsRange(minMsat, maxMsat, finalUrl.host);
			if (typeof json.metadata !== 'string') throw httpError(502, 'LNURL_BAD_ANSWER', `${finalUrl.host} sent no metadata.`);
			const meta = readMetadata(json.metadata, finalUrl.host);
			// LUD-16: an address whose service names some other address in its
			// metadata is not the payee that was pasted.
			if (lightningAddress && meta.identifier && meta.identifier.toLowerCase() !== lightningAddress) {
				throw httpError(
					502,
					'LNURL_IDENTITY_MISMATCH',
					`${finalUrl.host} answered for ${meta.identifier}, not ${lightningAddress}. Nothing was paid.`
				);
			}
			// LUD-18: details about the payer the service insists on. This
			// wallet sends none, so a service that requires any cannot be paid.
			const payerData = json.payerData && typeof json.payerData === 'object' ? json.payerData : null;
			if (payerData && Object.values(payerData).some((f) => f && f.mandatory === true)) {
				throw httpError(
					502,
					'LNURL_PAYER_DATA',
					`${finalUrl.host} requires details about the payer, which this wallet does not send.`
				);
			}
			const commentAllowed =
				Number.isSafeInteger(json.commentAllowed) && json.commentAllowed > 0 ? Math.min(json.commentAllowed, 2000) : 0;
			const id = remember(walletId, {
				tag: 'pay',
				domain,
				callback: callback.href,
				metadata: json.metadata,
				minMsat,
				maxMsat,
				commentAllowed
			});
			return {
				session: id,
				tag: 'pay',
				domain,
				lightningAddress,
				description: meta.description,
				longDescription: meta.longDescription,
				minSats,
				maxSats,
				commentAllowed
			};
		}

		if (json.tag === 'withdrawRequest') {
			const callback = callbackUrl(json.callback, finalUrl, rec);
			if (typeof json.k1 !== 'string' || !json.k1) throw httpError(502, 'LNURL_BAD_ANSWER', `${finalUrl.host} sent no k1.`);
			const minMsat = msatField(json, 'minWithdrawable', finalUrl);
			const maxMsat = msatField(json, 'maxWithdrawable', finalUrl);
			const { minSats, maxSats } = satsRange(minMsat, maxMsat, finalUrl.host);
			const defaultDescription =
				typeof json.defaultDescription === 'string' ? json.defaultDescription.slice(0, 640) : '';
			const id = remember(walletId, {
				tag: 'withdraw',
				domain,
				callback: callback.href,
				k1: json.k1,
				minMsat,
				maxMsat
			});
			return { session: id, tag: 'withdraw', domain, minSats, maxSats, defaultDescription };
		}

		if (json.tag === 'channelRequest') {
			throw httpError(400, 'LNURL_UNSUPPORTED', 'That is an LNURL-channel link, which this wallet does not support. Open channels from the Channels tab.');
		}
		throw httpError(400, 'LNURL_UNSUPPORTED', `${finalUrl.host} answered with a kind of LNURL this wallet does not support.`);
	}

	/**
	 * Ask a pay link for an invoice for `amountSats`, and check it is the
	 * invoice that was asked for: this wallet's network, exactly that amount,
	 * and committed to the metadata that was shown (LUD-06). Returns the
	 * invoice for the dashboard to pay.
	 */
	async function pay(walletId, rec, { session: id, amountSats, comment } = {}) {
		const s = session(walletId, id, 'pay');
		const sats = Number(amountSats);
		if (!Number.isSafeInteger(sats) || sats <= 0) throw httpError(400, 'INVALID_AMOUNT', 'Enter an amount in whole sats.');
		const msat = sats * 1000;
		if (msat < s.minMsat || msat > s.maxMsat) {
			throw httpError(
				400,
				'INVALID_AMOUNT',
				`${s.domain} takes ${Math.ceil(s.minMsat / 1000).toLocaleString('en-US')} to ${Math.floor(s.maxMsat / 1000).toLocaleString('en-US')} sats.`
			);
		}
		const params = { amount: msat };
		const note = typeof comment === 'string' ? comment.trim() : '';
		if (note && s.commentAllowed > 0) params.comment = note.slice(0, s.commentAllowed);
		const callback = withParams(new URL(s.callback), params);
		const { json, url } = await outbound.getJson(callback, { rec });
		refuseOnError(json, url);
		const pr = typeof json?.pr === 'string' ? json.pr.trim() : '';
		if (!pr) throw httpError(502, 'LNURL_BAD_ANSWER', `${url.host} sent no invoice.`);
		let decoded;
		try {
			decoded = decodeBolt11(pr);
		} catch (_) {
			throw httpError(502, 'LNURL_BAD_INVOICE', `${url.host} sent an invoice that does not decode. Nothing was paid.`);
		}
		if (rec?.network && decoded.network !== rec.network) {
			throw httpError(502, 'LNURL_BAD_INVOICE', `${url.host} sent an invoice for ${decoded.network}, and this wallet is on ${rec.network}. Nothing was paid.`);
		}
		if (decoded.amountMsat === null || decoded.amountMsat !== BigInt(msat)) {
			throw httpError(502, 'LNURL_BAD_INVOICE', `${url.host} sent an invoice for a different amount than was asked. Nothing was paid.`);
		}
		const expected = crypto.createHash('sha256').update(s.metadata, 'utf8').digest('hex');
		if (decoded.descriptionHash !== expected) {
			throw httpError(
				502,
				'LNURL_BAD_INVOICE',
				`${url.host} sent an invoice that does not match the payment it described. Nothing was paid.`
			);
		}
		const successAction = vetSuccessAction(json.successAction, new URL(s.callback));
		s.successAction = successAction;
		s.paymentHash = decoded.paymentHash;
		return {
			bolt11: pr.toLowerCase(),
			paymentHash: decoded.paymentHash,
			successAction: successAction && successAction.tag === 'aes' ? { tag: 'aes', description: successAction.description } : successAction
		};
	}

	/** LUD-10: open an aes success action with the payment's preimage. */
	function decryptSuccess(walletId, { session: id, preimage } = {}) {
		const s = session(walletId, id, 'pay');
		const action = s.successAction;
		if (!action || action.tag !== 'aes') throw httpError(400, 'LNURL_NO_SECRET', 'This payment came with nothing to unlock.');
		if (!/^[0-9a-f]{64}$/i.test(String(preimage || ''))) throw httpError(400, 'INVALID_PARAMS', 'A 32-byte preimage is needed.');
		const key = Buffer.from(preimage, 'hex');
		if (s.paymentHash && crypto.createHash('sha256').update(key).digest('hex') !== s.paymentHash) {
			throw httpError(400, 'INVALID_PARAMS', 'That preimage is not for this payment.');
		}
		try {
			const iv = Buffer.from(action.iv, 'base64');
			const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
			const plain = Buffer.concat([decipher.update(Buffer.from(action.ciphertext, 'base64')), decipher.final()]);
			return { tag: 'message', description: action.description, message: plain.toString('utf8').slice(0, 2000) };
		} catch (_) {
			throw httpError(502, 'LNURL_BAD_ANSWER', 'The message that came with the payment does not open.');
		}
	}

	/**
	 * Hand a withdraw link the invoice it is to pay. The invoice is the
	 * dashboard's, made the way the Receive tab makes one; it is checked
	 * against the link's limits and this wallet's network first.
	 */
	async function withdraw(walletId, rec, { session: id, bolt11 } = {}) {
		const s = session(walletId, id, 'withdraw');
		let decoded;
		try {
			decoded = decodeBolt11(String(bolt11 || ''));
		} catch (_) {
			throw httpError(400, 'INVALID_PARAMS', 'The invoice to withdraw into does not decode.');
		}
		if (rec?.network && decoded.network !== rec.network) throw httpError(400, 'INVALID_PARAMS', 'The invoice is for another network.');
		if (decoded.amountMsat === null) throw httpError(400, 'INVALID_AMOUNT', 'The invoice to withdraw into needs an amount.');
		if (decoded.amountMsat < BigInt(s.minMsat) || decoded.amountMsat > BigInt(s.maxMsat)) {
			const { minSats, maxSats } = satsRange(s.minMsat, s.maxMsat, s.domain);
			throw httpError(
				400,
				'INVALID_AMOUNT',
				`${s.domain} pays out ${minSats.toLocaleString('en-US')} to ${maxSats.toLocaleString('en-US')} sats.`
			);
		}
		const callback = withParams(new URL(s.callback), { k1: s.k1, pr: String(bolt11).trim() });
		const { json, url } = await outbound.getJson(callback, { rec });
		refuseOnError(json, url);
		if (String(json?.status).toUpperCase() !== 'OK') throw httpError(502, 'LNURL_BAD_ANSWER', `${url.host} did not confirm the withdrawal.`);
		sessions.delete(String(id));
		return { ok: true, domain: s.domain, paymentHash: decoded.paymentHash };
	}

	/**
	 * Log in to a service with this wallet's key for its domain (LUD-04/05).
	 * `readMnemonic` hands over the wallet's phrase for the one derivation.
	 */
	async function auth(walletId, rec, { session: id } = {}, readMnemonic) {
		const s = session(walletId, id, 'login');
		const mnemonic = readMnemonic();
		const key = lnurlLinkingKey(mnemonic, s.domain);
		let signed;
		try {
			signed = signK1(key, s.k1);
		} finally {
			key.wipePrivateData?.();
		}
		const callback = withParams(new URL(s.url), { sig: signed.sig, key: signed.key });
		const { json, url } = await outbound.getJson(callback, { rec });
		refuseOnError(json, url);
		if (String(json?.status).toUpperCase() !== 'OK') throw httpError(502, 'LNURL_BAD_ANSWER', `${url.host} did not confirm the login.`);
		sessions.delete(String(id));
		return { ok: true, domain: s.domain, linkingKey: signed.key };
	}

	return { resolve, pay, decryptSuccess, withdraw, auth, _sessions: sessions };
}

module.exports = { createLnurl, parseLnurl, vetSuccessAction, satsRange, readMetadata, SESSION_TTL_MS };
