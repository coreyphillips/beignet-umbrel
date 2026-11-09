'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * LNURL as the manager speaks it: every form a link is pasted in, what a
 * service has to answer before anything is shown, and the checks an invoice
 * has to pass before the dashboard is handed it to pay. The service is a
 * fake outbound client answering by URL, so nothing here leaves the box.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { bech32 } = require('bech32');
const { secp256k1 } = require('@noble/curves/secp256k1.js');
const { createLnurl, parseLnurl, satsRange, vetSuccessAction } = require('./lnurl');
const { decodeBolt11 } = require('./bolt11-tags');
const { lnurlLinkingKey, signK1 } = require('./derive');

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const WALLET = 'w1';
const MAINNET = { network: 'mainnet', networkMode: 'hybrid' };

// BOLT11's own vector for a description hash: 20 mBTC (2,000,000,000 msat),
// committed to the metadata string below.
const SPEC_INVOICE =
	'lnbc20m1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygspp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqhp58yjmdan79s6qqdhdzgynm4zwqd5d7xmw5fk98klysy043l2ahrqs9qrsgq7ea976txfraylvgzuxs8kgcw23ezlrszfnh8r6qtfpr6cxga50aj6txm9rxrydzd06dfeawfk6swupvz4erwnyutnjq7x39ymw6j38gp7ynn44';
const SPEC_METADATA =
	'One piece of chocolate cake, one icecream cone, one pickle, one slice of swiss cheese, one slice of salami, one lollypop, one piece of cherry pie, one sausage, one cupcake, and one slice of watermelon';
const SPEC_MSAT = 2_000_000_000;

function lnurlOf(url) {
	return bech32.encode('lnurl', bech32.toWords(Buffer.from(url, 'utf8')), 2000).toUpperCase();
}

/** A fake outbound client: `routes` maps a URL prefix to a JSON answer or a function of the URL. */
function fakeOutbound(routes) {
	const calls = [];
	return {
		calls,
		async getJson(url) {
			const u = new URL(String(url));
			calls.push(u.href);
			const key = Object.keys(routes).find((k) => u.href.startsWith(k));
			if (!key) throw Object.assign(new Error(`no route for ${u.href}`), { code: 'TEST_NO_ROUTE' });
			const answer = routes[key];
			return { json: typeof answer === 'function' ? answer(u) : answer, url: u };
		}
	};
}

test('parseLnurl reads every form a link is pasted in', () => {
	const url = 'https://service.example/lnurlp/abc?x=1';
	assert.equal(parseLnurl(lnurlOf(url)).url, url);
	assert.equal(parseLnurl(lnurlOf(url).toLowerCase()).url, url);
	assert.equal(parseLnurl(`lightning:${lnurlOf(url)}`).url, url);
	assert.equal(parseLnurl(`https://wallet.example/?lightning=${lnurlOf(url)}`).url, url);
	assert.equal(parseLnurl('lnurlp://service.example/pay/1').url, 'https://service.example/pay/1');
	assert.equal(parseLnurl('lnurlw://abc.onion/w').url, 'http://abc.onion/w');
	assert.equal(parseLnurl('keyauth://site.example/auth?tag=login').url, 'https://site.example/auth?tag=login');
	const address = parseLnurl('  Satoshi@Example.COM ');
	assert.equal(address.url, 'https://example.com/.well-known/lnurlp/satoshi');
	assert.equal(address.lightningAddress, 'satoshi@example.com');
	assert.equal(parseLnurl('₿alice@example.com').lightningAddress, 'alice@example.com');
	assert.equal(parseLnurl('bob@xyz123.onion').url, 'http://xyz123.onion/.well-known/lnurlp/bob');
	for (const bad of ['', 'hello', 'lnurl1qqqqq', 'lnbc1xyz', 'user@nodot', 'https://example.com/']) {
		assert.throws(() => parseLnurl(bad), (e) => e.code === 'LNURL_INVALID', bad);
	}
});

test('satsRange rounds into whole sats and refuses a range with none in it', () => {
	assert.deepEqual(satsRange(1000, 5_000_000, 'h'), { minSats: 1, maxSats: 5000 });
	assert.deepEqual(satsRange(1500, 2_999_999, 'h'), { minSats: 2, maxSats: 2999 });
	assert.deepEqual(satsRange(0, 3000, 'h'), { minSats: 1, maxSats: 3 });
	assert.throws(() => satsRange(1100, 1900, 'h'), (e) => e.code === 'LNURL_SUBSAT');
	assert.throws(() => satsRange(5000, 1000, 'h'), (e) => e.code === 'LNURL_BAD_ANSWER');
});

