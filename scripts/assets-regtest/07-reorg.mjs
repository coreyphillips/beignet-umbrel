// A reorganisation. On regtest an asset is spendable after one block, so its
// proof names that block. The block is then taken out of the chain and the
// transaction mined again in another one: the proof the wallet holds now
// names a block that is gone. The wallet has to notice and rebuild it, and
// the test that it did is tapd's: tapd checks every proof it is sent against
// its own chain, and credits the transfer only if the proof holds there.
import { newWallet, post, idem, mine, btc, height, inMempool, rowReaches, onchain, tapcli, tapdKnows, tapdBalance, waitFor, check, sleep, done, mintAndConfirm, txConfirmations } from './lib.mjs';

const A = await newWallet('Reorg');
const B = await newWallet('Reorg B');
const mint = await mintAndConfirm(A.id, [{ name: `reorg-${Date.now().toString(36)}`, type: 'normal', amount: '5000' }]);
const assetId = mint.assets[0].assetId;
const mintHeight = height() - (txConfirmations(mint.txid) - 1);
const oldHash = btc('getblockhash', mintHeight);
check('the mint is confirmed and spendable', (await onchain(A.id, assetId)) === '5000' && txConfirmations(mint.txid) >= 1, `height ${mintHeight}`);

// A transfer to B confirmed in the same stretch of chain that is about to go.
const addr = await post(B.id, '/addresses', { key: assetId, amount: '1000' });
const p = await post(A.id, '/send/prepare', { address: addr.address.encoded, feeRate: 2 }, idem());
const sent = await post(A.id, '/send/commit', { previewId: p.previewId }, idem());
mine(1);
await rowReaches(A.id, sent.row.id, 'complete', { mineEach: false, timeoutMs: 180000 });
await rowReaches(B.id, addr.row.id, 'complete', { mineEach: false, timeoutMs: 180000 });
check('a transfer on top of it completed too', (await onchain(B.id, assetId)) === '1000' && (await onchain(A.id, assetId)) === '4000');

// Take the mint's block, and everything after it, out of the chain.
const tipBefore = height();
btc('invalidateblock', oldHash);
check('the chain lost the blocks', height() === mintHeight - 1, `${tipBefore} -> ${height()}`);
check('both transactions are back in the mempool', inMempool(mint.txid) && inMempool(sent.row.txid));
// Mine past the old tip so every node follows the new chain: the mint in one
// block, the transfer that spends it in the next.
mine(tipBefore - height() + 3);
const newHash = btc('getblockhash', mintHeight);
check('the mint is confirmed again, in a different block', txConfirmations(mint.txid) >= 1 && newHash !== oldHash, `${oldHash.slice(0, 12)} -> ${newHash.slice(0, 12)}`);
check('so is the transfer', txConfirmations(sent.row.txid) >= 1);

// Balances are unchanged: the same transactions confirmed, elsewhere.
await sleep(8000);
mine(1);
await waitFor('the wallets settle on the new chain', async () => (await onchain(A.id, assetId)) === '4000' && (await onchain(B.id, assetId)) === '1000', { timeoutMs: 120000 });
check('both wallets hold what they held', true);

// tapd is the judge: it takes a transfer from each wallet only if the whole
// proof chain, mint included, holds on the chain it follows.
mine(6);
// The copy of the issuance on the proof server was published before the
// reorganisation. A wallet that has never seen the asset fetches it and
// checks it against the chain as it is now.
const C = await newWallet('Reorg C', { sats: 0 });
const learned = await post(C.id, '/lookup', { id: assetId }).catch((e) => ({ error: e.code }));
check('the proof server\'s copy of the issuance still verifies on the new chain', !!learned.asset && learned.asset.assetId === assetId && tapdKnows(assetId), JSON.stringify(learned).slice(0, 120));
for (const [who, id, amount] of [['the minter', A.id, '700'], ['the receiver', B.id, '250']]) {
	const to = tapcli('addrs', 'new', '--asset_id', assetId, '--amt', amount);
	const before = BigInt(tapdBalance(assetId));
	const pp = await post(id, '/send/prepare', { address: to.encoded, feeRate: 2 }, idem());
	const ss = await post(id, '/send/commit', { previewId: pp.previewId }, idem());
	mine(1);
	await rowReaches(id, ss.row.id, 'complete', { mineEach: true, timeoutMs: 240000 });
	await waitFor(`tapd completes the receive from ${who}`, () => (tapcli('addrs', 'receives', '--addr', to.encoded).events || []).some((e) => e.status === 'ADDR_EVENT_STATUS_COMPLETED'), { timeoutMs: 240000 });
	check(`tapd verified ${who}'s proof on the new chain and credited it`, BigInt(tapdBalance(assetId)) === before + BigInt(amount), tapdBalance(assetId));
}
check('the books balance', (await onchain(A.id, assetId)) === '3300' && (await onchain(B.id, assetId)) === '750', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)}`);

done({ A: A.id, B: B.id, assetId });
