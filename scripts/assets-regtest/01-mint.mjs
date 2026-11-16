// Create assets: a normal asset with decimals, a collectible, and a grouped
// asset that is then minted again. Each issuance is published to the stack's
// tapd, which verifies a proof before it stores it, so a root there is tapd's
// own word that the mint is valid.
import { newWallet, status, post, x, idem, mine, inMempool, rowReaches, holding, balances, tapdKnows, waitFor, refusal, check, log, done } from './lib.mjs';

const A = await newWallet('Mint');
const s = await status(A.id);
check('status is ready on regtest', s.ready && s.network === 'regtest' && s.hrp === 'taprt', JSON.stringify({ phase: s.phase, network: s.network, hrp: s.hrp }));
check('one confirmation on regtest', s.chain.minConfirmations === 1, JSON.stringify(s.chain));
check("the host read the chain off the Electrum server's block 0", s.chain.name === 'regtest', JSON.stringify(s.chain));
check('the proof server is the stack tapd and is reachable', s.proofServer.reachable === true && /tapd:10029/.test(s.proofServer.courier), JSON.stringify(s.proofServer));
check('lightning is off in this milestone', s.lightning.mode === 'off');
check('nothing held yet', s.holdsAssets === false && (await balances(A.id)).assets.length === 0);

const quote = await post(A.id, '/mint/quote', { count: 1, feeRate: 2 });
check('a mint quote names a fee, the anchor and what the wallet can spend', quote.feeSats > 0 && quote.anchorSats > 0 && quote.totalSats === quote.feeSats + quote.anchorSats && quote.sufficient === true, JSON.stringify(quote));

// A normal asset with two decimals, minted once whatever the retries.
const key = idem();
const body = { seedlings: [{ name: 'ACME dollars', type: 'normal', amount: '10000000', decimalDisplay: 2, meta: { type: 'json', data: '{"issuer":"ACME"}' } }], feeRate: 2 };
const { row } = await post(A.id, '/mint', body, key);
check('mint answers a broadcast row with its transaction', row.kind === 'mint' && row.state === 'broadcast' && /^[0-9a-f]{64}$/.test(row.txid || ''), JSON.stringify({ state: row.state, txid: row.txid }));
check('the genesis transaction is in the mempool', inMempool(row.txid));
check('the fee paid is within the quote', row.feeSats > 0 && row.feeSats <= quote.feeSats * 2, `${row.feeSats} vs quoted ${quote.feeSats}`);
const again = await post(A.id, '/mint', body, key);
check('the same key answers the same row', again.row.id === row.id && again.row.txid === row.txid);
const other = await refusal(() => post(A.id, '/mint', { ...body, feeRate: 3 }, key));
check('the same key with another body is refused', !!other && other.status === 409, other ? `${other.status} ${other.code}` : 'accepted');

mine(1);
const minted = await rowReaches(A.id, row.id, 'complete', { mineEach: true });
check('the mint completes after one confirmation', minted.confirmations >= 1 && minted.at.completed > 0);
const acme = await holding(A.id, minted.assets[0].assetId);
check('the wallet holds the full supply', !!acme && acme.balance.onchain === '10000000' && acme.balance.total === '10000000', JSON.stringify(acme && acme.balance));
check('the asset keeps its name, kind and decimals', acme.name === 'ACME dollars' && acme.type === 'normal' && acme.decimalDisplay === 2 && acme.mintedHere === true);
check('bitcoin is locked in its anchor', acme.lockedSats > 0 && (await status(A.id)).lockedSats >= acme.lockedSats);
const detail = await x(A.id, `/asset?key=${acme.key}`);
check('the detail carries the metadata', !!detail.meta && /ACME/.test(detail.meta.text || ''), JSON.stringify(detail.meta));

// tapd stores an issuance only after verifying it.
await waitFor('tapd lists the issuance', () => tapdKnows(acme.assetId));
check('tapd verified and stored the issuance proof', true);

