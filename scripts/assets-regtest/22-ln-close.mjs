// Closing an asset channel together: each side's share comes back on-chain
// with proofs that tapd, checking them itself, accepts.
import { post, refusal, check, done, status, waitFor } from './lib.mjs';
import { pair, openAssetChannel, payAsset, channelOf, channelOver, split, conserved, handToTapd, liveChannels, bothSides, noteBitcoin, CLOSING_TOGETHER } from './ln-lib.mjs';

const { A, B, assetId, key, minted } = await pair('LN closer', 'LN closed');
const { mine: chanA, theirs: chanB } = await openAssetChannel(A.id, B.id, key, '40000');
await payAsset(A.id, B.id, key, '12500');

await bothSides(A.id, B.id, chanA, chanB);
const btcBefore = await noteBitcoin('before the close', { opener: A.id, acceptor: B.id });

const none = await refusal(() => post(A.id, '/channels/close', { channelId: 'f'.repeat(64), force: false }));
check('a channel this wallet does not have cannot be closed', !!none && none.code === 'CHANNEL_NOT_FOUND' && none.status === 404, none ? `${none.code} ${none.status}` : 'accepted');

const closing = await post(A.id, '/channels/close', { channelId: chanA.channelId, force: false });
check('the close answers that it is on its way, and not by force', closing.channelId === chanA.channelId && closing.closing === true && closing.force === false, JSON.stringify(closing));
const during = await waitFor('the channel reads closing', async () => {
	const c = await channelOf(A.id, chanA.channelId);
	return c && c.state !== 'NORMAL' ? c : null;
});
check('until the assets are back it reads as closing, in one of the words for that, and cannot be paid through', CLOSING_TOGETHER.has(during.state) && during.sendable === '0' && during.receivable === '0', JSON.stringify(during));
const refused = await refusal(() => post(B.id, '/invoices/quote', { key, amount: '10' }));
check('a closing channel takes no new invoice', !!refused && refused.code === 'INSUFFICIENT_INBOUND', refused ? refused.code : 'accepted');

const overA = await channelOver(A.id, chanA.channelId);
const overB = await channelOver(B.id, chanB.channelId);
check('both sides read it closed', overA.state === 'CLOSED' && overB.state === 'CLOSED', `${overA.state} / ${overB.state}`);
const a = await split(A.id, key);
const b = await split(B.id, key);
check('each has its share on-chain and nothing in a channel', a.onchain === '87500' && a.channel === '0' && b.onchain === '12500' && b.channel === '0', JSON.stringify([a, b]));
await conserved('after the close', [A.id, B.id], key, minted);
check('neither counts a live channel', (await liveChannels(A.id)).length === 0 && (await liveChannels(B.id)).length === 0 && (await status(A.id)).lightning.usableChannels === 0);
const btcAfter = await noteBitcoin('after the close', { opener: A.id, acceptor: B.id });
// Where the channel's bitcoin went: back to each wallet, but for the 1,000
// sat that stay on the output its share of the asset came home to, and the
// fee of the close, which the opener pays.
const closeFee = btcBefore.opener.sum - btcAfter.opener.sum;
check('no bitcoin is left in a channel, and each side has 1,000 sat more with its assets', [btcAfter.opener, btcAfter.acceptor].every((b) => b.inChannels === 0 && b.closing === 0) && btcAfter.opener.locked === btcBefore.opener.locked + 1000 && btcAfter.acceptor.locked === btcBefore.acceptor.locked + 1000, JSON.stringify(btcAfter));
check("the rest of each side's channel bitcoin is its own to spend again, the opener's less the fee of the close", btcAfter.acceptor.spendable === btcBefore.acceptor.spendable + btcBefore.acceptor.inChannels - 1000 && btcAfter.opener.spendable === btcBefore.opener.spendable + btcBefore.opener.inChannels - 1000 - closeFee && closeFee > 0 && closeFee < 2000, `fee ${closeFee}`);

// tapd's word on what came out.
await handToTapd(B.id, assetId, '12500', "the acceptor's share");
await handToTapd(A.id, assetId, '27500', "what the opener got back from the channel, with its change");
await conserved('after handing 40,000 to tapd', [A.id, B.id], key, minted, 40000n);
await noteBitcoin('after the units from the channel were sent on', { opener: A.id, acceptor: B.id });

done({ A: A.id, B: B.id, assetId, key });
