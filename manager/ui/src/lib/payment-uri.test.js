/**
 * Run with: npm test (from manager/ui), or `node --test src/lib/payment-uri.test.js`.
 *
 * Money conversion and address checksums are the two places in the dashboard
 * where being approximately right is being wrong, so they are checked against
 * the specifications' own vectors rather than against themselves.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	bech32Decode,
	bech32Encode,
	btcStringToSats,
	buildBip21,
	classifyAddress,
	convertBits,
	parseBolt11Hrp,
	parsePayment,
	satsToBtcString,
	tooShortToJudge
} from './payment-uri.js';

/* ------------------------------------------------------------------ money */

test('btcStringToSats accepts everything the BIP21 grammar allows', () => {
	const cases = [
		['0', 0],
		['1', 100000000],
		['1.', 100000000],
		['.001', 100000],
		['0.00000001', 1],
		['0.10000000', 10000000],
		['0.000000010', 1],
		['00012.5', 1250000000],
		['21000000', 2100000000000000],
		// The value that makes float parsing wrong: 4.35 * 1e8 is
		// 434999999.99999994, so anything rounding down loses a satoshi.
		['4.35', 435000000],
		['0.1', 10000000],
		['0.29', 29000000]
	];
	for (const [input, sats] of cases) {
		const r = btcStringToSats(input);
		assert.equal(r.ok, true, `${input} should parse`);
		assert.equal(r.sats, sats, `${input} should be ${sats} sats`);
	}
});

test('btcStringToSats refuses what Number() would silently accept', () => {
	const cases = [
		['', 'AMOUNT_EMPTY'],
		['-1', 'AMOUNT_NOT_DECIMAL'],
		['+1', 'AMOUNT_NOT_DECIMAL'],
		['1,5', 'AMOUNT_NOT_DECIMAL'],
		['1 000', 'AMOUNT_NOT_DECIMAL'],
		['abc', 'AMOUNT_NOT_DECIMAL'],
		['0x10', 'AMOUNT_NOT_DECIMAL'],
		['Infinity', 'AMOUNT_NOT_DECIMAL'],
		['NaN', 'AMOUNT_NOT_DECIMAL'],
		['1e-8', 'AMOUNT_NOT_DECIMAL'],
		['10X8', 'AMOUNT_NOT_DECIMAL'],
		['1.2.3', 'AMOUNT_NOT_DECIMAL'],
		['1btc', 'AMOUNT_NOT_DECIMAL'],
		['0.000000001', 'AMOUNT_SUB_SATOSHI'],
		['21000001', 'AMOUNT_OVER_MAX_MONEY']
	];
	for (const [input, code] of cases) {
		const r = btcStringToSats(input);
		assert.equal(r.ok, false, `${input} should be refused`);
		assert.equal(r.code, code, `${input} should be ${code}`);
	}
});

test('satsToBtcString writes decimals, never exponents', () => {
	assert.equal(satsToBtcString(1), '0.00000001');
	assert.equal(satsToBtcString(0), '0');
	assert.equal(satsToBtcString(10), '0.0000001');
	assert.equal(satsToBtcString(100000000), '1');
	assert.equal(satsToBtcString(2100000000000000), '21000000');
	assert.equal(satsToBtcString(435000000), '4.35');
	// The bug this exists to avoid: (1/1e8).toString() is '1e-8'.
	assert.ok(!satsToBtcString(1).includes('e'));
});

test('sats survive a round trip through the decimal form', () => {
	const values = [0, 1, 10, 100, 546, 12345, 435000000, 1e8, 1e9, 123456789012345, 2099999999999999];
	for (const sats of values) {
		const back = btcStringToSats(satsToBtcString(sats));
		assert.equal(back.ok, true);
		assert.equal(back.sats, sats);
	}
});

/* ----------------------------------------------------------------- bech32 */