test('a pay link resolves to its description and limits, and pays only the invoice it described', async () => {
	const metadata = JSON.stringify([['text/plain', SPEC_METADATA]]);
	const outbound = fakeOutbound({
		'https://pay.example/lnurlp': {
			tag: 'payRequest',
			callback: 'https://pay.example/cb?id=7',
			minSendable: 1000,
			maxSendable: 3_000_000_000,
			metadata,
			commentAllowed: 50
		},
		'https://pay.example/cb': (u) => {
			assert.equal(u.searchParams.get('id'), '7', 'the callback keeps its own query');
			assert.equal(u.searchParams.get('amount'), String(SPEC_MSAT));
			assert.equal(u.searchParams.get('comment'), 'thanks for the cake');
			return { pr: SPEC_INVOICE, routes: [], successAction: { tag: 'message', message: 'Enjoy' } };
		}
	});
	// The spec invoice commits to the bare string, so the metadata here is that
	// string: what LUD-06 hashes is whatever string the service sent.
	const lnurl = createLnurl({ outbound });
	const shown = await lnurl.resolve(WALLET, MAINNET, lnurlOf('https://pay.example/lnurlp/1'));
	assert.equal(shown.tag, 'pay');
	assert.equal(shown.domain, 'pay.example');
	assert.equal(shown.description, SPEC_METADATA);
	assert.equal(shown.minSats, 1);
	assert.equal(shown.maxSats, 3_000_000);
	assert.equal(shown.commentAllowed, 50);

	// Patch the session to the spec's committed string to check the hash path.
	lnurl._sessions.get(shown.session).metadata = SPEC_METADATA;
	const paid = await lnurl.pay(WALLET, MAINNET, {
		session: shown.session,
		amountSats: SPEC_MSAT / 1000,
		comment: '  thanks for the cake  '
	});
	assert.equal(paid.bolt11, SPEC_INVOICE);
	assert.equal(paid.paymentHash, decodeBolt11(SPEC_INVOICE).paymentHash);
	assert.deepEqual(paid.successAction, { tag: 'message', message: 'Enjoy' });
});

test('an invoice that does not match what was asked is refused, whatever the mismatch', async () => {
	const base = {
		tag: 'payRequest',
		callback: 'https://pay.example/cb',
		minSendable: 1000,
		maxSendable: 3_000_000_000,
		metadata: '[["text/plain","something else"]]'
	};
	const lnurl = createLnurl({
		outbound: fakeOutbound({ 'https://pay.example/lnurlp': base, 'https://pay.example/cb': { pr: SPEC_INVOICE } })
	});
	const shown = await lnurl.resolve(WALLET, MAINNET, 'lnurlp://pay.example/lnurlp');
	// The description hash commits to other metadata.
	await assert.rejects(
		lnurl.pay(WALLET, MAINNET, { session: shown.session, amountSats: SPEC_MSAT / 1000 }),
		(e) => e.code === 'LNURL_BAD_INVOICE' && /does not match/.test(e.message)
	);
	// Another amount than asked.
	lnurl._sessions.get(shown.session).metadata = SPEC_METADATA;
	await assert.rejects(
		lnurl.pay(WALLET, MAINNET, { session: shown.session, amountSats: 1000 }),
		(e) => e.code === 'LNURL_BAD_INVOICE' && /different amount/.test(e.message)
	);
	// Another network than the wallet's.
	await assert.rejects(
		lnurl.pay(WALLET, { network: 'regtest' }, { session: shown.session, amountSats: SPEC_MSAT / 1000 }),
		(e) => e.code === 'LNURL_BAD_INVOICE' && /mainnet/.test(e.message)
	);
	// Outside the link's own limits, before anything is fetched.
	await assert.rejects(
		lnurl.pay(WALLET, MAINNET, { session: shown.session, amountSats: 4_000_000 }),
		(e) => e.code === 'INVALID_AMOUNT'
	);
});

test('a session belongs to one wallet and lapses', async () => {
	let t = 1_000_000;
	const lnurl = createLnurl({
		outbound: fakeOutbound({
			'https://pay.example/': {
				tag: 'payRequest',
				callback: 'https://pay.example/cb',
				minSendable: 1000,
				maxSendable: 10000,
				metadata: '[["text/plain","x"]]'
			}
		}),
		now: () => t
	});
	const shown = await lnurl.resolve(WALLET, MAINNET, 'lnurlp://pay.example/');
	await assert.rejects(lnurl.pay('other', MAINNET, { session: shown.session, amountSats: 5 }), (e) => e.code === 'LNURL_EXPIRED');
	t += 11 * 60 * 1000;
	await assert.rejects(lnurl.pay(WALLET, MAINNET, { session: shown.session, amountSats: 5 }), (e) => e.code === 'LNURL_EXPIRED');
});

