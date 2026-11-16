// What survives a restart: a mint or a send already broadcast is finished by
// the daemon that comes back, the key of a request is remembered so asking
// again never does it twice, and a preview nobody confirmed is thrown away.
import { newWallet, api, post, idem, mine, mempool, inMempool, rowReaches, onchain, status, healthy, assetsReady, refusal, check, done, mintAndConfirm, rowOf, waitFor } from './lib.mjs';

async function restart(id) {
	await api(`/wallets/${id}/stop`, { method: 'POST', body: {} });
	await waitFor('wallet stopped', async () => (await api(`/wallets/${id}`)).status === 'stopped');
	await api(`/wallets/${id}/start`, { method: 'POST', body: {} });
	await healthy(id);
	await assetsReady(id);
}

const A = await newWallet('Restart A');
const B = await newWallet('Restart B');

// A mint broadcast, then the daemon restarted before it confirms.
const key = idem();
const body = { seedlings: [{ name: `restart-${Date.now().toString(36)}`, type: 'normal', amount: '400' }], feeRate: 2 };
const { row } = await post(A.id, '/mint', body, key);
await restart(A.id);
const replay = await post(A.id, '/mint', body, key);
check('after a restart the same key still answers the same mint', replay.row.id === row.id && replay.row.txid === row.txid, `${replay.row.id} vs ${row.id}`);
check('and nothing was broadcast a second time', mempool().filter((t) => t === row.txid).length === 1 && (await status(A.id)).pending.mints === 1, JSON.stringify((await status(A.id)).pending));
mine(1);
const minted = await rowReaches(A.id, row.id, 'complete', { mineEach: true });
const assetId = minted.assets[0].assetId;
check('the restarted daemon finishes the mint', (await onchain(A.id, assetId)) === '400');

// A preview open at the restart is gone afterwards, and held nothing.
const addr = await post(B.id, '/addresses', { key: assetId, amount: '150' });
const open = await post(A.id, '/send/prepare', { address: addr.address.encoded, feeRate: 2 }, idem());
const before = mempool().length;
await restart(A.id);
const gone = await refusal(() => post(A.id, '/send/commit', { previewId: open.previewId }, idem()));
check('a preview does not survive a restart', !!gone && gone.code === 'PREVIEW_EXPIRED', gone ? gone.code : 'accepted');
check('and it broadcast nothing', mempool().length === before);

// A send committed, then both daemons restarted before it confirms.
const p = await post(A.id, '/send/prepare', { address: addr.address.encoded, feeRate: 2 }, idem());
check('the units the dead preview held are free again', p.amount === '150' && p.change === '250', JSON.stringify({ amount: p.amount, change: p.change }));
const commitKey = idem();
const sent = await post(A.id, '/send/commit', { previewId: p.previewId }, commitKey);
check('the send is in the mempool', inMempool(sent.row.txid));
await restart(A.id);
await restart(B.id);
const again = await post(A.id, '/send/commit', { previewId: p.previewId }, commitKey);
check('after a restart the same key still answers the same send', again.row.id === sent.row.id && again.row.txid === sent.row.txid);
check('the row is still there, still in flight', ['broadcast', 'confirming'].includes((await rowOf(A.id, sent.row.id)).state), (await rowOf(A.id, sent.row.id)).state);
mine(1);
await rowReaches(A.id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(B.id, addr.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('both restarted daemons finish it', (await onchain(A.id, assetId)) === '250' && (await onchain(B.id, assetId)) === '150', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)}`);

// A receive confirmed while the receiver was stopped.
const addr2 = await post(B.id, '/addresses', { key: assetId, amount: '50' });
await api(`/wallets/${B.id}/stop`, { method: 'POST', body: {} });
const p3 = await post(A.id, '/send/prepare', { address: addr2.address.encoded, feeRate: 2 }, idem());
const s3 = await post(A.id, '/send/commit', { previewId: p3.previewId }, idem());
mine(2);
await rowReaches(A.id, s3.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await api(`/wallets/${B.id}/start`, { method: 'POST', body: {} });
await healthy(B.id);
await assetsReady(B.id);
await rowReaches(B.id, addr2.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('a payment that confirmed while the wallet was stopped is found on start', (await onchain(B.id, assetId)) === '200', await onchain(B.id, assetId));

done({ A: A.id, B: B.id, assetId });
