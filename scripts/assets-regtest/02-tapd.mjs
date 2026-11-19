// Interoperate with tapd, Lightning Labs' daemon: receive an asset tapd
// minted, and send an asset this app minted to an address tapd made. tapd
// verifies every proof it is handed, so a completed receive there is its own
// word that this app's transfer is valid.
import { newWallet, post, idem, mine, mempool, inMempool, rowReaches, onchain, holding, tapcli, tapdMint, tapdBalance, tapdKnows, waitFor, check, sleep, done, mintAndConfirm, status } from './lib.mjs';

const A = await newWallet('Interop');

// 1. tapd mints; the app has never seen the asset.
const name = `tapd-coin-${Date.now().toString(36)}`;
const theirs = await tapdMint({ name, amount: 5000, decimals: 2 });
const assetId = theirs.asset_genesis.asset_id;
const found = await post(A.id, '/lookup', { id: assetId });
check('an asset this wallet does not hold is found on the proof server', found.asset.assetId === assetId && found.asset.name === name, JSON.stringify(found.asset));
check('the lookup carries its decimals', found.asset.decimalDisplay === 2, String(found.asset.decimalDisplay));

// 2. Receive 1200 units from tapd.
const made = await post(A.id, '/addresses', { key: assetId, amount: '1200' });
check('an address is made for it, on regtest, with a waiting row', made.address.encoded.startsWith('taprt1') && made.row.kind === 'receive' && made.row.state === 'waiting', made.address.encoded.slice(0, 24));
const decodedByTapd = tapcli('addrs', 'decode', '--addr', made.address.encoded);
check('tapd reads the address the same way', decodedByTapd.asset_id === assetId && String(decodedByTapd.amount) === '1200', JSON.stringify({ asset_id: decodedByTapd.asset_id, amount: decodedByTapd.amount }));
tapcli('assets', 'send', '--addr', made.address.encoded, '--sat_per_vbyte', '2');
await sleep(2000);
mine(1);
const received = await rowReaches(A.id, made.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('the receive completes with its proof', received.state === 'complete' && received.assets[0].amount === '1200' && /^[0-9a-f]{64}$/.test(received.txid || ''));
check('the balance shows what tapd sent', (await onchain(A.id, assetId)) === '1200');
check('tapd holds the change', tapdBalance(assetId) === '3800', tapdBalance(assetId));

// 3. Send 700 of it back to a tapd address.
const back = tapcli('addrs', 'new', '--asset_id', assetId, '--amt', '700');
const decoded = await post(A.id, '/addresses/decode', { address: back.encoded });
check('a tapd address decodes: asset, amount, courier, not our own', decoded.assetId === assetId && decoded.amount === '700' && decoded.own === false && decoded.courier.uri === 'universerpc://tapd:10029' && decoded.courier.known === true, JSON.stringify({ amount: decoded.amount, courier: decoded.courier, own: decoded.own }));
const before = mempool().length;
const preview = await post(A.id, '/send/prepare', { address: back.encoded, feeRate: 2 }, idem());
check('the preview names the exact fee, the change and the proof server', preview.fee.sats > 0 && preview.amount === '700' && preview.change === '500' && preview.courier.reachable === true, JSON.stringify({ fee: preview.fee, change: preview.change, courier: preview.courier }));
check('a prepared send has broadcast nothing', mempool().length === before && (await status(A.id)).pending.sends === 0, JSON.stringify((await status(A.id)).pending));
const commitKey = idem();
const sent = await post(A.id, '/send/commit', { previewId: preview.previewId }, commitKey);
check('commit broadcasts', sent.row.kind === 'send' && inMempool(sent.row.txid), sent.row.txid);
check('the fee paid is the fee previewed', sent.row.feeSats === preview.fee.sats, `${sent.row.feeSats} vs ${preview.fee.sats}`);
const replay = await post(A.id, '/send/commit', { previewId: preview.previewId }, commitKey);
check('committing again with the same key answers the same row', replay.row.id === sent.row.id && replay.row.txid === sent.row.txid);
mine(1);
const settled = await rowReaches(A.id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
check('the send completes once its proof is delivered', settled.state === 'complete' && settled.at.proof > 0);
check('the wallet keeps the change', (await onchain(A.id, assetId)) === '500');
await waitFor('tapd completes the receive', () => {
	const events = tapcli('addrs', 'receives', '--addr', back.encoded).events || [];
	return events.some((e) => e.status === 'ADDR_EVENT_STATUS_COMPLETED');
}, { timeoutMs: 180000 });
check('tapd verified the proof and credited the transfer', tapdBalance(assetId) === '4500', tapdBalance(assetId));

// 4. An asset minted here, sent to tapd.
const mint = await mintAndConfirm(A.id, [{ name: `app-coin-${Date.now().toString(36)}`, type: 'normal', amount: '90000', decimalDisplay: 3 }]);
const ours = mint.assets[0].assetId;
await waitFor('tapd knows the asset from the universe', () => tapdKnows(ours));
const addr = tapcli('addrs', 'new', '--asset_id', ours, '--amt', '12345');
const p2 = await post(A.id, '/send/prepare', { address: addr.encoded, feeRate: 2 }, idem());
const s2 = await post(A.id, '/send/commit', { previewId: p2.previewId }, idem());
mine(1);
await rowReaches(A.id, s2.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await waitFor('tapd completes the receive of the app asset', () => (tapcli('addrs', 'receives', '--addr', addr.encoded).events || []).some((e) => e.status === 'ADDR_EVENT_STATUS_COMPLETED'), { timeoutMs: 180000 });
check('tapd holds the asset this app minted and sent', tapdBalance(ours) === '12345', tapdBalance(ours));
const left = await holding(A.id, ours);
check('the wallet holds the rest', left.balance.onchain === '77655', JSON.stringify(left.balance));

done({ A: A.id, assetId, ours });