test('a Lightning address is refused when its service answers for someone else', async () => {
	const lnurl = createLnurl({
		outbound: fakeOutbound({
			'https://example.com/.well-known/lnurlp/alice': {
				tag: 'payRequest',
				callback: 'https://example.com/cb',
				minSendable: 1000,
				maxSendable: 10000,
				metadata: JSON.stringify([
					['text/plain', 'Pay mallory'],
					['text/identifier', 'mallory@example.com']
				])
			}
		})
	});
	await assert.rejects(lnurl.resolve(WALLET, MAINNET, 'alice@example.com'), (e) => e.code === 'LNURL_IDENTITY_MISMATCH');
});

test('services that refuse, need payer details, or send a plain-http callback are not shown as payable', async () => {
	const lnurl = createLnurl({
		outbound: fakeOutbound({
			'https://err.example/': { status: 'ERROR', reason: 'Account disabled' },
			'https://payer.example/': {
				tag: 'payRequest',
				callback: 'https://payer.example/cb',
				minSendable: 1000,
				maxSendable: 10000,
				metadata: '[["text/plain","x"]]',
				payerData: { name: { mandatory: true } }
			},
			'https://http.example/': {
				tag: 'payRequest',
				callback: 'http://http.example/cb',
				minSendable: 1000,
				maxSendable: 10000,
				metadata: '[["text/plain","x"]]'
			},
			'https://chan.example/': { tag: 'channelRequest', uri: 'x', callback: 'https://chan.example/cb', k1: 'a' }
		})
	});
	await assert.rejects(lnurl.resolve(WALLET, MAINNET, 'lnurlp://err.example/'), (e) => e.code === 'LNURL_SERVICE_ERROR' && /Account disabled/.test(e.message));
	await assert.rejects(lnurl.resolve(WALLET, MAINNET, 'lnurlp://payer.example/'), (e) => e.code === 'LNURL_PAYER_DATA');
	await assert.rejects(lnurl.resolve(WALLET, MAINNET, 'lnurlp://http.example/'), (e) => e.code === 'LNURL_BAD_ANSWER');
	await assert.rejects(lnurl.resolve(WALLET, MAINNET, 'lnurlc://chan.example/'), (e) => e.code === 'LNURL_UNSUPPORTED');
});

test('a withdraw link takes an invoice inside its limits and on the wallet network', async () => {
	let handed = null;
	const lnurl = createLnurl({
		outbound: fakeOutbound({
			'https://atm.example/w': {
				tag: 'withdrawRequest',
				callback: 'https://atm.example/cb',
				k1: 'secretk1',
				minWithdrawable: 1_000_000_000,
				maxWithdrawable: 2_500_000_000,
				defaultDescription: 'Voucher'
			},
			'https://atm.example/cb': (u) => {
				handed = { k1: u.searchParams.get('k1'), pr: u.searchParams.get('pr') };
				return { status: 'OK' };
			}
		})
	});
	const shown = await lnurl.resolve(WALLET, MAINNET, 'lnurlw://atm.example/w');
	assert.equal(shown.tag, 'withdraw');
	assert.equal(shown.minSats, 1_000_000);
	assert.equal(shown.maxSats, 2_500_000);
	assert.equal(shown.defaultDescription, 'Voucher');
	await assert.rejects(
		lnurl.withdraw(WALLET, { network: 'regtest' }, { session: shown.session, bolt11: SPEC_INVOICE }),
		(e) => e.code === 'INVALID_PARAMS'
	);
	const done = await lnurl.withdraw(WALLET, MAINNET, { session: shown.session, bolt11: SPEC_INVOICE });
	assert.equal(done.ok, true);
	assert.deepEqual(handed, { k1: 'secretk1', pr: SPEC_INVOICE });
	// Used once: the session goes with it.
	await assert.rejects(lnurl.withdraw(WALLET, MAINNET, { session: shown.session, bolt11: SPEC_INVOICE }), (e) => e.code === 'LNURL_EXPIRED');
});

test('a withdraw refuses an invoice outside the link limits before calling the service', async () => {
	const outbound = fakeOutbound({
		'https://atm.example/w': {
			tag: 'withdrawRequest',
			callback: 'https://atm.example/cb',
			k1: 'k',
			minWithdrawable: 1000,
			maxWithdrawable: 5000
		}
	});
	const lnurl = createLnurl({ outbound });
	const shown = await lnurl.resolve(WALLET, MAINNET, 'lnurlw://atm.example/w');
	await assert.rejects(lnurl.withdraw(WALLET, MAINNET, { session: shown.session, bolt11: SPEC_INVOICE }), (e) => e.code === 'INVALID_AMOUNT');
	assert.equal(outbound.calls.length, 1, 'only the link itself was fetched');
});

