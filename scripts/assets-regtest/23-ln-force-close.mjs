// Closing an asset channel alone, with the peer away: the commitment goes
// on-chain, the delay runs, the sweeps bring each side's share home, and
// tapd accepts the proofs of what was swept.
import { api, post, check, done, status, waitFor, mine } from './lib.mjs';
import { pair, openAssetChannel, payAsset, channelOf, channelOver, split, conserved, handToTapd, liveChannels } from './ln-lib.mjs';

const { A, B, assetId, key, minted } = await pair('LN forcer', 'LN away');
const { mine: chanA, theirs: chanB } = await openAssetChannel(A.id, B.id, key, '40000');
await payAsset(A.id, B.id, key, '9000');

// The peer goes away, so there is nobody to close with.
await api(`/wallets/${B.id}/stop`, { method: 'POST', body: {} });
await waitFor('the peer is stopped', async () => (await api(`/wallets/${B.id}`)).status === 'stopped');

const closing = await post(A.id, '/channels/close', { channelId: chanA.channelId, force: true });
check('the force close answers that it is on its way', closing.channelId === chanA.channelId && closing.closing === true && closing.force === true, JSON.stringify(closing));
const during = await waitFor('the channel reads force closing', async () => {
	const c = await channelOf(A.id, chanA.channelId);
	return c && c.state === 'FORCE_CLOSING' ? c : null;
});
check('it reads force closing while its assets wait out the delay', during.sendable === '0' && during.receivable === '0', JSON.stringify(during));
mine(1);
const waiting = await split(A.id, key);
check('its share is neither spendable on-chain nor lost while it waits', waiting.onchain === '60000', JSON.stringify(waiting));

// The delay, then the sweep.
const overA = await channelOver(A.id, chanA.channelId, { blocksEach: 12, timeoutMs: 600000 });
check('after the delay the opener has swept its share', overA.state === 'FORCE_CLOSED' || overA.state === 'CLOSED', overA.state);
const a = await split(A.id, key);
check('the opener has its 31,000 back beside the 60,000 it kept', a.onchain === '91000' && a.channel === '0', JSON.stringify(a));

// The peer comes back to a channel that closed without it.
await api(`/wallets/${B.id}/start`, { method: 'POST', body: {} });
const overB = await channelOver(B.id, chanB.channelId, { blocksEach: 2, timeoutMs: 600000 });
check('the peer that was away finds the close and takes its share', overB.state === 'FORCE_CLOSED' || overB.state === 'CLOSED', overB.state);
const b = await split(B.id, key);
check('the acceptor has its 9,000 on-chain', b.onchain === '9000' && b.channel === '0', JSON.stringify(b));
await conserved('after the force close', [A.id, B.id], key, minted);
check('neither counts a live channel', (await liveChannels(A.id)).length === 0 && (await liveChannels(B.id)).length === 0 && (await status(B.id)).lightning.usableChannels === 0);

await handToTapd(B.id, assetId, '9000', "the acceptor's swept share");
await handToTapd(A.id, assetId, '31000', "the opener's swept share");
await conserved('after handing 40,000 to tapd', [A.id, B.id], key, minted, 40000n);

done({ A: A.id, B: B.id, assetId, key });
