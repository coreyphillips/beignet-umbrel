/**
 * Run with: npm test (from manager/ui).
 *
 * The judgements of the Assets tab that are not a component's: what it warns
 * about and in what order, why an address cannot be paid from this wallet,
 * what an event is worth saying, and how a request that moves an asset is
 * sent so that it happens once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	LIMITS,
	assetWarnings,
	describeAssetEvent,
	describeProofServerTest,
	describeSplit,
	describeSupply,
	describeType,
	formToUniverse,
	hostState,
	isRefusal,
	limitText,
	pendingCount,
	proofServerWait,
	chainName,
	explorerNetwork,
	proofServersFor,
	sendRefusal,
	sentence,
	submitOnce,
	tapPrefix,
	universeToForm,
	onHandShortage,
	proofFileBytes,
	proofTaken,
	MAX_PROOF_FILE_BYTES
} from './assets.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const BUSD = {
	key: 'g1',
	assetId: 'a'.repeat(64),
	groupKey: 'g1',
	name: 'BUSD',
	type: 'normal',
	decimalDisplay: 2,
	balance: { total: '1490000', onchain: '1250000', pendingIn: '0', pendingOut: '0', channelLocal: '240000' },
	supply: { issued: '100000000', burned: '50000', known: true }
};
const STATUS = {
	ready: true,
	holdsAssets: true,
	pending: { mints: 1, sends: 0, receives: 2, burns: 0 },
	proofServer: { host: 'universe.example:10029', reachable: true },
	backup: { exportedAt: new Date(NOW - 2 * HOUR).toISOString(), dirty: false }
};
const codes = (list) => list.map((w) => w.code);

test('a wallet that is in order is not warned about anything', () => {
	assert.deepEqual(assetWarnings({ status: STATUS, btc: { spendableSats: 50000 }, holdings: [BUSD], now: NOW }), []);
	assert.deepEqual(assetWarnings({ status: null }), [], 'and nothing is said before the wallet has answered');
});

test('the backup is asked for when assets are not in one, or changed since', () => {
	const never = assetWarnings({ status: { ...STATUS, backup: { exportedAt: null, dirty: true } }, btc: { spendableSats: 1 }, holdings: [BUSD], now: NOW });
	assert.deepEqual(codes(never), ['BACKUP_NEVER']);
	assert.equal(never[0].action, 'backup');
	assert.match(limitText(never[0]), /recovery phrase brings back this wallet's bitcoin, but assets also need their proofs/);

	const stale = assetWarnings({
		status: { ...STATUS, backup: { exportedAt: new Date(NOW - 3 * 24 * HOUR).toISOString(), dirty: true } },
		btc: { spendableSats: 1 },
		holdings: [BUSD],
		now: NOW
	});
	assert.deepEqual(codes(stale), ['BACKUP_STALE']);
	assert.match(limitText(stale[0]), /changed since the backup 3 days ago/);

	const empty = assetWarnings({ status: { ...STATUS, holdsAssets: false, backup: { exportedAt: null, dirty: false } }, btc: { spendableSats: 1 }, holdings: [], now: NOW });
	assert.deepEqual(empty, [], 'a wallet with no assets has nothing to back up yet');
});

test('what stops an asset moving is said first, as an error', () => {
	const list = assetWarnings({
		status: { ...STATUS, proofServer: { host: 'universe.example:10029', reachable: false }, backup: { exportedAt: null, dirty: true } },
		health: { electrumConnected: false },
		btc: { spendableSats: 0 },
		holdings: [BUSD],
		now: NOW
	});
	assert.deepEqual(codes(list), ['PROOF_SERVER_DOWN', 'NO_SATS', 'ELECTRUM_DOWN', 'BACKUP_NEVER']);
	assert.deepEqual(list.map((w) => w.tone), ['error', 'error', 'error', 'info']);
	assert.match(limitText(list[0]), /universe\.example:10029/);
	assert.match(limitText(list[0]), /Assets you hold are unaffected/);
});

test('having no bitcoin is a fact for an empty wallet and the reason for a full one', () => {
	const empty = assetWarnings({ status: { ...STATUS, holdsAssets: false, backup: null }, btc: { spendableSats: 0 }, holdings: [], now: NOW });
	assert.deepEqual(empty.map((w) => [w.code, w.tone]), [['NO_SATS', 'info']]);
	const lfbw = assetWarnings({ status: { ...STATUS, backup: null }, rec: { lfbw: { enabled: true } }, btc: { spendableSats: 0 }, holdings: [BUSD], now: NOW });
	assert.deepEqual(lfbw.map((w) => [w.code, w.tone]), [['NO_SATS_LFBW', 'error']]);
	assert.match(limitText(lfbw[0]), /keeps its bitcoin in its channel/);
	assert.match(limitText(lfbw[0]), /Receiving an asset still works/);
});

test('the count beside the tab is everything still going', () => {
	assert.equal(pendingCount(STATUS), 3);
	assert.equal(pendingCount(null), 0);
	assert.equal(pendingCount({}), 0);
});

test('the limits are said per network, and name the proof server', () => {
	const mainnet = LIMITS('mainnet', 'universe.example:10029', false).map(limitText);
	assert.ok(mainnet.some((t) => /recovery phrase alone does not bring assets back/.test(t)));
	assert.ok(mainnet.some((t) => /cannot be fee-bumped yet/.test(t)));
	assert.ok(mainnet.some((t) => /usable after 6 confirmations, about an hour/.test(t)));
	assert.ok(mainnet.some((t) => /universe\.example:10029 unless you change it/.test(t)));
	assert.ok(mainnet.some((t) => /No prices are shown/.test(t)));
	assert.ok(!mainnet.some((t) => /Lightning/.test(t)), 'a wallet without Lightning is not told about Lightning');
	assert.ok(LIMITS('mainnet', null, true).map(limitText).some((t) => /needs a channel funded with the asset/.test(t)));
	assert.ok(LIMITS('regtest', null, false).map(limitText).some((t) => /usable after 1 confirmation/.test(t)));
	assert.equal(tapPrefix('testnet'), 'taptb1');
	assert.equal(tapPrefix('mainnet'), 'tapbc1');
});

test('an address this wallet cannot pay is refused with the reason', () => {
	const decoded = { assetId: BUSD.assetId, groupKey: 'g1', amount: '10000', own: false };
	assert.equal(sendRefusal({ decoded, holdings: [BUSD] }), null, 'one it can pay is not refused');
	assert.equal(sendRefusal({ decoded: null, holdings: [BUSD] }), null);

	assert.equal(sendRefusal({ decoded: { ...decoded, own: true }, holdings: [BUSD] }).code, 'OWN_ADDRESS');

	const notHeld = sendRefusal({ decoded, holdings: [] });
	assert.equal(notHeld.code, 'ASSET_NOT_HELD');
	assert.match(notHeld.text, /an asset this wallet does not hold \(ID aaaa…aaaa\)/);

	const tooMuch = sendRefusal({ decoded: { ...decoded, amount: '1300000' }, holdings: [BUSD] });
	assert.equal(tooMuch.code, 'INSUFFICIENT_ASSET');
	assert.match(tooMuch.text, /asks for 13,000\.00 BUSD and this wallet has 12,500\.00 BUSD on-chain/);
	assert.match(tooMuch.text, /Another 2,400\.00 BUSD is in Lightning channels, which an on-chain send cannot use/);
});

test('a wallet that holds the cost but not enough to build the transaction is told both figures', () => {
	const details = { needed: 1308, onHandSats: 4308, spendable: 3300, feeSats: 308, anchorSats: 1000 };
	const said =
		'Sending costs 1,308 sats, but the wallet has to hold about 4,308 sats on-chain to build the transaction. What is not spent comes straight back. This wallet has 3,300 sats. Deposit bitcoin on the Receive tab first.';
	assert.equal(onHandShortage(details, 'Sending'), said);
	const refused = sendRefusal({
		decoded: { assetId: BUSD.assetId, groupKey: 'g1', amount: '10000', own: false },
		holdings: [BUSD],
		error: { code: 'INSUFFICIENT_BTC', details }
	});
	assert.deepEqual(refused, { code: 'INSUFFICIENT_SATS', text: said });
	assert.match(onHandShortage({ needed: 1308, onHandSats: 4308 }, 'Minting'), /^Minting costs 1,308 sats, .*comes straight back\. Deposit bitcoin/);
	// Nothing to add when the cost is the whole story.
	for (const plain of [undefined, {}, { needed: 5590, spendable: 1200 }, { needed: 5000, onHandSats: 5000 }, { onHandSats: 4308 }]) assert.equal(onHandShortage(plain, 'Sending'), null);
});

test("the wallet's own refusal of a send is put in the reader's terms", () => {
	const decoded = { assetId: BUSD.assetId, groupKey: 'g1', amount: '10000', own: false };
	const short = sendRefusal({
		decoded,
		holdings: [BUSD],
		error: { code: 'INSUFFICIENT_BTC', details: { needed: 5590, spendable: 1200, feeSats: 4590, anchorSats: 1000 } }
	});
	assert.equal(short.code, 'INSUFFICIENT_SATS');
	assert.equal(
		short.text,
		'Sending needs 5,590 sats in bitcoin (4,590 for the miner fee and 1,000 that travel with the asset), and this wallet has 1,200 sats on-chain. Deposit bitcoin on the Receive tab first.'
	);
	assert.equal(sendRefusal({ decoded, holdings: [BUSD], error: { code: 'FEE_TOO_HIGH' } }).code, 'FEE_TOO_HIGH');
	const other = sendRefusal({ decoded, holdings: [BUSD], error: { code: 'SOMETHING', message: 'the wallet is busy' } });
	assert.deepEqual(other, { code: 'SOMETHING', text: 'the wallet is busy.' });
	assert.equal(sentence('Already ends.'), 'Already ends.');
});

test('a channel open turned down after its dialog closed is announced with the wallet\'s own reason', () => {
	const refused = { code: 'PEER_NO_ASSET_CHANNELS', message: 'That peer does not take asset channels.', channelId: 'ab'.repeat(32) };
	assert.deepEqual(describeAssetEvent('assets:error', refused), {
		text: 'The asset channel was not opened. That peer does not take asset channels.',
		tone: 'error',
		duration: 12000
	});
	// Only an error about a channel, and only one that says something.
	assert.equal(describeAssetEvent('assets:error', { code: 'X', message: 'something else' }), null);
	assert.equal(describeAssetEvent('assets:error', { code: 'X', message: '  ', channelId: 'ab'.repeat(32) }), null);
	assert.equal(describeAssetEvent('assets:error', null), null);
});

test('an event is announced when something finishes or fails, with what it was', () => {
	const asset = { name: 'BUSD', type: 'normal', decimalDisplay: 2, amount: '100000000' };
	const done = (kind, extra = {}) => ({ row: { kind, state: 'complete', assets: [asset], ...extra } });
	assert.deepEqual(describeAssetEvent('assets:mint', done('mint')), { text: 'BUSD is ready: 1,000,000.00 minted', tone: 'success', duration: 8000 });
	assert.equal(describeAssetEvent('assets:receive', done('receive')).text, 'Received 1,000,000.00 BUSD');
	assert.equal(describeAssetEvent('assets:transfer', done('send')).text, 'Sent 1,000,000.00 BUSD: proof delivered');
	assert.equal(describeAssetEvent('assets:transfer', done('burn')).text, 'Burned 1,000,000.00 BUSD');
	const failed = { row: { kind: 'mint', state: 'failed', failed: true, failure: { message: 'no usable coins.' }, assets: [asset] } };
	assert.deepEqual(describeAssetEvent('assets:mint', failed), { text: 'Minting BUSD failed: no usable coins', tone: 'error', duration: 9000 });
	// Every confirmation is an event; only the end of the story is news.
	assert.equal(describeAssetEvent('assets:mint', { row: { kind: 'mint', state: 'confirming', assets: [asset] } }), null);
	assert.equal(describeAssetEvent('assets:balance', {}), null);
	assert.equal(describeAssetEvent('assets:status', { row: null }), null);
});

test('a request whose answer was lost is asked about before it is sent again', async () => {
	const calls = [];
	const lost = Object.assign(new Error('gateway timeout'), { code: 'PROXY_ERROR' });
	// The first answer never arrives, but the wallet did it: the row is there.
	const recovered = await submitOnce(
		async (key) => {
			calls.push(['send', key]);
			throw lost;
		},
		'k1',
		async (key) => {
			calls.push(['find', key]);
			return { id: 'row-1', clientRef: key };
		},
		{ delays: [1] }
	);
	assert.deepEqual(recovered, { row: { id: 'row-1', clientRef: 'k1' }, recovered: true });
	assert.deepEqual(calls, [['send', 'k1'], ['find', 'k1']], 'it was not sent a second time');
});

test('a lost request that did not land is sent again under the same key', async () => {
	const keys = [];
	let attempt = 0;
	const answer = await submitOnce(
		async (key) => {
			keys.push(key);
			if (++attempt === 1) throw new Error('socket hang up');
			return { row: { id: 'row-2' } };
		},
		'k2',
		async () => null,
		{ delays: [1] }
	);
	assert.deepEqual(answer, { row: { id: 'row-2' } });
	assert.deepEqual(keys, ['k2', 'k2'], 'the same key, so the wallet can tell it is the same request');
});

test('a refusal is not retried, and silence is reported as not knowing', async () => {
	let sends = 0;
	const refusal = Object.assign(new Error('Not enough bitcoin'), { code: 'INSUFFICIENT_BTC' });
	await assert.rejects(
		submitOnce(
			async () => {
				sends++;
				throw refusal;
			},
			'k3',
			async () => null,
			{ delays: [1] }
		),
		(e) => e === refusal && !e.unknown
	);
	assert.equal(sends, 1, 'the wallet said no, and no is an answer');

	await assert.rejects(
		submitOnce(
			async () => {
				throw Object.assign(new Error('not running'), { code: 'NOT_RUNNING' });
			},
			'k4',
			async () => null,
			{ delays: [1, 1] }
		),
		(e) => e.unknown === true
	);
	assert.equal(isRefusal({ code: 'PREVIEW_EXPIRED' }), true);
	assert.equal(isRefusal({ code: 'PROXY_ERROR' }), false);
	assert.equal(isRefusal(new Error('dropped')), false);
});

test('an asset is described by what kind it is, how much exists and where it sits', () => {
	assert.equal(describeType(BUSD), 'asset, shown with 2 decimal places');
	assert.equal(describeType({ type: 'normal', decimalDisplay: 0 }), 'asset, counted in whole units');
	assert.equal(describeType({ type: 'collectible' }), 'collectible, one of one');
	assert.equal(describeSupply(BUSD, [{}, {}]), '1,000,000.00 BUSD issued in 2 mints · 500.00 burned');
	assert.equal(describeSupply({ ...BUSD, supply: { known: false } }), 'not known: this wallet has only seen its own part');
	assert.equal(describeSplit(BUSD), 'on-chain 12,500.00 · lightning 2,400.00');
	assert.equal(describeSplit({ ...BUSD, balance: { onchain: '100', channelLocal: '0', pendingIn: '2500', pendingOut: '0' } }), '25.00 arriving');
	assert.equal(describeSplit({ ...BUSD, balance: { onchain: '100', channelLocal: '0' } }), '', 'all in one place needs no split');
});

test('a proof server is read from, and written to, the wallet setting', () => {
	assert.deepEqual(universeToForm({ courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com' }), {
		host: 'u.example.com',
		port: '10029',
		rest: 'https://u.example.com'
	});
	assert.deepEqual(universeToForm(null), { host: '', port: '', rest: '' });
	assert.deepEqual(formToUniverse({ host: ' u.example.com ', port: '', rest: '' }), {
		universe: { courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com' }
	});
	assert.deepEqual(formToUniverse({ host: 'u.example.com', port: '443', rest: 'https://api.example.com/' }), {
		universe: { courier: 'universerpc://u.example.com:443', rest: 'https://api.example.com' }
	});
	assert.equal(formToUniverse({ host: '', port: '', rest: '' }).problem, "Enter the proof server's host.");
	assert.equal(formToUniverse({ host: 'u.example.com', port: '70000', rest: '' }).problem, 'The port is a number from 1 to 65535.');
	assert.equal(formToUniverse({ host: 'u.example.com/path', port: '', rest: '' }).problem, 'The host is a name or an address, without a path.');
});

test('a proof server test says what it found, and when it is the wrong chain', () => {
	assert.deepEqual(describeProofServerTest({ reachable: true, network: 'mainnet', ms: 212 }, 'mainnet'), { state: 'ok', text: 'Reachable · mainnet · 212 ms' });
	assert.deepEqual(describeProofServerTest({ reachable: true, network: 'testnet', ms: 90 }, 'mainnet'), {
		state: 'wrong-chain',
		text: 'This server is for testnet, and this wallet is on mainnet.'
	});
	assert.deepEqual(describeProofServerTest({ reachable: false, error: 'connection refused' }, 'mainnet'), {
		state: 'unreachable',
		text: 'Not reachable: connection refused.'
	});
	assert.equal(describeProofServerTest(null, 'mainnet'), null);
});

test('where the host stands is read from its status, the last refusal and the record', () => {
	const refused = (code, message) => Object.assign(new Error(message), { code, status: 503 });
	const failedRecord = { assets: { phase: 'failed', error: 'The assets database is locked' } };

	assert.deepEqual(hostState({ loading: true }), { kind: 'loading' });
	assert.deepEqual(hostState({}), { kind: 'loading' }, 'nothing asked yet is still loading');
	assert.deepEqual(hostState({ status: { ready: true, phase: 'ready' } }), { kind: 'ready' });
	assert.deepEqual(hostState({ status: { ready: true, phase: 'degraded' } }), { kind: 'ready' }, 'degraded still answers');

	// Starting: counted when the host counts, and never past the total.
	assert.deepEqual(hostState({ status: { ready: false, phase: 'starting' } }), { kind: 'starting', done: null, total: null });
	assert.deepEqual(hostState({ status: { ready: false, startup: { done: 3, total: 12 } } }), { kind: 'starting', done: 3, total: 12 });
	assert.deepEqual(hostState({ status: { ready: false, startup: { done: 14, total: 12 } } }), { kind: 'starting', done: 12, total: 12 });

	// Failed, each way it is said.
	assert.deepEqual(hostState({ status: { ready: false, phase: 'failed', error: 'No proof store' } }), { kind: 'unavailable', reason: 'No proof store' });
	assert.deepEqual(hostState({ status: { ready: false, phase: 'failed', error: { message: 'No proof store' } } }), {
		kind: 'unavailable',
		reason: 'No proof store'
	});
	assert.deepEqual(hostState({ status: { ready: false, phase: 'failed', error: null } }), { kind: 'unavailable', reason: null });
	assert.deepEqual(hostState({ loading: true, rec: failedRecord }), { kind: 'unavailable', reason: 'The assets database is locked' });
	for (const code of ['ASSETS_UNAVAILABLE', 'EXTENSION_UNAVAILABLE']) {
		assert.deepEqual(hostState({ error: refused(code, 'Not available') }), { kind: 'unavailable', reason: 'Not available' }, code);
		assert.deepEqual(
			hostState({ error: refused(code, 'Not available'), rec: failedRecord }),
			{ kind: 'unavailable', reason: 'The assets database is locked' },
			`${code}: the record's reason is the better one`
		);
		// A status that answered before the host went is not believed over the route.
		assert.equal(hostState({ status: { ready: true, phase: 'ready' }, error: refused(code, 'Not available') }).kind, 'unavailable');
	}

	// A record that is behind the wallet does not outvote a status that answers.
	assert.deepEqual(hostState({ status: { ready: true, phase: 'ready' }, rec: failedRecord }), { kind: 'ready' });

	// The wallet restarting under it is a wait, whatever was heard before.
	assert.deepEqual(hostState({ error: refused('ASSETS_STOPPING', 'The wallet is restarting. Try again in a moment.') }), { kind: 'restarting' });
	assert.deepEqual(hostState({ status: { ready: true }, error: refused('ASSETS_STOPPING', 'x'), rec: failedRecord }), { kind: 'restarting' });

	// Any other failure: unreadable with nothing to show, and the last answer kept when there is one.
	const down = refused('NOT_RUNNING', 'Wallet is not running');
	assert.deepEqual(hostState({ error: down }), { kind: 'unreadable', error: down });
	assert.deepEqual(hostState({ status: { ready: true }, error: down }), { kind: 'ready' });
});

test('what waits on a proof server that is away is said for a send and for a receive', () => {
	const away = { host: 'universe.lightning.finance:10029', reachable: false };
	assert.equal(proofServerWait(null, 'send'), null);
	assert.equal(proofServerWait({ ...away, reachable: true }, 'send'), null);
	assert.equal(proofServerWait({ ...away, reachable: null }, 'receive'), null, 'not asked yet is not away');

	assert.match(proofServerWait(away, 'send'), /a send still goes out and confirms\. Its proof waits here/);
	assert.match(proofServerWait(away, 'receive'), /an address can still be made and paid\..*Nothing is lost while it waits\./);

	// A send's proof goes where its address says, so another server's address is not this wallet's wait.
	assert.match(proofServerWait(away, 'send', 'universe.lightning.finance:10029'), /a send still goes out/);
	assert.match(proofServerWait(away, 'send', 'Universe.Lightning.Finance'), /a send still goes out/, 'the same server, with or without its port');
	assert.equal(proofServerWait(away, 'send', 'universe.example.com:10029'), null);
	assert.match(proofServerWait(away, 'receive', 'universe.example.com:10029'), /an address can still be made/, 'a receive is always through this one');
});

test("the proof servers offered are the app's for the wallet's network, the default first", () => {
	const config = {
		universeServers: [
			{ id: 'lightning-labs', label: 'Lightning Labs', courier: 'universerpc://universe.lightning.finance:10029', rest: 'https://universe.lightning.finance', networks: ['mainnet'], note: 'Run by Lightning Labs' },
			{ id: 'lightning-labs-testnet', label: 'Lightning Labs', courier: 'universerpc://testnet.universe.lightning.finance:10029', rest: 'https://testnet.universe.lightning.finance', networks: ['testnet'] },
			{ id: 'second', label: 'Second', courier: 'universerpc://second.example.com:10029', rest: 'https://second.example.com', networks: ['mainnet', 'testnet'] },
			{ id: 'half', label: 'Half', courier: 'universerpc://half.example.com:10029', networks: ['mainnet'] }
		]
	};
	assert.deepEqual(proofServersFor(config, 'mainnet'), [
		{ id: 'lightning-labs', label: 'Lightning Labs', host: 'universe.lightning.finance:10029', courier: 'universerpc://universe.lightning.finance:10029', rest: 'https://universe.lightning.finance', note: 'Run by Lightning Labs' },
		{ id: 'second', label: 'Second', host: 'second.example.com:10029', courier: 'universerpc://second.example.com:10029', rest: 'https://second.example.com', note: null }
	]);
	assert.deepEqual(proofServersFor(config, 'testnet').map((s) => s.id), ['lightning-labs-testnet', 'second']);
	assert.deepEqual(proofServersFor(config, 'regtest'), []);
	assert.deepEqual(proofServersFor(null, 'mainnet'), [], 'an app that lists none offers none');
	assert.deepEqual(proofServersFor({}, 'mainnet'), []);
});

test('a testnet wallet is offered the proof server of the testnet it is on', () => {
	const config = {
		universeServers: [
			{ id: 'main', courier: 'universerpc://universe.lightning.finance:10029', rest: 'https://universe.lightning.finance', networks: ['mainnet'], chain: null },
			{ id: 'three', courier: 'universerpc://testnet.universe.lightning.finance:10029', rest: 'https://testnet.universe.lightning.finance', networks: ['testnet'], chain: 'testnet3' },
			{ id: 'four', courier: 'universerpc://testnet4.universe.lightning.finance:443', rest: 'https://testnet4.universe.lightning.finance', networks: ['testnet'], chain: 'testnet4' },
			{ id: 'either', courier: 'universerpc://either.example.com:10029', rest: 'https://either.example.com', networks: ['testnet'] }
		]
	};
	assert.deepEqual(proofServersFor(config, 'testnet', 'testnet4').map((s) => s.id), ['four', 'either']);
	assert.equal(proofServersFor(config, 'testnet', 'testnet4')[0].host, 'testnet4.universe.lightning.finance:443');
	assert.deepEqual(proofServersFor(config, 'testnet', 'testnet3').map((s) => s.id), ['three', 'either']);
	// Until the wallet's host has said which testnet, both are listed.
	assert.deepEqual(proofServersFor(config, 'testnet').map((s) => s.id), ['three', 'four', 'either']);
	assert.deepEqual(proofServersFor(config, 'testnet', null).map((s) => s.id), ['three', 'four', 'either']);
	// A network that is one chain is not narrowed by its own name.
	assert.deepEqual(proofServersFor(config, 'mainnet', 'mainnet').map((s) => s.id), ['main']);
});

test('the chain in words, and the explorer to link, follow what the host says', () => {
	const on = (name) => ({ chain: { name, height: 1, minConfirmations: 6 } });
	assert.equal(chainName('testnet', on('testnet4')), 'testnet4');
	assert.equal(chainName('testnet', on('testnet3')), 'testnet3');
	assert.equal(chainName('testnet', on(null)), 'testnet');
	assert.equal(chainName('testnet', null), 'testnet');
	assert.equal(chainName('mainnet', on('mainnet')), 'mainnet');
	assert.equal(chainName('regtest', {}), 'regtest');
	assert.equal(explorerNetwork('testnet', on('testnet4')), 'testnet4');
	assert.equal(explorerNetwork('testnet', on('testnet3')), 'testnet');
	assert.equal(explorerNetwork('testnet', null), 'testnet');
	assert.equal(explorerNetwork('mainnet', on('mainnet')), 'mainnet');
	assert.equal(explorerNetwork('regtest', on('regtest')), 'regtest');
});

test('a wallet whose own transaction was just broadcast is not told it has no bitcoin', () => {
	// For a second after a mint, send or burn goes out, spendable reads zero:
	// the coin it spent is gone and the change is not seen yet.
	const base = { status: { ...STATUS, backup: null }, btc: { spendableSats: 0 }, holdings: [BUSD], now: NOW };
	const row = (kind, state, more = {}) => ({ id: `${kind}-1`, kind, state, failed: false, assets: [], at: { created: NOW - 1000, broadcast: NOW - 1000 }, ...more });
	for (const kind of ['mint', 'send', 'burn']) {
		for (const state of ['pending', 'broadcast']) {
			assert.deepEqual(codes(assetWarnings({ ...base, rows: [row(kind, state)] })), [], `${kind} ${state}`);
		}
	}
	assert.deepEqual(codes(assetWarnings({ ...base, rec: { lfbw: { enabled: true } }, rows: [row('burn', 'broadcast')] })), []);

	// Once it has a block, a wallet that really is empty hears it.
	assert.deepEqual(codes(assetWarnings({ ...base, rows: [row('mint', 'confirming', { confirmations: 1 })] })), ['NO_SATS']);
	assert.deepEqual(codes(assetWarnings({ ...base, rows: [row('send', 'complete')] })), ['NO_SATS']);
	// Somebody else's payment on its way in spends nothing of this wallet's.
	assert.deepEqual(codes(assetWarnings({ ...base, rows: [row('receive', 'waiting')] })), ['NO_SATS']);
	// And a transaction that failed is not one that is settling.
	assert.deepEqual(codes(assetWarnings({ ...base, rows: [row('mint', 'broadcast', { failed: true })] })), ['NO_SATS']);
});

test('a stuck transaction says fees cannot be bumped and offers to broadcast it again', () => {
	const stuck = {
		id: 'send-9',
		kind: 'send',
		state: 'broadcast',
		failed: false,
		stuck: true,
		confirmations: 0,
		satsPerVbyte: 2,
		assets: [],
		at: { created: NOW - 7_200_000, broadcast: NOW - 7_200_000 }
	};
	const [w] = assetWarnings({ status: { ...STATUS, backup: null }, btc: { spendableSats: 5000 }, holdings: [BUSD], rows: [stuck], fees: { fast: 18 }, now: NOW });
	assert.equal(w.code, 'STUCK');
	assert.equal(w.action, 'rebroadcast');
	assert.equal(w.rowId, 'send-9');
	assert.match(limitText(w), /cannot be fee-bumped yet/);
	assert.match(limitText(w), /Broadcasting it again sends the same transaction/);

	// A receive is somebody else's transaction: there is nothing of ours to send again.
	const theirs = assetWarnings({ status: { ...STATUS, backup: null }, btc: { spendableSats: 5000 }, holdings: [BUSD], rows: [{ ...stuck, kind: 'receive' }], fees: { fast: 18 }, now: NOW });
	assert.ok(theirs.every((x) => x.action !== 'rebroadcast'));
});

test('a refusal the page has no words of its own for is said in the wallet\'s words, never as a code', () => {
	const decoded = { assetId: BUSD.assetId, groupKey: BUSD.groupKey || null, amount: '100', own: false };
	for (const [code, message] of [
		['ASSET_IN_USE', 'Those units are being spent by a transaction that has not confirmed'],
		['FEE_UNKNOWN', 'The wallet could not learn the going fee rate'],
		['ASSETS_STARTING', 'Assets are still starting. Try again in a moment.'],
		['PROOF_SERVER_UNREACHABLE', 'The proof server is not answering']
	]) {
		const said = sendRefusal({ decoded, holdings: [BUSD], error: Object.assign(new Error(message), { code }) });
		assert.equal(said.code, code);
		assert.equal(said.text, sentence(message));
		assert.ok(!said.text.includes(code), 'the code is not what is read');
	}
	assert.equal(hostState({ error: { code: 'ASSETS_STARTING' }, status: null }).kind, 'starting');
});

test('a proof file taken by hand is answered in a sentence that says what became of it', () => {
	const received = { id: 'r1', kind: 'receive', state: 'complete', failed: false, failure: null, assets: [{ ...BUSD, amount: '25000' }], at: {} };
	assert.deepEqual(proofTaken({ result: 'complete', row: received }), { text: 'The proof checks out, and the asset is in your holdings.', tone: 'success' });
	assert.deepEqual(proofTaken({ result: 'already', row: received }), { text: 'This wallet already has that payment. Nothing changed.', tone: 'info' });
	// Kept is not taken: it says what the wallet is waiting for, and that no server is.
	assert.deepEqual(proofTaken({ result: 'kept', waitingFor: 'confirmations', row: { ...received, state: 'confirming', confirmationsRequired: 6 } }), {
		text: 'The proof file is kept. The asset arrives once its transaction is 6 blocks deep, with no proof server needed.',
		tone: 'info'
	});
	assert.deepEqual(proofTaken({ result: 'kept', waitingFor: 'check', reason: 'The chain could not be read.' }), {
		text: 'The proof file is kept, and could not be checked just now (The chain could not be read). The wallet tries again by itself.',
		tone: 'info'
	});
	assert.equal(proofTaken({ result: 'kept', waitingFor: 'check' }).text, 'The proof file is kept, and could not be checked just now. The wallet tries again by itself.');
});

test('a proof file is saved as the bytes the wallet gave, and the size it takes is the host\'s', () => {
	const bytes = Uint8Array.from([0x54, 0x41, 0x50, 0x46, 0x00, 0xff, 0x80]);
	assert.deepEqual(proofFileBytes(btoa(String.fromCharCode(...bytes))), bytes);
	assert.deepEqual(proofFileBytes(''), new Uint8Array(0));
	assert.equal(MAX_PROOF_FILE_BYTES, 4 * 1024 * 1024);
});
