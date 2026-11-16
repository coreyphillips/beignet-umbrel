// The controls around the flows: sending a transaction to the network again,
// testing and changing the proof server, and switching assets off for one
// wallet without disturbing the wallet.
import { newWallet, api, w, post, idem, mine, mempool, inMempool, rowReaches, onchain, status, healthy, assetsReady, refusal, waitFor, check, done, mintAndConfirm } from './lib.mjs';

const A = await newWallet('Settings A');
const B = await newWallet('Settings B');
const mint = await mintAndConfirm(A.id, [{ name: `set-${Date.now().toString(36)}`, type: 'normal', amount: '100' }]);
const assetId = mint.assets[0].assetId;

// Broadcast again: the same transaction, never a second one.
const addr = await post(B.id, '/addresses', { key: assetId, amount: '10' });
const p = await post(A.id, '/send/prepare', { address: addr.address.encoded, feeRate: 2 }, idem());
const notYet = await refusal(() => post(A.id, '/transfers/rebroadcast', { id: `send-${p.previewId}` }));
check('there is nothing to send again before a send is confirmed', !!notYet && notYet.status >= 400, notYet ? notYet.code : 'accepted');
const before = mempool().length;
const sent = await post(A.id, '/send/commit', { previewId: p.previewId }, idem());
const again = await post(A.id, '/transfers/rebroadcast', { id: sent.row.id });
check('broadcast again answers the same row and transaction', again.row.id === sent.row.id && again.row.txid === sent.row.txid);
check('and the mempool holds it once', mempool().length === before + 1 && inMempool(sent.row.txid));
const mintAgain = await post(A.id, '/transfers/rebroadcast', { id: mint.id }).catch((e) => e);
check('a confirmed mint can be sent again harmlessly, or says there is no need', !!mintAgain && (mintAgain.row ? mintAgain.row.id === mint.id : mintAgain.status >= 400));
mine(1);
await rowReaches(A.id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
await rowReaches(B.id, addr.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });

// The proof server: test one, then change it.
const config = await api('/config');
const regtest = config.universeServers.find((u) => u.networks.includes('regtest'));
check('the app lists the regtest proof server', !!regtest && /^universerpc:\/\//.test(regtest.courier) && /^https:\/\//.test(regtest.rest), JSON.stringify(regtest));
const ok = await post(A.id, '/proof-server/test', { rest: regtest.rest });
check('a proof server that answers tests as reachable', ok.reachable === true && ok.error === null, JSON.stringify(ok));
const dead = await post(A.id, '/proof-server/test', { rest: 'https://127.0.0.1:9' });
check('one that does not answer says so, without throwing', dead.reachable === false && typeof dead.error === 'string' && dead.error.length > 0, JSON.stringify(dead));

const bad = await refusal(() => api(`/wallets/${A.id}`, { method: 'PATCH', body: { assets: { universe: { courier: 'http://nope', rest: regtest.rest } } } }));
check('a courier address that is not one is refused before anything changes', !!bad && bad.code === 'BAD_UNIVERSE', bad ? bad.code : 'accepted');
check('and the wallet still uses the default', (await status(A.id)).proofServer.isDefault === true);

// A second name for the same server: new addresses name the wallet's own.
const own = { courier: 'universerpc://localhost:10129', rest: regtest.rest };
await api(`/wallets/${A.id}`, { method: 'PATCH', body: { assets: { universe: own } } });
await api(`/wallets/${A.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
await waitFor('wallet stopped', async () => (await api(`/wallets/${A.id}`)).status === 'stopped');
await api(`/wallets/${A.id}/start`, { method: 'POST', body: {} });
await healthy(A.id);
await assetsReady(A.id);
const s = await status(A.id);
check("the wallet's own proof server is the one it uses", s.proofServer.courier === own.courier && s.proofServer.isDefault === false && s.proofServer.reachable === true, JSON.stringify(s.proofServer));
check('the record says so', (await api(`/wallets/${A.id}`)).assets.universe.courier === own.courier);
const mine2 = await post(A.id, '/addresses', { key: assetId, amount: '5' });
const dec = await post(B.id, '/addresses/decode', { address: mine2.address.encoded });
check('new addresses name it', dec.courier.uri === own.courier, JSON.stringify(dec.courier));
check('an address naming the default server can still be paid', (await post(A.id, '/addresses/decode', { address: addr.address.encoded })).courier.known === true);
// Clearing it goes back to the default.
await api(`/wallets/${A.id}`, { method: 'PATCH', body: { assets: { universe: null } } });
check('clearing it returns to the default', (await api(`/wallets/${A.id}`)).assets.universe === null);

// Assets off for one wallet: the daemon is not told about the host at all.
await api(`/wallets/${B.id}`, { method: 'PATCH', body: { assets: { enabled: false } } });
await api(`/wallets/${B.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
await waitFor('wallet stopped', async () => (await api(`/wallets/${B.id}`)).status === 'stopped');
await api(`/wallets/${B.id}/start`, { method: 'POST', body: {} });
await healthy(B.id);
const off = await refusal(() => status(B.id));
check('with assets off the routes are not there', !!off && off.status === 404, off ? `${off.status} ${off.code}` : 'answered');
check('and the bitcoin wallet runs as before', (await w(B.id, '/balance')).onchain > 0 && (await api(`/wallets/${B.id}`)).healthy === true);
check('the record still remembers that it holds assets', (await api(`/wallets/${B.id}`)).assets.holdsAssets === true && (await api(`/wallets/${B.id}`)).assets.enabled === false, JSON.stringify((await api(`/wallets/${B.id}`)).assets));
// Back on: what it held is still there.
await api(`/wallets/${B.id}`, { method: 'PATCH', body: { assets: { enabled: true } } });
await api(`/wallets/${B.id}/stop`, { method: 'POST', body: {} }).catch(() => {});
await waitFor('wallet stopped', async () => (await api(`/wallets/${B.id}`)).status === 'stopped');
await api(`/wallets/${B.id}/start`, { method: 'POST', body: {} });
await healthy(B.id);
await assetsReady(B.id);
check('switched back on, its assets are where they were', (await onchain(B.id, assetId)) === '10', await onchain(B.id, assetId));

done({ A: A.id, B: B.id, assetId });