test('a login link is read without a fetch and signs k1 with the domain key', async () => {
	const k1 = 'e2af6254a8df433264fa23f67eb8188635d15ce883e8fc020989d5f82ae6f11e';
	let signedBy = null;
	const outbound = fakeOutbound({
		'https://site.example/auth': (u) => {
			const sig = Buffer.from(u.searchParams.get('sig'), 'hex');
			const key = Buffer.from(u.searchParams.get('key'), 'hex');
			assert.equal(u.searchParams.get('k1'), k1);
			assert.equal(secp256k1.verify(sig, Buffer.from(k1, 'hex'), key, { prehash: false, format: 'der' }), true);
			signedBy = key.toString('hex');
			return { status: 'OK' };
		}
	});
	const lnurl = createLnurl({ outbound });
	const shown = await lnurl.resolve(WALLET, MAINNET, lnurlOf(`https://site.example/auth?tag=login&k1=${k1}&action=register`));
	assert.deepEqual({ tag: shown.tag, domain: shown.domain, action: shown.action }, { tag: 'login', domain: 'site.example', action: 'register' });
	assert.equal(outbound.calls.length, 0, 'nothing is sent before the owner says log in');
	const done = await lnurl.auth(WALLET, MAINNET, { session: shown.session }, () => SEED);
	assert.equal(done.linkingKey, signedBy);
	assert.equal(signedBy, Buffer.from(lnurlLinkingKey(SEED, 'site.example').publicKey).toString('hex'));
	await assert.rejects(lnurl.resolve(WALLET, MAINNET, 'keyauth://site.example/auth?tag=login&k1=nothex'), (e) => e.code === 'LNURL_BAD_K1');
});

test('success actions keep the spec shapes and an aes one opens with the preimage', async () => {
	const callback = new URL('https://pay.example/cb');
	assert.equal(vetSuccessAction({ tag: 'url', url: 'https://evil.example/x', description: 'd' }, callback), null);
	assert.deepEqual(vetSuccessAction({ tag: 'url', url: 'https://pay.example/thanks', description: 'd' }, callback), {
		tag: 'url',
		description: 'd',
		url: 'https://pay.example/thanks'
	});
	assert.equal(vetSuccessAction({ tag: 'url', url: 'http://pay.example/thanks' }, callback), null);
	assert.equal(vetSuccessAction({ tag: 'nonsense' }, callback), null);

	const preimage = crypto.randomBytes(32);
	const iv = crypto.randomBytes(16);
	const cipher = crypto.createCipheriv('aes-256-cbc', preimage, iv);
	const ciphertext = Buffer.concat([cipher.update('The code is 1234', 'utf8'), cipher.final()]).toString('base64');
	const metadata = '[["text/plain","x"]]';
	const lnurl = createLnurl({
		outbound: fakeOutbound({
			'https://pay.example/l': {
				tag: 'payRequest',
				callback: 'https://pay.example/cb',
				minSendable: 1000,
				maxSendable: 3_000_000_000,
				metadata
			},
			'https://pay.example/cb': { pr: SPEC_INVOICE, successAction: { tag: 'aes', description: 'Your code', ciphertext, iv: iv.toString('base64') } }
		})
	});
	const shown = await lnurl.resolve(WALLET, MAINNET, 'lnurlp://pay.example/l');
	lnurl._sessions.get(shown.session).metadata = SPEC_METADATA;
	const paid = await lnurl.pay(WALLET, MAINNET, { session: shown.session, amountSats: SPEC_MSAT / 1000 });
	assert.deepEqual(paid.successAction, { tag: 'aes', description: 'Your code' }, 'the ciphertext stays here');
	// The spec invoice's payment hash is not this preimage's, so the check
	// against it is lifted for the decryption itself.
	lnurl._sessions.get(shown.session).paymentHash = crypto.createHash('sha256').update(preimage).digest('hex');
	const opened = lnurl.decryptSuccess(WALLET, { session: shown.session, preimage: preimage.toString('hex') });
	assert.equal(opened.message, 'The code is 1234');
	assert.throws(
		() => lnurl.decryptSuccess(WALLET, { session: shown.session, preimage: crypto.randomBytes(32).toString('hex') }),
		(e) => e.code === 'INVALID_PARAMS'
	);
});

test('signK1 refuses a challenge that is not 32 bytes', () => {
	const key = lnurlLinkingKey(SEED, 'site.example');
	assert.throws(() => signK1(key, 'abcd'), (e) => e.code === 'LNURL_BAD_K1');
});
