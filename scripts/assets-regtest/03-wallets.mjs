// Two wallets on this app: send with change, receive, send back, burn, and
// every refusal a send can make. Then the preview rules: a cancelled or
// superseded preview releases what it held and broadcasts nothing.
import { newWallet, api, post, idem, mine, mempool, inMempool, rowReaches, onchain, holding, balances, status, refusal, check, done, mintAndConfirm, activity } from './lib.mjs';

const A = await newWallet('Sender');
const B = await newWallet('Receiver', { onchainOnly: true });
const mint = await mintAndConfirm(A.id, [{ name: `shared-${Date.now().toString(36)}`, type: 'normal', amount: '1000', decimalDisplay: 1 }]);
const assetId = mint.assets[0].assetId;

// B has never held the asset: it finds it on the proof server.
const made = await post(B.id, '/addresses', { key: assetId, amount: '300' });
const dec = await post(A.id, '/addresses/decode', { address: made.address.encoded });
check('the sender reads the address: its asset, amount and that it holds enough', dec.assetId === assetId && dec.amount === '300' && dec.own === false && !!dec.asset, JSON.stringify({ amount: dec.amount, own: dec.own }));
const ownDec = await post(B.id, '/addresses/decode', { address: made.address.encoded });
check('the receiver knows its own address', ownDec.own === true);

// Refusals before anything is funded.
const own = await refusal(() => post(B.id, '/send/prepare', { address: made.address.encoded, feeRate: 2 }, idem()));
check('paying your own address is refused', !!own && own.code === 'OWN_ADDRESS', own ? own.code : 'accepted');
const big = await post(B.id, '/addresses', { key: assetId, amount: '5000' });
const tooMuch = await refusal(() => post(A.id, '/send/prepare', { address: big.address.encoded, feeRate: 2 }, idem()));
check('more than the wallet holds is refused', !!tooMuch && tooMuch.code === 'INSUFFICIENT_ASSET_BALANCE', tooMuch ? tooMuch.code : 'accepted');
const garbage = await refusal(() => post(A.id, '/send/prepare', { address: 'taprt1notanaddress', feeRate: 2 }, idem()));
check('a string that is not an address is refused', !!garbage && garbage.code === 'BAD_ADDRESS', garbage ? garbage.code : 'accepted');
const mainnet = await refusal(() => post(A.id, '/addresses/decode', { address: made.address.encoded.replace(/^taprt1/, 'tapbc1') }));
check('an address for another network is refused', !!mainnet && (mainnet.code === 'WRONG_NETWORK' || mainnet.code === 'BAD_ADDRESS'), mainnet ? mainnet.code : 'accepted');

// A preview that is cancelled holds nothing afterwards.
const before = mempool().length;
const p0 = await post(A.id, '/send/prepare', { address: made.address.encoded, feeRate: 2 }, idem());
check('the preview says what will be sent and kept', p0.amount === '300' && p0.change === '700' && p0.fee.sats > 0 && p0.btc.spendableSats > 0, JSON.stringify({ change: p0.change, fee: p0.fee }));
await post(A.id, '/send/cancel', { previewId: p0.previewId });
const late = await refusal(() => post(A.id, '/send/commit', { previewId: p0.previewId }, idem()));
check('a cancelled preview cannot be committed', !!late && late.code === 'PREVIEW_EXPIRED', late ? late.code : 'accepted');
// A second preview supersedes the first.
const p1 = await post(A.id, '/send/prepare', { address: made.address.encoded, feeRate: 2 }, idem());
const p2 = await post(A.id, '/send/prepare', { address: made.address.encoded, feeRate: 3 }, idem());
const stale = await refusal(() => post(A.id, '/send/commit', { previewId: p1.previewId }, idem()));
check('a superseded preview cannot be committed', !!stale && stale.code === 'PREVIEW_EXPIRED', stale ? stale.code : 'accepted');
check('no preview broadcast anything', mempool().length === before);
check('the fee follows the rate asked for', p2.fee.feeRate === 3 && p2.fee.sats > p1.fee.sats, JSON.stringify([p1.fee, p2.fee]));