// BIP173 and BIP350 valid vectors, with the scriptPubKey each encodes.
const SEGWIT_VECTORS = [
	['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', 'bc', 0, 20],
	['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', 'tb', 0, 32],
	['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'bc', 1, 32],
	['BC1SW50QGDZ25J', 'bc', 16, 2],
	['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', 'bc', 2, 16]
];

test('the checksum agrees with the specification vectors', () => {
	for (const [address, hrp, version] of SEGWIT_VECTORS) {
		const decoded = bech32Decode(address);
		assert.equal(decoded.ok, true, `${address} should decode`);
		assert.equal(decoded.hrp, hrp);
		assert.equal(decoded.data[0], version);
		assert.equal(decoded.encoding, version === 0 ? 'bech32' : 'bech32m');
	}
});

test('the encoder reproduces a known address from its witness program', () => {
	// 751e76e8199196d454941c45d1b3a323f1433bd6, the program behind the most
	// quoted address in the specification. Getting this byte-identical is what
	// proves the polymod, not a round trip against itself.
	const program = [
		0x75, 0x1e, 0x76, 0xe8, 0x19, 0x91, 0x96, 0xd4, 0x54, 0x94, 0x1c, 0x45, 0xd1, 0xb3, 0xa3, 0x23,
		0xf1, 0x43, 0x3b, 0xd6
	];
	const data = [0].concat(convertBits(program, 8, 5, true));
	assert.equal(bech32Encode('bc', data), 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
});

test('damaged addresses are caught before the daemon sees them', () => {
	const cases = [
		// One character changed in the middle: the checksum is what catches it.
		['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'B32_CHECKSUM'],
		// Cut short by a line wrap.
		['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7', 'B32_CHECKSUM'],
		['Bc1Qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'B32_MIXED_CASE'],
		// 'b' and 'i' are not in the data charset.
		['bc1qb508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'B32_BAD_CHAR'],
		['bc1pw5dgrnzv', 'ADDR_PROGRAM_LENGTH'],
		// A witness v0 address must use bech32, not bech32m.
		['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'.replace('1p', '1q'), 'B32_CHECKSUM']
	];
	for (const [address, code] of cases) {
		const r = classifyAddress(address);
		assert.equal(r.ok, false, `${address} should be refused`);
		assert.equal(r.code, code, `${address} should be ${code}`);
	}
});

test('a prefix with a separator in it is not a chain', () => {
	// The separator is the LAST '1', so these strings begin with `bc1` while
	// their real prefix is `bc1q`, `bc1`, `tb1` or `bcrt1x`: no chain at all.
	// Reading the chain off the front and the address off the back would let
	// them through as payable, and hand the caller an undefined network.
	const crafted = [
		'bc1q1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5gag6wg',
		'bc11qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5cv3l4c',
		'tb11qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5nx8ttg',
		'bcrt1x1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc57aluja'
	];
	for (const address of crafted) {
		const classified = classifyAddress(address);
		assert.equal(classified.ok, false, `${address} is not an address`);
		assert.equal(classified.code, 'ADDR_UNKNOWN_HRP');
		// And with no network to check against, which is the path where a wrong
		// answer would be believed rather than caught.
		assert.equal(parsePayment(address, {}).kind, 'invalid', address);
		assert.equal(parsePayment(address, { network: 'mainnet' }).kind, 'invalid', address);
	}
});

test('every accepted address names at least one chain', () => {
	// The property the bug above broke: ok never comes back without networks,
	// because the caller compares that list against the wallet's own chain and
	// would throw mid-render on anything else.
	const inputs = [
		'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
		'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
		'bc1sw50qgdz25j',
		'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7',
		'1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		'3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
		'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn',
		'bc1q1qqypqxpq9qcrsszg2pvxq6rs0zqg3yyc5gag6wg',
		'bc1gmk9yu',
		'hello',
		''
	];
	for (const input of inputs) {
		const classified = classifyAddress(input);
		if (!classified.ok) continue;
		assert.ok(Array.isArray(classified.networks) && classified.networks.length > 0, input);
	}
});

test('addresses are classified by type and chain', () => {
	const wpkh = classifyAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
	assert.deepEqual(wpkh.networks, ['mainnet']);
	assert.equal(wpkh.type, 'SegWit');

	const taproot = classifyAddress('bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0');
	assert.equal(taproot.type, 'Taproot');

	const future = classifyAddress('bc1sw50qgdz25j');
	assert.equal(future.ok, true);
	assert.equal(future.forwardCompatible, true, 'an unknown witness version is still payable');

	const testnet = classifyAddress('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7');
	assert.deepEqual(testnet.networks, ['testnet']);

	// Capitals off a QR code are the same address.
	assert.equal(
		classifyAddress('BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4').address,
		'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
	);

	const legacy = classifyAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
	assert.equal(legacy.ok, true);
	assert.deepEqual(legacy.networks, ['mainnet']);
	assert.equal(legacy.type, 'Legacy');

	// Testnet and regtest share base58 prefixes, so the string cannot tell them
	// apart and neither does this.
	const tLegacy = classifyAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn');
	assert.deepEqual(tLegacy.networks, ['testnet', 'regtest']);
});

/* ------------------------------------------------------------------ BOLT11 */

test('the invoice prefix gives the chain and the amount', () => {
	assert.deepEqual(parseBolt11Hrp('lnbc1pvjluezpp5'), { ok: true, network: 'mainnet', amountMsat: null });
	assert.deepEqual(parseBolt11Hrp('lnbc2500u1pvjluezpp5'), {
		ok: true,
		network: 'mainnet',
		amountMsat: 250000000n
	});
	assert.deepEqual(parseBolt11Hrp('lntb20m1pvjluezpp5'), {
		ok: true,
		network: 'testnet',
		amountMsat: 2000000000n
	});
	// Longest prefix first, or regtest reads as mainnet.
	assert.equal(parseBolt11Hrp('lnbcrt500u1pvjluezpp5').network, 'regtest');
	assert.equal(parseBolt11Hrp('lnbc9678785340p1pwmna7lpp5').amountMsat, 967878534n);
	assert.equal(parseBolt11Hrp('lnbc1p1pvjluezpp5').code, 'BOLT11_SUB_MSAT');
	assert.equal(parseBolt11Hrp('lnxx1pvjluezpp5').code, 'BOLT11_UNKNOWN_PREFIX');
});

/* ------------------------------------------------------------------ BIP21 */

const ADDR = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';

// An invoice's body is opaque to everything here, but its checksum is not, and
// the parser checks it. These are not payable invoices; they are strings shaped
// exactly like one, which is all this file needs.
const invoiceFor = (hrp) => bech32Encode(hrp, Array.from({ length: 200 }, (_, i) => (i * 7 + 3) % 32));

test('a request with nothing attached is just the address', () => {
	assert.equal(buildBip21({ address: ADDR }), ADDR);
	assert.equal(buildBip21({ address: ADDR, amountSats: 0, message: '' }), ADDR);
	assert.equal(buildBip21({ address: '' }), '');
});

test('everything this writes, this reads back', () => {
	// The two halves of this file have to agree on what an amount is, or the
	// wallet can mint a request its own send form refuses. The amount box is
	// digits-only and unbounded, so the ceiling is the reachable edge.
	for (const amountSats of [0, 1, 546, 2100000000000000, 99000000000000000, -5, NaN]) {
		const uri = buildBip21({ address: ADDR, amountSats });
		const back = parsePayment(uri, { network: 'mainnet' });
		assert.equal(back.kind, 'onchain', `${amountSats} sats`);
		assert.equal(back.address, ADDR);
	}
	assert.equal(
		parsePayment(buildBip21({ address: ADDR, amountSats: 99000000000000000 }), { network: 'mainnet' })
			.amountSats,
		2100000000000000
	);
});

test('a request carries the amount in bitcoin, and the text escaped', () => {
	assert.equal(buildBip21({ address: ADDR, amountSats: 10000 }), `bitcoin:${ADDR}?amount=0.0001`);
	assert.equal(buildBip21({ address: ADDR, amountSats: 1 }), `bitcoin:${ADDR}?amount=0.00000001`);
	assert.equal(
		buildBip21({ address: ADDR, amountSats: 50000, message: 'Coffee & cake' }),
		`bitcoin:${ADDR}?amount=0.0005&message=Coffee%20%26%20cake`
	);
	assert.equal(buildBip21({ address: ADDR, message: 'Rent' }), `bitcoin:${ADDR}?message=Rent`);
});

test('what this writes, this reads back', () => {
	const uri = buildBip21({ address: ADDR, amountSats: 123456, message: 'Coffee & cake' });
	const r = parsePayment(uri, { network: 'mainnet' });
	assert.equal(r.kind, 'onchain');
	assert.equal(r.address, ADDR);
	assert.equal(r.amountSats, 123456);
	assert.equal(r.message, 'Coffee & cake');
	assert.equal(r.isRequest, true);
});

test('the daemon writes the same string this does', () => {
	// beignet's encodeBip21 divides by 1e8 and calls toFixed(8), then trims the
	// trailing zeros. These are the values where the two could disagree.
	const daemon = (sats) =>
		`bitcoin:${ADDR}?amount=${(sats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '')}`;
	for (const sats of [1, 10, 100, 435000000, 1e8, 1e9, 123456789012345, 2099999999999999, 2100000000000000]) {
		assert.equal(buildBip21({ address: ADDR, amountSats: sats }), daemon(sats), `${sats} sats`);
	}
});

/* ------------------------------------------------------------------ parse */

test('a bare address parses as itself', () => {
	const r = parsePayment(ADDR, { network: 'mainnet' });
	assert.equal(r.kind, 'onchain');
	assert.equal(r.isRequest, false);
	assert.equal(r.amountSats, null);
});

test('the scheme is case insensitive and the slashes are tolerated', () => {
	for (const uri of [`BITCOIN:${ADDR}`, `Bitcoin:${ADDR}`, `bitcoin://${ADDR}`]) {
		const r = parsePayment(uri, { network: 'mainnet' });
		assert.equal(r.kind, 'onchain', uri);
		assert.equal(r.address, ADDR);
	}
	const upper = parsePayment(`BITCOIN:${ADDR.toUpperCase()}?amount=0.5`, { network: 'mainnet' });
	assert.equal(upper.kind, 'onchain');
	assert.equal(upper.address, ADDR, 'a QR code in capitals is the same address');
	assert.equal(upper.amountSats, 50000000);
});

test('a request for the wrong chain is refused rather than filled in', () => {
	const r = parsePayment('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', {
		network: 'mainnet'
	});
	assert.equal(r.kind, 'invalid');
	assert.equal(r.code, 'WRONG_NETWORK');
	assert.match(r.message, /testnet/);
	assert.match(r.message, /mainnet/);
	// The same address on the chain it belongs to is fine.
	assert.equal(
		parsePayment('tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', { network: 'testnet' })
			.kind,
		'onchain'
	);
});

test('a required parameter this wallet does not understand stops the payment', () => {
	const r = parsePayment(`bitcoin:${ADDR}?amount=0.1&req-somethingnew=1`, { network: 'mainnet' });
	assert.equal(r.kind, 'invalid');
	assert.equal(r.code, 'UNSUPPORTED_REQ_PARAM');
	// An optional one this wallet does not know is ignored, as the spec says.
	const ok = parsePayment(`bitcoin:${ADDR}?amount=0.1&pj=https://example.com`, { network: 'mainnet' });
	assert.equal(ok.kind, 'onchain');
	assert.equal(ok.amountSats, 10000000);
});

test('an amount that cannot be read stops the payment, it is not dropped', () => {
	for (const bad of ['1e-8', '0.000000001', '-1', '1,5', '21000001']) {
		const r = parsePayment(`bitcoin:${ADDR}?amount=${bad}`, { network: 'mainnet' });
		assert.equal(r.kind, 'invalid', `amount=${bad}`);
	}
	// Two amounts that disagree is not a preference to resolve.
	assert.equal(parsePayment(`bitcoin:${ADDR}?amount=1&amount=2`, { network: 'mainnet' }).code, 'DUPLICATE_AMOUNT');
	// A question mark inside a field does not separate anything: '&' splits the
	// fields and the first '=' splits one, so a stray one lands in a value and is
	// judged there. Here it makes the amount unreadable, which is what is said.
	assert.equal(
		parsePayment(`bitcoin:${ADDR}?amount=1?label=x`, { network: 'mainnet' }).code,
		'AMOUNT_NOT_DECIMAL'
	);
	// Capitals on a field this wallet knows would otherwise be ignored silently.
	assert.equal(parsePayment(`bitcoin:${ADDR}?AMOUNT=0.1`, { network: 'mainnet' }).code, 'PARAM_CASE_MISMATCH');
});

test('the same amount written twice is not two amounts', () => {
	// BIP21 has no rule against a repeat, and an encoder that writes one is
	// clumsy rather than contradictory. Refusing with "names two different
	// amounts" would tell the payer something false about the request they were
	// handed, and "ask for a new one" is what they would act on.
	const same = parsePayment(`bitcoin:${ADDR}?amount=0.001&amount=0.001`, { network: 'mainnet' });
	assert.equal(same.kind, 'onchain');
	assert.equal(same.amountSats, 100000);
	assert.ok(same.warnings.some((w) => w.code === 'DUPLICATE_PARAM'));
	// Written differently, meaning the same thing, is still one amount.
	assert.equal(parsePayment(`bitcoin:${ADDR}?amount=1&amount=1.00000000`, { network: 'mainnet' }).amountSats, 100000000);
	// And a genuine disagreement is still refused.
	assert.equal(
		parsePayment(`bitcoin:${ADDR}?amount=0.001&amount=0.002`, { network: 'mainnet' }).code,
		'DUPLICATE_AMOUNT'
	);
	// An unreadable amount is refused for being unreadable, not for repeating.
	assert.equal(
		parsePayment(`bitcoin:${ADDR}?amount=abc&amount=abc`, { network: 'mainnet' }).code,
		'AMOUNT_NOT_DECIMAL'
	);
});

test('a question mark is a legal character in a label or a message', () => {
	// BIP21 builds label and message out of RFC 3986 query characters less '='
	// and '&', and '?' is one of them. "Lunch?" is an ordinary thing for a payee
	// to write, nothing requires them to escape it, and refusing the request is
	// the direction that blocks a payment that should have gone through.
	const asked = parsePayment(`bitcoin:${ADDR}?amount=0.0001&message=Lunch?`, { network: 'mainnet' });
	assert.equal(asked.kind, 'onchain');
	assert.equal(asked.message, 'Lunch?');
	assert.equal(asked.amountSats, 10000);

	const both = parsePayment(`bitcoin:${ADDR}?label=Who?&message=Invoice %2314?`, { network: 'mainnet' });
	assert.equal(both.kind, 'onchain');
	assert.equal(both.label, 'Who?');
	assert.equal(both.message, 'Invoice #14?');
});

test('an amount of zero means the payer chooses', () => {
	const r = parsePayment(`bitcoin:${ADDR}?amount=0&message=Tip`, { network: 'mainnet' });
	assert.equal(r.kind, 'onchain');
	assert.equal(r.amountSats, null);
	assert.equal(r.message, 'Tip');
	assert.ok(r.warnings.some((w) => w.code === 'AMOUNT_ZERO'));
});

test('text parameters survive percent encoding, and a plus is not a space', () => {
	const r = parsePayment(`bitcoin:${ADDR}?label=Alice%2BBob&message=Table%20four`, { network: 'mainnet' });
	assert.equal(r.label, 'Alice+Bob');
	assert.equal(r.message, 'Table four');
	// A half written escape is damage, and it is refused rather than guessed at.
	assert.equal(
		parsePayment(`bitcoin:${ADDR}?message=%ZZ`, { network: 'mainnet' }).code,
		'MALFORMED_PERCENT_ENCODING'
	);
	// An unescaped & truncates the message. That is worth saying, not failing.
	const truncated = parsePayment(`bitcoin:${ADDR}?message=Bob %26 Alice`.replace('%26', '&'), {
		network: 'mainnet'
	});
	assert.equal(truncated.kind, 'onchain');
	assert.ok(truncated.warnings.some((w) => w.code === 'TEXT_PARAM_TRUNCATED'));
});

test('a Lightning invoice is recognised wherever it arrives', () => {
	const invoice = invoiceFor('lnbc2500u');
	for (const input of [invoice, `lightning:${invoice}`, `LIGHTNING:${invoice.toUpperCase()}`, ` ${invoice}\n`]) {
		const r = parsePayment(input, { network: 'mainnet' });
		assert.equal(r.kind, 'bolt11', input.slice(0, 24));
		assert.equal(r.invoice, invoice);
		assert.equal(r.amountSats, 250000);
	}
	// An invoice for another chain cannot be paid from here.
	assert.equal(parsePayment(invoice, { network: 'regtest' }).code, 'WRONG_NETWORK');
});

test('an invoice that fails its checksum never reaches the daemon', () => {
	const invoice = invoiceFor('lnbc2500u');
	// One character changed, and one cut short by a line wrap.
	const flipped = `${invoice.slice(0, 60)}${invoice[60] === 'q' ? 'p' : 'q'}${invoice.slice(61)}`;
	assert.equal(parsePayment(flipped, { network: 'mainnet' }).code, 'BOLT11_CHECKSUM');
	assert.equal(parsePayment(invoice.slice(0, -4), { network: 'mainnet' }).code, 'BOLT11_CHECKSUM');
	assert.equal(parsePayment('lnbc1notarealinvoice', { network: 'mainnet' }).code, 'BOLT11_CHECKSUM');
});

test('an invoice wrapped by an email client is unwrapped', () => {
	const invoice = invoiceFor('lnbc2500u');
	const wrapped = `${invoice.slice(0, 40)}\n${invoice.slice(40)}`;
	const r = parsePayment(wrapped, { network: 'mainnet' });
	assert.equal(r.kind, 'bolt11');
	assert.equal(r.invoice, invoice);
	assert.ok(r.warnings.some((w) => w.code === 'WHITESPACE_REPAIRED'));
});

test('the things that start with ln and are not invoices say so', () => {
	const cases = [
		['lno1pg257enxv4ezqcneype82um50ynhxgrwdajx283qfwdpl28qqmc78ymlvhmxcsywdk5wrjnj36jryg488qwlrnzyjczlqsp9nyu4phcg6dqhlhzgxagfu7zh3d9re0sqp9ts2yfugvnnm9gxkcnnnkdpa084a6t520h5zhkxsdnghvpukvd43lastpwuh73k29qsy', 'bolt12'],
		['lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexujcc33s84', 'invalid'],
		['lnr1qqgds4z5x9m0d4kzmnpvyhsqvfhqcnsdaeqxc2z9se5wpjxjmn9v4nzqctyv3ex2umnyfhkwmtjw3jhx0m3jz', 'invalid']
	];
	for (const [input, kind] of cases) {
		assert.equal(parsePayment(input, {}).kind, kind, input.slice(0, 12));
	}
	assert.equal(parsePayment('lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexujcc33s84', {}).code, 'LNURL_UNSUPPORTED');
});

test('a request this writes with an invoice in it is one this reads', () => {
	const invoice = invoiceFor('lnbc2500u');

	// The whole point of the parameter: one string a payer can settle either way.
	const both = buildBip21({ address: ADDR, amountSats: 250000, message: 'Table 12', lightning: invoice });
	assert.equal(both, `bitcoin:${ADDR}?amount=0.0025&message=Table%2012&lightning=${invoice}`);
	const read = parsePayment(both, { network: 'mainnet' });
	assert.equal(read.kind, 'onchain');
	assert.equal(read.address, ADDR);
	assert.equal(read.amountSats, 250000);
	assert.equal(read.message, 'Table 12');
	assert.equal(read.lightning.kind, 'bolt11');
	assert.equal(read.lightning.invoice, invoice);

	// An amountless invoice leaves the figure to the payer, and the request
	// supplies it, so there is nothing for the two to disagree about.
	const amountless = buildBip21({ address: ADDR, amountSats: 250000, lightning: invoiceFor('lnbc') });
	assert.equal(parsePayment(amountless, { network: 'mainnet' }).amountSats, 250000);

	// Written last, so a request without one is byte-identical to before.
	assert.equal(
		buildBip21({ address: ADDR, amountSats: 250000, message: 'Table 12' }),
		`bitcoin:${ADDR}?amount=0.0025&message=Table%2012`
	);
	assert.equal(buildBip21({ address: ADDR, lightning: '' }), ADDR);
	assert.equal(buildBip21({ address: ADDR, lightning: '   ' }), ADDR);
});

test('a unified request offers both rails, and refuses two amounts that disagree', () => {
	const invoice = invoiceFor('lnbc2500u');
	const both = parsePayment(`bitcoin:${ADDR}?amount=0.0025&lightning=${invoice}`, { network: 'mainnet' });
	assert.equal(both.kind, 'onchain');
	assert.equal(both.amountSats, 250000);
	assert.equal(both.lightning.invoice, invoice);

	const conflict = parsePayment(`bitcoin:${ADDR}?amount=0.5&lightning=${invoice}`, { network: 'mainnet' });
	assert.equal(conflict.code, 'AMOUNT_CONFLICT');

	// No address at all is the ordinary shape of a Lightning-only QR code.
	const lnOnly = parsePayment(`bitcoin:?lightning=${invoice}`, { network: 'mainnet' });
	assert.equal(lnOnly.kind, 'bolt11');

	// A broken invoice must not take the address down with it.
	const salvaged = parsePayment(`bitcoin:${ADDR}?amount=0.1&lightning=lnbc-nonsense`, { network: 'mainnet' });
	assert.equal(salvaged.kind, 'onchain');
	assert.equal(salvaged.amountSats, 10000000);
	assert.ok(salvaged.warnings.some((w) => w.code === 'LN_PAYLOAD_UNPARSEABLE'));
});

test('strings that are not payments are named, not called invalid', () => {
	const cases = [
		['xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8', 'EXTENDED_KEY'],
		['5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ', 'PRIVATE_KEY'],
		['wpkh([d34db33f/84h/0h/0h]xpub6.../0/*)', 'DESCRIPTOR'],
		['npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', 'NOSTR_KEY'],
		['corey@getalby.com', 'LIGHTNING_ADDRESS_UNSUPPORTED'],
		['sp1qq0u00ldg5e3s6rp4c6dhrhkmk8lqrqjkvzjsxjqu8xj7xnpvzz8xqf6zfpwl4nqzcmv4qkrfmxfzskzxlfg', 'SILENT_PAYMENT_UNSUPPORTED']
	];
	for (const [input, code] of cases) {
		const r = parsePayment(input, {});
		assert.equal(r.kind, 'invalid', input.slice(0, 16));
		assert.equal(r.code, code, input.slice(0, 16));
	}
});

test('nothing pasted crashes it', () => {
	const inputs = [
		'',
		'   ',
		null,
		undefined,
		42,
		'bitcoin:',
		'bitcoin:?',
		'bitcoin:?amount=1',
		'bitcoin://',
		'?amount=1',
		'bitcoin:bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4#fragment',
		`${ADDR}.`,
		`(${ADDR})`,
		`<${ADDR}>`,
		'hello world',
		'a'.repeat(9000),
		'‮bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
	];
	for (const input of inputs) {
		const r = parsePayment(input, { network: 'mainnet' });
		assert.ok(['empty', 'onchain', 'bolt11', 'bolt12', 'invalid'].includes(r.kind), String(input).slice(0, 20));
		if (r.kind === 'invalid') assert.ok(r.message.length > 0, `${r.code} needs a sentence`);
	}
	assert.equal(parsePayment(`${ADDR}.`, { network: 'mainnet' }).kind, 'onchain', 'a sentence full stop is not part of the address');
	assert.equal(parsePayment(`<${ADDR}>`, { network: 'mainnet' }).kind, 'onchain');
	assert.equal(parsePayment('a'.repeat(9000), {}).code, 'INPUT_TOO_LONG');
	assert.equal(parsePayment('‮bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', {}).code, 'BIDI_CONTROL');
	assert.equal(parsePayment('bitcoin:', {}).code, 'BIP21_NO_PAYABLE_TARGET');
});

test('half a payment string is not judged as a damaged one', () => {
	// What a field holds while it is being typed into. Every refusal this file can
	// make is true of these, and none of them is worth saying yet.
	const halfWritten = [
		'',
		'   ',
		'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzq',
		// One character short of the P2WPKH and taproot forms their prefixes name.
		ADDR.slice(0, -1),
		'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj'.slice(0, -1),
		'bc1qw508d6qejxtdg4y5r3zar',
		'1A1zP1eP5QGefi2',
		'lightning:lnbc2500u1pvjluezpp5'
	];
	for (const input of halfWritten) {
		assert.equal(tooShortToJudge(input), true, JSON.stringify(input).slice(0, 40));
	}

	// And what a finished one holds. A refusal about any of these is the answer.
	const finished = [
		ADDR,
		'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',
		'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
		'1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
		// A witness version with no standard program length behind it falls back to
		// the shortest string bech32 itself allows, since nothing narrows it.
		'bc1sw50qgdz25j',
		invoiceFor('lnbc2500u'),
		`lightning:${invoiceFor('lnbc2500u')}`,
		'hello world, this is plainly not a payment string at all'
	];
	for (const input of finished) {
		assert.equal(tooShortToJudge(input), false, input.slice(0, 24));
	}
});

test('every refusal carries a sentence a person can act on', () => {
	const seen = new Set();
	const inputs = [
		'hello',
		'bitcoin:',
		`bitcoin:${ADDR}?amount=abc`,
		`bitcoin:${ADDR}?req-x=1`,
		'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5',
		'5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ'
	];
	for (const input of inputs) {
		const r = parsePayment(input, { network: 'mainnet' });
		assert.equal(r.kind, 'invalid', input);
		assert.ok(r.message.endsWith('.'), `${r.code}: ${r.message}`);
		assert.ok(!r.message.includes('—'), `${r.code} must not use an em dash`);
		seen.add(r.code);
	}
	assert.equal(seen.size, inputs.length, 'each of those is a different refusal');
});
