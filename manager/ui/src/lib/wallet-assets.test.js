/**
 * Run with: npm test (from manager/ui).
 *
 * Taproot Assets as the rest of the dashboard sees them: which transactions
 * carry an asset and may not be fee bumped, and what stands between a
 * wallet's assets and the box backup. A recovery phrase alone does not bring
 * assets back, so the second half is what tells an owner before it matters.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	NO_ASSET_BUMP,
	PHRASE_ASSETS_NOTE,
	anchorAmounts,
	anchorAssetKey,
	anchorIndex,
	anchorLabel,
	assetsBackupGap,
	assetsLeftOut,
	assetsNotArchived,
	assetsShown,
	bumpVerdict,
	deleteAssetsNote
} from './wallet-assets.js';

const TX = (c) => c.repeat(64);
const busd = { key: 'k-busd', assetId: TX('1'), name: 'BUSD', type: 'normal', decimalDisplay: 2 };
const row = (kind, txid, assets = [{ ...busd, amount: '30000' }]) => ({ id: `${kind}-${txid.slice(0, 4)}`, kind, txid, assets });

const AT = '2026-11-01T00:00:00.000Z';
const holder = (assets = {}, rest = {}) => ({
	id: 'w1',
	name: 'Main',
	lastBackupAt: AT,
	backupStale: false,
	assets: { enabled: true, universe: null, holdsAssets: true, phase: 'ready', error: null, backupFile: true, notArchived: null, ...assets },
	...rest
});

test('assets are shown only where the app has a host and the wallet has not switched them off', () => {
	assert.equal(assetsShown({ assetsAvailable: true }, { assets: { enabled: true } }), true);
	assert.equal(assetsShown({ assetsAvailable: true }, {}), true, 'a record from before assets has no block');
	assert.equal(assetsShown({ assetsAvailable: true }, null), true);
	assert.equal(assetsShown({ assetsAvailable: true }, { assets: { enabled: false, holdsAssets: true } }), false);
	assert.equal(assetsShown({ assetsAvailable: false }, { assets: { enabled: true } }), false);
	assert.equal(assetsShown(null, { assets: { enabled: true } }), false, 'not before the config has answered');
});

test('the transactions that carry an asset are found by id, each named for what it did', () => {
	const rows = [
		row('send', TX('a')),
		row('mint', TX('b')),
		row('receive', TX('c')),
		row('burn', TX('d')),
		// A Lightning payment of an asset puts nothing on chain.
		{ id: 'ln', kind: 'ln-send', txid: null, assets: [{ ...busd, amount: '5' }] },
		// One transaction is one operation: the newest row for it wins.
		row('receive', TX('a'))
	];
	const index = anchorIndex(rows);
	assert.deepEqual([...index.keys()], [TX('a'), TX('b'), TX('c'), TX('d')]);
	assert.deepEqual(
		[...index.values()].map(anchorLabel),
		['Asset send', 'Asset mint', 'Asset receive', 'Asset burn']
	);
	assert.equal(anchorIndex(null).size, 0);
	assert.equal(anchorIndex(undefined).size, 0);
});

test('a row says which asset to open and how much of it moved', () => {
	assert.equal(anchorAssetKey(row('send', TX('a'))), 'k-busd');
	assert.equal(anchorAssetKey({ kind: 'send', assets: [{ assetId: TX('2') }] }), TX('2'), 'the id where there is no key');
	assert.equal(anchorAssetKey({ kind: 'send', assets: [] }), null);
	assert.equal(anchorAmounts(row('send', TX('a'))), '300.00 BUSD');
	const two = row('mint', TX('b'), [
		{ key: 'a', name: 'Alpha', type: 'normal', decimalDisplay: 0, amount: '1000' },
		{ key: 'b', name: 'Beta', type: 'normal', decimalDisplay: 0, amount: '20' }
	]);
	assert.equal(anchorAmounts(two), '1,000 Alpha and 20 Beta');
	assert.equal(anchorAmounts({ kind: 'send', assets: [] }), '');
});

test('a fee bump is offered for an ordinary transaction and never for one that carries an asset', () => {
	const anchors = anchorIndex([row('send', TX('a'))]);
	assert.equal(bumpVerdict(TX('a'), { anchors, known: true, atStake: true }), 'asset');
	assert.equal(bumpVerdict(TX('e'), { anchors, known: true, atStake: true }), 'yes');
	// The rows have not been read and the wallet has assets: nothing can be
	// told apart yet, so nothing is cleared.
	assert.equal(bumpVerdict(TX('e'), { anchors: new Map(), known: false, atStake: true }), 'unknown');
	// A wallet with no assets is never held up by a question about them.
	assert.equal(bumpVerdict(TX('e'), { anchors: new Map(), known: false, atStake: false }), 'yes');
	assert.equal(bumpVerdict(TX('e')), 'yes');
	assert.equal(NO_ASSET_BUMP, 'Asset transactions cannot be fee bumped yet.');
});

test('a wallet that holds no assets has nothing to say about them and the backup', () => {
	assert.equal(assetsBackupGap(null), null);
	assert.equal(assetsBackupGap({ id: 'w', name: 'Old' }), null, 'a record with no assets block');
	assert.equal(assetsBackupGap(holder({ holdsAssets: false, backupFile: null, notArchived: 'no-file' })), null);
	assert.equal(assetsBackupGap(holder()), null, 'held, written out and archived');
	assert.equal(deleteAssetsNote(holder({ holdsAssets: false })), null);
});

test('assets the last archive left out are named with the reason and what to do', () => {
	const noFile = assetsBackupGap(holder({ notArchived: 'no-file', backupFile: false }));
	assert.equal(noFile.code, 'no-file');
	assert.match(noFile.text, /^Assets not in the last backup/);
	assert.match(noFile.text, /Start the wallet and back up again\.$/);

	const tooLarge = assetsBackupGap(holder({ notArchived: 'too-large' }, { id: 'abc123' }));
	assert.equal(tooLarge.code, 'too-large');
	assert.match(tooLarge.text, /too large for an archive/);
	assert.match(tooLarge.text, /still on this box, under wallets\/abc123\/assets\/backup\.json\.$/);

	// The file an archive would carry is not there now: say so before the
	// next backup is made, not after.
	const unwritten = assetsBackupGap(holder({ backupFile: false }));
	assert.equal(unwritten.code, 'unwritten');
	assert.match(unwritten.text, /Start the wallet before you back up\.$/);

	const never = assetsBackupGap(holder({}, { lastBackupAt: null, backupStale: true }));
	assert.equal(never.code, 'never');
	assert.match(never.text, /Back up this box to keep them\.$/);
});

test('only what the last archive was written without counts as left out of it', () => {
	const wallets = [
		holder({ notArchived: 'no-file' }, { id: 'a', name: 'A' }),
		holder({ notArchived: 'too-large' }, { id: 'b', name: 'B' }),
		holder({ backupFile: false }, { id: 'c', name: 'C' }),
		holder({}, { id: 'd', name: 'D', lastBackupAt: null }),
		holder({}, { id: 'e', name: 'E' }),
		{ id: 'f', name: 'F' }
	];
	assert.deepEqual(assetsLeftOut(wallets).map((w) => w.id), ['a', 'b']);
	assert.equal(assetsNotArchived(wallets[2]), null);
	assert.equal(assetsNotArchived(wallets[3]), null);
	assert.deepEqual(assetsLeftOut(null), []);
});

test('deleting a wallet that holds assets says what goes and whether a backup has it', () => {
	const safe = deleteAssetsNote(holder());
	assert.equal(safe.safe, true);
	assert.match(safe.text, /^This wallet holds Taproot Assets\./);
	assert.match(safe.text, /erasing its data deletes their records/);
	assert.match(safe.text, /recovery phrase alone does not bring assets back/);
	assert.match(safe.text, /The last box backup holds them\.$/);

	const stale = deleteAssetsNote(holder({}, { backupStale: true }));
	assert.equal(stale.safe, false);
	assert.match(stale.text, /changed since the last box backup/);
	assert.match(stale.text, /Back up the box first\.$/);

	const leftOut = deleteAssetsNote(holder({ notArchived: 'no-file' }));
	assert.equal(leftOut.safe, false);
	assert.match(leftOut.text, /Assets not in the last backup/);
	assert.doesNotMatch(leftOut.text, /The last box backup holds them/);

	const never = deleteAssetsNote(holder({}, { lastBackupAt: null, backupStale: true }));
	assert.equal(never.safe, false);
	assert.match(never.text, /Assets in no backup yet/);
});

test('the copy is plain: no em dashes, and the phrase note says where assets come back from', () => {
	const texts = [
		NO_ASSET_BUMP,
		PHRASE_ASSETS_NOTE,
		deleteAssetsNote(holder()).text,
		deleteAssetsNote(holder({}, { backupStale: true })).text,
		assetsBackupGap(holder({ notArchived: 'no-file' })).text,
		assetsBackupGap(holder({ notArchived: 'too-large' })).text,
		assetsBackupGap(holder({ backupFile: false })).text,
		assetsBackupGap(holder({}, { lastBackupAt: null })).text
	];
	const emDash = String.fromCharCode(0x2014);
	for (const text of texts) assert.ok(!text.includes(emDash), text);
	assert.match(PHRASE_ASSETS_NOTE, /phrase alone does not restore them/);
	assert.match(PHRASE_ASSETS_NOTE, /Settings, Back up all wallets/);
});