// Send 300 with change.
const sent = await post(A.id, '/send/commit', { previewId: p2.previewId }, idem());
check('commit broadcasts one transaction', inMempool(sent.row.txid) && mempool().length === before + 1);
const mid = await holding(A.id, assetId);
check('the amount on its way is shown as pending out', mid.balance.pendingOut === '300', JSON.stringify(mid.balance));
mine(1);
await rowReaches(A.id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
const got = await rowReaches(B.id, made.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('the receiver has 300 and the sender 700', (await onchain(B.id, assetId)) === '300' && (await onchain(A.id, assetId)) === '700', `${await onchain(B.id, assetId)} / ${await onchain(A.id, assetId)}`);
check('both rows carry the same transaction', got.txid === sent.row.txid);
check('the receiver now holds assets, with bitcoin locked beside them', (await status(B.id)).holdsAssets === true && (await status(B.id)).lockedSats > 0);
check('the receiver is an on-chain only wallet, and assets run on it', (await api(`/wallets/${B.id}`)).onchainOnly === true && (await status(B.id)).ready === true);

// B sends 120 back, spending what it just received.
await mine(1);
const backAddr = await post(A.id, '/addresses', { key: assetId, amount: '120' });
const pb = await post(B.id, '/send/prepare', { address: backAddr.address.encoded, feeRate: 2 }, idem());
const sb = await post(B.id, '/send/commit', { previewId: pb.previewId }, idem());
mine(1);
await rowReaches(B.id, sb.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(A.id, backAddr.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('a received asset can be spent again', (await onchain(B.id, assetId)) === '180' && (await onchain(A.id, assetId)) === '820', `${await onchain(B.id, assetId)} / ${await onchain(A.id, assetId)}`);

// Burn 20 on A: said twice, or not at all.
const bp = await post(A.id, '/burn/prepare', { key: assetId, assetId, amount: '20', feeRate: 2 }, idem());
const unsaid = await refusal(() => post(A.id, '/burn/commit', { previewId: bp.previewId, confirmAmount: '21' }, idem()));
check('a burn whose amount is not repeated exactly is refused', !!unsaid && unsaid.status >= 400, unsaid ? unsaid.code : 'accepted');
const bp2 = await post(A.id, '/burn/prepare', { key: assetId, assetId, amount: '20', feeRate: 2 }, idem());
const burned = await post(A.id, '/burn/commit', { previewId: bp2.previewId, confirmAmount: '20' }, idem());
check('a burn is its own kind of row', burned.row.kind === 'burn' && inMempool(burned.row.txid));
mine(1);
await rowReaches(A.id, burned.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('the burned units are gone', (await onchain(A.id, assetId)) === '800', await onchain(A.id, assetId));

// The history reads newest first and pages.
const rows = (await activity(A.id, { limit: 200 })).rows;
check('activity lists the mint, the send, the receive and the burn', ['mint', 'send', 'receive', 'burn'].every((k) => rows.some((r) => r.kind === k)), rows.map((r) => r.kind).join(','));
check('activity is newest first', rows.every((r, i) => i === 0 || rows[i - 1].at.created >= r.at.created));
const page = await activity(A.id, { limit: 2 });
check('activity pages', page.rows.length === 2 && page.nextBefore > 0);
const onlyAsset = await activity(A.id, { key: assetId, kind: 'burn' });
check('activity filters by asset and kind', onlyAsset.rows.length === 1 && onlyAsset.rows[0].kind === 'burn');
check('nothing is left in progress', Object.values((await status(A.id)).pending).every((n) => n === 0) && Object.values((await status(B.id)).pending).every((n) => n === 0), JSON.stringify([(await status(A.id)).pending, (await status(B.id)).pending]));
check('balances agree with the history', (await balances(A.id)).assets.find((a) => a.assetId === assetId).balance.total === '800');

done({ A: A.id, B: B.id, assetId });
