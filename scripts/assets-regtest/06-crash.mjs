// Power cuts. The daemon is killed outright (SIGKILL: nothing flushed, no
// stop handler) at the moments that matter, and the daemon that comes back
// must neither lose what was confirmed nor do anything twice: a preview is
// thrown away with nothing held, a mint or a send that reached the network
// is finished once, and a request repeated with its key gets the same answer.
import { newWallet, post, idem, mine, mempool, inMempool, rowReaches, onchain, balances, status, crash, refusal, check, done, mintAndConfirm } from './lib.mjs';

const A = await newWallet('Crash A');
const B = await newWallet('Crash B');

// 1. Killed straight after a mint is broadcast.
const mintKey = idem();
const mintBody = { seedlings: [{ name: `crash-${Date.now().toString(36)}`, type: 'normal', amount: '1000' }], feeRate: 2 };
const { row: mintRow } = await post(A.id, '/mint', mintBody, mintKey);
await crash(A.id);
const mintAgain = await post(A.id, '/mint', mintBody, mintKey);
check('after a crash the same key still answers the same mint', mintAgain.row.id === mintRow.id && mintAgain.row.txid === mintRow.txid);
check('the mint is in the mempool once', mempool().filter((t) => t === mintRow.txid).length === 1 && (await status(A.id)).pending.mints === 1, JSON.stringify((await status(A.id)).pending));
mine(1);
const minted = await rowReaches(A.id, mintRow.id, 'complete', { mineEach: true });
const assetId = minted.assets[0].assetId;
check('the daemon that came back finishes the mint', (await onchain(A.id, assetId)) === '1000');

// 2. Killed with a preview open: funded and signed, never confirmed.
const addr = await post(B.id, '/addresses', { key: assetId, amount: '400' });
const spendableBefore = (await balances(A.id)).btc.spendableSats;
const before = mempool().length;
const open = await post(A.id, '/send/prepare', { address: addr.address.encoded, feeRate: 2 }, idem());
await crash(A.id);
const gone = await refusal(() => post(A.id, '/send/commit', { previewId: open.previewId }, idem()));
check('a preview does not survive a crash', !!gone && gone.code === 'PREVIEW_EXPIRED', gone ? gone.code : 'accepted');
check('nothing it prepared reached the network', mempool().length === before);
check('the bitcoin it had set aside for the fee is spendable again', (await balances(A.id)).btc.spendableSats === spendableBefore, `${(await balances(A.id)).btc.spendableSats} vs ${spendableBefore}`);
check('and so are the units', (await onchain(A.id, assetId)) === '1000' && (await status(A.id)).pending.sends === 0);

// 3. Killed straight after a send is committed, and the receiver with it.
const p = await post(A.id, '/send/prepare', { address: addr.address.encoded, feeRate: 2 }, idem());
const commitKey = idem();
const sent = await post(A.id, '/send/commit', { previewId: p.previewId }, commitKey);
check('the send reached the mempool before the crash', inMempool(sent.row.txid));
await crash(A.id);
await crash(B.id);
const again = await post(A.id, '/send/commit', { previewId: p.previewId }, commitKey);
check('after a crash the same key still answers the same send', again.row.id === sent.row.id && again.row.txid === sent.row.txid);
check('the send is in the mempool once, and nothing else was made', mempool().filter((t) => t === sent.row.txid).length === 1 && mempool().length === before + 1, String(mempool().length - before));
mine(1);
await rowReaches(A.id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(B.id, addr.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('both daemons that came back finish it', (await onchain(A.id, assetId)) === '600' && (await onchain(B.id, assetId)) === '400', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)}`);

// 4. Killed while a confirmed payment waits for its proof, mid-receive.
const addr2 = await post(B.id, '/addresses', { key: assetId, amount: '50' });
const p2 = await post(A.id, '/send/prepare', { address: addr2.address.encoded, feeRate: 2 }, idem());
const s2 = await post(A.id, '/send/commit', { previewId: p2.previewId }, idem());
mine(1);
await crash(B.id);
await crash(A.id);
await rowReaches(A.id, s2.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(B.id, addr2.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('a transfer in flight on both sides survives both crashing', (await onchain(A.id, assetId)) === '550' && (await onchain(B.id, assetId)) === '450', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)}`);

// 5. What crashed can still be spent, and nothing is left half done.
const back = await post(A.id, '/addresses', { key: assetId, amount: '450' });
const p3 = await post(B.id, '/send/prepare', { address: back.address.encoded, feeRate: 2 }, idem());
const s3 = await post(B.id, '/send/commit', { previewId: p3.previewId }, idem());
mine(1);
await rowReaches(B.id, s3.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(A.id, back.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('every unit is accounted for', (await onchain(A.id, assetId)) === '1000' && (await onchain(B.id, assetId)) === '0', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)}`);
check('nothing is left in progress', Object.values((await status(A.id)).pending).every((n) => n === 0) && Object.values((await status(B.id)).pending).every((n) => n === 0), JSON.stringify([(await status(A.id)).pending, (await status(B.id)).pending]));

done({ A: A.id, B: B.id, assetId });
