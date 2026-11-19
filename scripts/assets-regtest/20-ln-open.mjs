// An asset channel between two wallets of this app: what opening costs, the
// refusals before anything is funded, one open however often it is asked
// for, and what each side then says it can send and receive.
import { api, post, idem, mempool, status, refusal, check, done, onchain, healthy } from './lib.mjs';
import { pair, peerOf, openAssetChannel, channels, split, conserved, engineChannels, restart } from './ln-lib.mjs';

const { A, B, assetId, key, minted } = await pair('LN opener', 'LN acceptor');

check('both wallets have asset Lightning on', (await status(A.id)).lightning.mode === 'full' && (await status(B.id)).lightning.mode === 'full', JSON.stringify([(await status(A.id)).lightning, (await status(B.id)).lightning]));
check('and no asset channel yet', (await channels(A.id)).length === 0 && (await status(A.id)).lightning.usableChannels === 0);

// What it costs, before anything is asked of the peer.
const quote = await post(A.id, '/channels/quote', { key, amount: '40000', feeRate: 2 });
check('the quote names the bitcoin that goes in, the fee and the total', quote.channelSats === 100000 && quote.feeSats > 0 && quote.totalSats === quote.channelSats + quote.feeSats && quote.sufficient === true, JSON.stringify(quote));
check('and the part that starts on the peer side, small beside the channel', quote.pushSats > 354 && quote.pushSats < 5000, String(quote.pushSats));

// Refusals, each before anything is funded or written.
const before = mempool().length;
const peer = await peerOf(B.id);
const tooMuch = await refusal(() => post(A.id, '/channels/open', { peer, key, amount: '100001', feeRate: 2 }, idem()));
check('more than the wallet holds on-chain is refused', !!tooMuch && tooMuch.code === 'INSUFFICIENT_ASSET_BALANCE', tooMuch ? tooMuch.code : 'accepted');
const unknown = await refusal(() => post(A.id, '/channels/open', { peer, key: 'f'.repeat(64), amount: '10', feeRate: 2 }, idem()));
check('an asset the wallet does not hold is refused', !!unknown && unknown.code === 'ASSET_NOT_FOUND', unknown ? unknown.code : 'accepted');
const badPeer = await refusal(() => post(A.id, '/channels/open', { peer: { pubkey: 'nope', host: peer.host, port: peer.port }, key, amount: '10', feeRate: 2 }, idem()));
check('a peer with no node key is refused', !!badPeer && badPeer.code === 'INVALID_PARAMS', badPeer ? badPeer.code : 'accepted');
const zero = await refusal(() => post(A.id, '/channels/open', { peer, key, amount: '0', feeRate: 2 }, idem()));
check('an amount of nothing is refused', !!zero && zero.code === 'BAD_AMOUNT', zero ? zero.code : 'accepted');

// A wallet with assets off speaks Lightning and takes no asset channels.
// Assets are a setting of the wallet's record (PATCH), read when its daemon
// starts: a new wallet has them on, so this one is made, switched and restarted.
const { record: plain } = await api('/wallets', { method: 'POST', body: { name: 'LN plain', network: 'regtest' } });
await healthy(plain.id);
await api(`/wallets/${plain.id}`, { method: 'PATCH', body: { assets: { enabled: false } } });
await restart(plain.id, { assets: false });
const plainOff = await refusal(() => status(plain.id));
check('the plain wallet has no assets routes', !!plainOff && plainOff.status === 404, plainOff ? String(plainOff.status) : 'answered');
const noAssets = await refusal(() => peerOf(plain.id).then((p) => post(A.id, '/channels/open', { peer: p, key, amount: '10', feeRate: 2 }, idem())));
check('a peer that does not take asset channels is refused, by name', !!noAssets && noAssets.code === 'PEER_NO_ASSET_CHANNELS', noAssets ? `${noAssets.code}: ${noAssets.message}` : 'accepted');
check('no refusal broadcast anything or left a channel behind', mempool().length === before && (await channels(A.id)).length === 0 && (await onchain(A.id, assetId)) === minted, JSON.stringify(await channels(A.id)));
check('and nothing is held back for them', (await status(A.id)).pending && Object.values((await status(A.id)).pending).every((n) => n === 0), JSON.stringify((await status(A.id)).pending));

// The open, asked for twice with one key.
const requestKey = idem();
const opening = openAssetChannel(A.id, B.id, key, '40000', { key: requestKey });
const { opened, body, mine: mineView, theirs } = await opening;
check('the open answers with an id and that it is funding', /^[0-9a-f]{16,64}$/.test(opened.pendingChannelId) && opened.phase === 'funding', JSON.stringify(opened));
const again = await post(A.id, '/channels/open', body, requestKey);
check('the same request asked again answers the same and opens nothing more', again.pendingChannelId === opened.pendingChannelId && (await channels(A.id)).length === 1, JSON.stringify(again));

check('the opener holds all of it at first', mineView.capacity === '40000' && mineView.localBalance === '40000' && mineView.remoteBalance === '0' && mineView.receivable === '0' && BigInt(mineView.sendable) > 0n && BigInt(mineView.sendable) <= 40000n, JSON.stringify(mineView));
check('the acceptor sees the same channel from its side', theirs.capacity === '40000' && theirs.localBalance === '0' && theirs.remoteBalance === '40000' && theirs.sendable === '0' && theirs.receivable === '40000', JSON.stringify(theirs));
check('each names the other, the asset and the bitcoin in the channel', mineView.peerPubkey === peer.pubkey && theirs.peerPubkey === (await peerOf(A.id)).pubkey && mineView.asset.key === key && theirs.asset.assetId === assetId && mineView.channelSats === 100000 && theirs.channelSats === 100000);

const a = await split(A.id, key);
const b = await split(B.id, key);
check('the opener has 60,000 on-chain and 40,000 in the channel', a.onchain === '60000' && a.channel === '40000' && a.receivable === '0', JSON.stringify(a));
check('the acceptor lists the asset with nothing of its own yet, and room to receive', b.onchain === '0' && b.channel === '0' && b.receivable === '40000', JSON.stringify(b));
await conserved('after the open', [A.id, B.id], key, minted);
check('both count one usable channel', (await status(A.id)).lightning.usableChannels === 1 && (await status(B.id)).lightning.usableChannels === 1);

// The engine marks it, so the bitcoin screens can leave it out.
const engine = await engineChannels(A.id);
check('the engine lists the channel as one that carries an asset', Array.isArray(engine) && engine.length === 1 && engine[0].auxiliary === true, JSON.stringify(engine.map((c) => ({ state: c.state, auxiliary: c.auxiliary }))));

done({ A: A.id, B: B.id, assetId, key, channelId: mineView.channelId });