// A collectible is one indivisible unit.
const nft = await post(A.id, '/mint', { seedlings: [{ name: 'Gold ticket 1', type: 'collectible' }], feeRate: 2 }, idem());
mine(1);
const nftRow = await rowReaches(A.id, nft.row.id, 'complete', { mineEach: true });
const ticket = await holding(A.id, nftRow.assets[0].assetId);
check('a collectible is one unit', !!ticket && ticket.type === 'collectible' && ticket.balance.onchain === '1', JSON.stringify(ticket && ticket.balance));

// A grouped asset can be minted again, and both issuances are one holding.
const first = await post(A.id, '/mint', { seedlings: [{ name: 'Points', type: 'normal', amount: '500', decimalDisplay: 0, group: { mode: 'new' } }], feeRate: 2 }, idem());
mine(1);
const firstRow = await rowReaches(A.id, first.row.id, 'complete', { mineEach: true });
const points = await holding(A.id, firstRow.assets[0].key);
check('a grouped asset is keyed by its group and can be minted again', !!points && !!points.groupKey && points.key === points.groupKey && points.canReissue === true, JSON.stringify({ key: points && points.key, groupKey: points && points.groupKey }));
const more = await post(A.id, '/mint', { seedlings: [{ name: 'Points', type: 'normal', amount: '250', group: { mode: 'existing', groupKey: points.groupKey } }], feeRate: 2 }, idem());
mine(1);
await rowReaches(A.id, more.row.id, 'complete', { mineEach: true });
const grown = await holding(A.id, points.key);
check('minting more adds to the same holding', grown.balance.onchain === '750', JSON.stringify(grown.balance));

// Two assets in one transaction.
const pair = await post(A.id, '/mint', { seedlings: [{ name: 'Alpha', type: 'normal', amount: '10' }, { name: 'Beta', type: 'normal', amount: '20' }], feeRate: 2 }, idem());
check('two assets share one genesis transaction', pair.row.assets.length === 2);
mine(1);
await rowReaches(A.id, pair.row.id, 'complete', { mineEach: true });
check('all five holdings are listed', (await balances(A.id)).assets.length === 5, String((await balances(A.id)).assets.length));

// Refusals.
const tooHigh = await refusal(() => post(A.id, '/mint', { seedlings: [{ name: 'Costly', type: 'normal', amount: '1' }], feeRate: 100000 }, idem()));
check('a fee rate above the limit is refused', !!tooHigh && tooHigh.code === 'FEE_TOO_HIGH', tooHigh ? tooHigh.code : 'accepted');
const capped = await refusal(() => post(A.id, '/mint', { seedlings: [{ name: 'Capped', type: 'normal', amount: '1' }], feeRate: 2, maxFeeSats: 1 }, idem()));
check('a fee above what the request allows is refused', !!capped && capped.code === 'FEE_TOO_HIGH', capped ? capped.code : 'accepted');
const zero = await refusal(() => post(A.id, '/mint', { seedlings: [{ name: 'Zero', type: 'normal', amount: '0' }], feeRate: 2 }, idem()));
check('a zero supply is refused', !!zero && zero.code === 'BAD_AMOUNT', zero ? zero.code : 'accepted');
const poor = await newWallet('Empty', { sats: 0 });
const broke = await refusal(() => post(poor.id, '/mint', { seedlings: [{ name: 'Unfunded', type: 'normal', amount: '1' }], feeRate: 2 }, idem()));
check('a wallet with no bitcoin cannot mint, and is told what it needs', !!broke && broke.code === 'INSUFFICIENT_BTC' && broke.details && broke.details.needed > 0, broke ? `${broke.code} ${JSON.stringify(broke.details)}` : 'accepted');
check('nothing is left in progress after the refusals', (await status(A.id)).pending.mints === 0, JSON.stringify((await status(A.id)).pending));

log('wallet', A.id);
done({ A: A.id, acme: acme.assetId, points: points.key });
