// The recovery phrase does not bring assets back; the app backup does. Mint
// and receive, archive the box, delete a wallet and everything it kept,
// restore the archive, and the assets are there and can be spent.
import { newWallet, api, post, idem, mine, rowReaches, onchain, status, healthy, assetsReady, balances, check, done, mintAndConfirm, M, waitFor } from './lib.mjs';

const PASSPHRASE = 'regtest passphrase for assets';
const A = await newWallet('Backup A');
const B = await newWallet('Backup B');
const mint = await mintAndConfirm(A.id, [{ name: `kept-${Date.now().toString(36)}`, type: 'normal', amount: '900', decimalDisplay: 2 }]);
const assetId = mint.assets[0].assetId;
const addr = await post(B.id, '/addresses', { key: assetId, amount: '100' });
const p = await post(A.id, '/send/prepare', { address: addr.address.encoded, feeRate: 2 }, idem());
const sent = await post(A.id, '/send/commit', { previewId: p.previewId }, idem());
mine(1);
await rowReaches(A.id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(B.id, addr.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });

const s = await waitFor('the assets backup file is written', async () => {
	const st = await status(A.id);
	return st.backup.exportedAt && !st.backup.dirty ? st : null;
});
check('the host says when it last wrote its backup', s.backup.exportedAt > 0);
const recBefore = await api(`/wallets/${A.id}`);
check('the wallet record says it holds assets and has a file to archive', recBefore.assets.holdsAssets === true && recBefore.assets.backupFile === true, JSON.stringify(recBefore.assets));
check('assets that changed since the last archive make it stale', recBefore.backupStale === true);

// Archive the box.
const res = await fetch(`${M}/api/backup/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: PASSPHRASE }) });
check('the box archives', res.ok, String(res.status));
const archive = Buffer.from(await res.arrayBuffer()).toString('base64');
check('the archive is no longer stale for either wallet', (await api(`/wallets/${A.id}`)).backupStale === false && (await api(`/wallets/${B.id}`)).backupStale === false);

// Lose both wallets entirely: record, seed, database, assets.
const held = { A: await onchain(A.id, assetId), B: await onchain(B.id, assetId) };
await api(`/wallets/${A.id}?purge=true`, { method: 'DELETE' });
await api(`/wallets/${B.id}?purge=true`, { method: 'DELETE' });
const inspected = await api('/backup/inspect', { method: 'POST', body: { passphrase: PASSPHRASE, archive } });
check('the archive lists both wallets as restorable', inspected.wallets.filter((w) => w.action === 'restore').length >= 2, JSON.stringify(inspected.wallets.map((w) => w.action)));
await api('/backup/restore', { method: 'POST', body: { passphrase: PASSPHRASE, archive } });
for (const id of [A.id, B.id]) {
	check('a restored wallet says it holds assets before it is started', (await api(`/wallets/${id}`)).assets.holdsAssets === true);
	await api(`/wallets/${id}/start`, { method: 'POST', body: {} });
	await healthy(id);
	await assetsReady(id);
}
await waitFor('restored balances appear', async () => (await onchain(A.id, assetId)) === held.A && (await onchain(B.id, assetId)) === held.B);
check('both wallets hold what they held', (await onchain(A.id, assetId)) === '800' && (await onchain(B.id, assetId)) === '100', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)}`);
const restored = (await balances(A.id)).assets.find((a) => a.assetId === assetId);
check('the asset keeps its name and decimals', restored.name === mint.assets[0].name && restored.decimalDisplay === 2);

// And they are spendable: B pays A from restored state, to a fresh address.
await waitFor('restored bitcoin is seen', async () => (await balances(B.id)).btc.spendableSats > 10000, { timeoutMs: 180000 });
const addr2 = await post(A.id, '/addresses', { key: assetId, amount: '40' });
const p2 = await post(B.id, '/send/prepare', { address: addr2.address.encoded, feeRate: 2 }, idem());
const s2 = await post(B.id, '/send/commit', { previewId: p2.previewId }, idem());
mine(1);
await rowReaches(B.id, s2.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(A.id, addr2.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('restored assets can be sent and received', (await onchain(A.id, assetId)) === '840' && (await onchain(B.id, assetId)) === '60', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)}`);

done({ A: A.id, B: B.id, assetId });
