/**
 * Taproot Assets over Lightning, the parts that are judgement and wording
 * and not drawing (docs/ASSETS.md): whether a wallet is offered asset
 * channels at all, what a channel's state is called, how a peer is read from
 * what was typed, when a quoted price has run out, and what each refusal
 * means in plain words.
 *
 * Nothing here asks the wallet anything. Each function is given what a page
 * already holds.
 */
import { cmpUnits, fmtAsset, isZero, toUnits } from './asset-amount.js';
import { invoiceLost } from './asset-progress.js';
import { isRefusal, lightningHeld, sentence } from './assets.js';
import { fmtSats } from './format.js';
import { assetsShown } from './wallet-assets.js';

/* ------------------------------------------------------------ the switch */

/**
 * Whether anything about asset channels is shown for this wallet.
 *
 * Three things have to be true: the app's engine can carry them, the wallet
 * has Lightning at all, and its assets host says its Lightning side is on.
 * The host's word is waited for: until its status has arrived nothing is
 * shown, so a wallet that turns out to have none never flashes a card it
 * cannot use.
 */
export function assetChannelsOffered({ config, rec, status } = {}) {
	if (!config || !config.assetChannelsAvailable) return false;
	if (!assetsShown(config, rec)) return false;
	if (rec && rec.onchainOnly) return false;
	const mode = status && status.lightning && status.lightning.mode;
	// Off for a reason the host gives (a node that does not offer asset
	// channels) is still shown: the channels there are can be closed, and
	// everything else is held with that reason and not hidden.
	return (typeof mode === 'string' && mode !== 'off') || !!lightningHeld(status);
}

/* --------------------------------------------------------------- channels */

const OPENING = new Set(['OPENING', 'PENDING_OPEN', 'AWAITING_FUNDING_CONFIRMED', 'AWAITING_CHANNEL_READY']);
const CLOSING = new Set(['CLOSING', 'SHUTTING_DOWN', 'NEGOTIATING_CLOSING', 'FORCE_CLOSING']);

/**
 * A channel's state as a badge: the word, its colour, and whether the
 * channel can carry a payment now. A state this page has not met is shown
 * in the wallet's own word, lower case, and never as usable.
 */
export function channelState(state) {
	const s = String(state || '').toUpperCase();
	if (s === 'NORMAL') return { word: 'open', tone: 'green', usable: true };
	if (OPENING.has(s)) return { word: 'opening', tone: 'yellow', usable: false };
	if (CLOSING.has(s)) return { word: 'closing', tone: 'yellow', usable: false };
	if (s === 'AWAITING_REESTABLISH') return { word: 'reconnecting', tone: 'yellow', usable: false };
	if (s === 'FORCE_CLOSED') return { word: 'force closed', tone: 'red', usable: false };
	if (s === 'CLOSED') return { word: 'closed', tone: 'muted', usable: false };
	// An open that came to nothing after the wallet had taken it on. No
	// channel: the row says why (`failure`), and there is nothing to close.
	if (s === 'FAILED') return { word: 'not opened', tone: 'red', usable: false };
	// A channel the wallet's node gave up. It is still the wallet's, carries
	// nothing, and is closed only without its peer.
	if (s === 'ERRORED') return { word: 'failed', tone: 'red', usable: false };
	// On the wallet's record and not held by its node: what a restore from a
	// backup leaves. It carries nothing and cannot be closed from here.
	if (s === 'MISSING') return { word: 'not held here', tone: 'red', usable: false };
	return { word: s ? s.toLowerCase().replace(/_/g, ' ') : 'unknown', tone: 'muted', usable: false };
}

/** Whether a close can still be asked for: not for one already on its way out. */
export function canClose(channel) {
	const s = String((channel && channel.state) || '').toUpperCase();
	return !CLOSING.has(s) && s !== 'CLOSED' && s !== 'FORCE_CLOSED' && s !== 'MISSING' && s !== 'FAILED';
}

const NOT_LIVE = new Set(['CLOSED', 'FORCE_CLOSED', 'FAILED', 'MISSING']);

/**
 * Whether the wallet says the channel's peer is away (`peerConnected` is a
 * plain false), for a channel that is live and not on its way out. Such a
 * channel keeps the word it would have with the peer there, and carries
 * nothing until the peer is back.
 */
export function peerAway(channel) {
	const s = String((channel && channel.state) || '').toUpperCase();
	return !!channel && channel.peerConnected === false && !NOT_LIVE.has(s) && !CLOSING.has(s);
}

/**
 * How a channel can be closed: { cooperative, peerAway, force }. A channel
 * that failed is closed only without its peer. Any other may be closed with
 * it, which the wallet refuses while the peer is away: `peerAway` says so
 * before it is tried. An open has no force close: its funding transaction
 * is on no chain, so there is nothing on chain to close, and the wallet
 * refuses one.
 */
export function closeWays(channel) {
	const s = String((channel && channel.state) || '').toUpperCase();
	const failed = s === 'ERRORED';
	return { cooperative: !failed, peerAway: !failed && peerAway(channel), force: s !== 'OPENING' };
}

/**
 * Whether the funding of this channel can be taken back: an open this
 * wallet funded, whose funding transaction is made and has not confirmed.
 * The wallet says so on the row, and it is not worked out here.
 */
export const canReclaim = (channel) => !!channel && channel.reclaimable === true;

/** Whether a transaction that takes the funding back has already been sent. */
export const reclaimSent = (channel) => !!channel && typeof channel.reclaimTxid === 'string' && channel.reclaimTxid !== '';

/**
 * How much of a channel is on this wallet's side, as a percentage with one
 * decimal place. Worked out in whole units: an asset's balance can run past
 * what a JS number holds exactly, and a bar drawn from a rounded figure
 * would be a picture of a different channel.
 */
export function sharePct(local, remote) {
	const l = toUnits(local) ?? 0n;
	const r = toUnits(remote) ?? 0n;
	const total = l + r;
	if (total === 0n) return 0;
	return Number((l * 1000n) / total) / 10;
}

/** "Lightning Labs edge", or the short form of the key when the peer has no name. */
export function peerName(channel) {
	const alias = channel && typeof channel.peerAlias === 'string' ? channel.peerAlias.trim() : '';
	if (alias) return alias;
	const key = String((channel && channel.peerPubkey) || '');
	return key ? `${key.slice(0, 8)}…${key.slice(-6)}` : 'an unnamed peer';
}

/* ----------------------------------------------------- which assets where */

/** The assets a channel can be opened with: counted ones, with some on-chain. */
export function channelAssets(holdings) {
	return (holdings || []).filter((a) => a && a.type !== 'collectible' && !isZero(a.balance && a.balance.onchain));
}

/** The assets an invoice can be paid with: those a channel can send now. */
export function payableAssets(holdings) {
	return (holdings || []).filter((a) => a && a.type !== 'collectible' && !isZero(a.balance && a.balance.lightningSendable));
}

/* ------------------------------------------------------------------ peers */

const PUBKEY = /^0[23][0-9a-f]{64}$/;

/**
 * A peer, read from what was typed: a node public key, alone or followed by
 * @host or @host:port.
 *
 * Returns { ok: true, peer: { pubkey, host, port } } with host and port null
 * when only the key was given, or { ok: false, reason } with the reason in
 * words, null while the box is empty and there is nothing to refuse yet.
 */
export function parsePeer(text) {
	const t = String(text || '').trim();
	if (t === '') return { ok: false, reason: null };
	const at = t.indexOf('@');
	const key = (at === -1 ? t : t.slice(0, at)).toLowerCase();
	if (!/^[0-9a-f]+$/.test(key)) {
		return { ok: false, reason: 'A peer starts with its node public key: 66 characters of 0 to 9 and a to f.' };
	}
	if (key.length !== 66) {
		return { ok: false, reason: `A node public key is 66 characters, and this is ${key.length}.` };
	}
	if (!PUBKEY.test(key)) return { ok: false, reason: 'A node public key starts with 02 or 03.' };
	if (at === -1) return { ok: true, peer: { pubkey: key, host: null, port: null } };

	const where = t.slice(at + 1);
	// An IPv6 address is written in brackets, so its own colons are not taken
	// for the one before the port.
	const m = /^(\[[0-9a-f:.]+\]|[^\s:@\[\]]+)(?::(\d+))?$/i.exec(where);
	if (!m) return { ok: false, reason: 'After the @ comes where the node listens, as host:port.' };
	const port = m[2] === undefined ? 9735 : Number(m[2]);
	if (!(port >= 1 && port <= 65535)) return { ok: false, reason: 'A port is a number from 1 to 65535.' };
	return { ok: true, peer: { pubkey: key, host: m[1], port } };
}

/* ----------------------------------------------------------------- prices */

/** Milliseconds a quoted price has left, never below zero. No expiry means none left. */
export function quoteLeft(quote, now = Date.now()) {
	const until = Number(quote && quote.expiresAt);
	if (!Number.isFinite(until)) return 0;
	return Math.max(0, until - now);
}

export const quoteExpired = (quote, now = Date.now()) => quoteLeft(quote, now) === 0;

/**
 * Whether a quote carries a bitcoin price. A peer that is another wallet
 * sets none (`priced: false`): the sats on such an invoice are its face and
 * nothing else, so the page shows no worth and no rate for it.
 */
export const quotePriced = (quote) => !(quote && quote.priced === false);

/** "Pay 12.50 BUSD": the button says the amount it will pay. */
export function payLabel(quote, asset) {
	if (!quote || !asset) return 'Pay';
	return `Pay ${fmtAsset(quote.assetAmount, asset)}`;
}

/**
 * What changed between the price the reader saw and the one the wallet came
 * back with. Nothing was paid in between, and the sentence says so: the page
 * then asks again with the new figure on the button.
 *
 * Returns { direction: 'more' | 'less' | 'same', text }.
 */
export function quoteChange(before, after, asset) {
	const was = fmtAsset(before && before.assetAmount, asset);
	const now = fmtAsset(after && after.assetAmount, asset);
	const c = cmpUnits(after && after.assetAmount, before && before.assetAmount);
	if (c > 0) {
		return {
			direction: 'more',
			text: `The price moved before the payment was made, so nothing was paid. It is now ${now}, up from ${was}. Press Pay again only if the new amount is right.`
		};
	}
	if (c < 0) {
		return {
			direction: 'less',
			text: `The price moved before the payment was made, so nothing was paid. It is now ${now}, down from ${was}. Press Pay again to pay the new amount.`
		};
	}
	if (!quotePriced(after)) {
		return {
			direction: 'same',
			text: `The time your peer held this for ran out before the payment was made, so nothing was paid. It has been asked again, and the amount is still ${now}. Press Pay again to pay it.`
		};
	}
	return {
		direction: 'same',
		text: `The price ran out before the payment was made, so nothing was paid. A new one has been given, and it is still ${now}. Press Pay again to pay it.`
	};
}

/**
 * When an invoice made here stops being payable: the earlier of its own
 * expiry and the end of the price it was made at. Past the price's end the
 * peer no longer makes the exchange, so the payment would be turned away
 * even while the invoice itself still reads as valid.
 */
export function invoiceDeadline(invoice) {
	const ends = [Number(invoice && invoice.expiresAt), Number(invoice && invoice.invoiceExpiresAt)].filter(
		(n) => Number.isFinite(n) && n > 0
	);
	return ends.length ? Math.min(...ends) : null;
}

const PAID = new Set(['PAID', 'SETTLED', 'COMPLETE', 'COMPLETED']);

/**
 * Where an invoice made here stands: 'paid', 'lost', 'failed', 'expired'
 * or 'waiting'. Paid is the activity row saying complete, or the invoice
 * list saying so, whichever is heard first; it is never guessed from the
 * clock. Lost is a paid invoice whose payment the peer took back on the
 * chain, so nothing was received: the row saying so (INVOICE_LOST), or
 * the list (LOST). The row, which the wallet sends as it changes, is
 * believed before the list, which is asked only while the row is not paid.
 */
export function invoiceStanding({ invoice, row, listed, now = Date.now() } = {}) {
	if (invoiceLost(row)) return 'lost';
	if (row && row.state === 'complete') return 'paid';
	const status = String((listed && listed.status) || '').toUpperCase();
	if (status === 'LOST') return 'lost';
	if (PAID.has(status)) return 'paid';
	if (row && row.failed) return 'failed';
	const deadline = invoiceDeadline(invoice);
	if (deadline !== null && now >= deadline) return 'expired';
	return 'waiting';
}

/**
 * What a paid invoice asked for and what it brought in, where the two
 * differ: { asked, received, text }, with the text "asked for 250.00 BUSD,
 * received 249.99 BUSD". A payer's price can leave a payment up to a unit
 * under what the invoice names for each part it arrives in, and the invoice
 * is paid all the same. Null where they agree, and for an invoice that is
 * not paid yet (`receivedAmount` is null until it is).
 */
export function invoiceShortfall(invoice, asset) {
	if (!invoice) return null;
	const got = invoice.receivedAmount;
	if (got === null || got === undefined || got === '' || toUnits(got) === null) return null;
	if (toUnits(invoice.assetAmount) === null || cmpUnits(got, invoice.assetAmount) === 0) return null;
	const of = asset || invoice.asset;
	return { asked: String(invoice.assetAmount), received: String(got), text: `asked for ${fmtAsset(invoice.assetAmount, of)}, received ${fmtAsset(got, of)}` };
}

/* --------------------------------------------------------------- refusals */

const units = (value, asset) => (asset ? fmtAsset(value, asset) : `${String(value)} units`);

/**
 * A Lightning refusal in plain words: { code, text }.
 *
 * Each code the assets host answers with has a sentence that says what is
 * in the way and what would clear it. A refusal with no sentence of its own
 * is said in the wallet's words, and an answer that never came is said to be
 * that. A bare code is never what the reader is shown.
 */
/**
 * Whether the wallet has no bitcoin to pay the miner fee of an on-chain
 * claim with, by the host's `status.lightning.feeCoins`: the node could not
 * prepare a fee coin now, for want of a confirmed coin and not because its
 * fee budget is used up. A wallet in that state should keep `neededSats`
 * on-chain beside whatever a channel takes.
 */
export function feeCoinsShort(feeCoins) {
	return !!feeCoins && feeCoins.possible === false && feeCoins.reason === 'FEE_FUNDS_UNAVAILABLE' && /^\d+$/.test(String(feeCoins.neededSats ?? ''));
}

/**
 * The most of an asset that can go into one new channel. A channel is
 * funded with units of one issuance, so for an asset this wallet holds
 * several issuances of it is what it holds on-chain of the largest one
 * (`balance.channelable`), and for any other asset all it holds on-chain.
 */
export function channelableOf(asset) {
	const whole = (value) => typeof value === 'string' && /^\d+$/.test(value);
	const onchain = whole(asset?.balance?.onchain) ? asset.balance.onchain : '0';
	const one = asset?.balance?.channelable;
	return whole(one) && BigInt(one) < BigInt(onchain) ? one : onchain;
}

export function lightningRefusal(error, { asset } = {}) {
	if (!error) return null;
	const code = error.code || '';
	const details = error.details || {};
	const name = asset && asset.name ? asset.name : 'this asset';
	switch (code) {
		case 'CHANNEL_ASSETS': {
			// One issuance a channel. The host counts in units; here it is the asset's own figure.
			if (details.largest === undefined || details.largest === null || !Number.isInteger(details.issuances)) return { code, text: error.message };
			return {
				code,
				text: `A channel holds units of one issuance of an asset. This wallet holds enough ${name} in all, spread over ${details.issuances} issuances, and the most it has of a single one on-chain is ${units(details.largest, asset)}. Open a channel with that much or less, and another for the rest.`
			};
		}
		case 'FUNDING_INPUTS': {
			const sats = (value) => (/^\d+$/.test(String(value ?? '')) ? `${Number(value).toLocaleString('en-US')} sats` : null);
			const [has, needs, other] = [sats(details.eligibleSats), sats(details.neededSats), sats(details.otherSats)];
			if (!has || !needs) return { code, text: error.message };
			const elsewhere = other && Number(details.otherSats) > 0 ? ` Another ${other} are on addresses of other types, which cannot be used for it.` : '';
			return {
				code,
				text: `The bitcoin for an asset channel has to be on native SegWit addresses. This wallet has ${has} on those, and this needs about ${needs}.${elsewhere} Nothing was done and nothing was spent.`
			};
		}
		case 'INSUFFICIENT_INBOUND': {
			const max = details.maxReceivable;
			if (max === undefined || max === null || isZero(max)) {
				return {
					code,
					text: `No channel of this wallet can receive ${name} right now. A channel receives only what is on the peer's side of it, so there is nothing to receive into until one is open and the peer holds some. An on-chain address works meanwhile.`
				};
			}
			return {
				code,
				text: `The most this wallet can receive over Lightning right now is ${units(max, asset)}: that is what its peer holds on the other side of the channel. Ask for that much or less, or use an on-chain address for the whole amount.`
			};
		}
		case 'PEER_OFFLINE': {
			// The wallet names the peer and says what was not done. Where a
			// page says it from the channel list, these are the words.
			if (error.message) return { code, text: sentence(error.message) };
			const who = details.peerAlias || (details.peerPubkey ? peerName({ peerPubkey: details.peerPubkey }) : '');
			return { code, text: `The peer of the asset channel this would go through${who ? `, ${who},` : ''} is not connected, so nothing was done. Try again once it is back.` };
		}
		case 'INSUFFICIENT_OUTBOUND': {
			const can = details.sendable;
			if (can === undefined || can === null || isZero(can)) {
				return {
					code,
					text: `No channel of this wallet can send ${name} right now. An invoice is paid from a channel, and what is held on-chain cannot pay one.`
				};
			}
			return {
				code,
				text: `This invoice needs more than the ${units(can, asset)} this wallet can send over Lightning right now. What it holds on-chain cannot pay an invoice.`
			};
		}
		case 'QUOTE_EXPIRED':
			return { code, text: 'That price has expired. Ask for a new one.' };
		case 'QUOTE_CHANGED':
			return { code, text: 'The price moved before the payment was made, so nothing was paid.' };
		case 'PEER_NO_ASSET_CHANNELS':
			return {
				code,
				text: 'That peer does not open asset channels, so nothing was opened and nothing was spent. Choose a peer that runs Taproot Assets channels.'
			};
		case 'INSUFFICIENT_BTC': {
			const needed = Number(details.needed);
			const spendable = Number(details.spendable);
			if (Number.isFinite(needed) && Number.isFinite(spendable)) {
				return {
					code,
					text: `Opening needs ${fmtSats(needed)} on-chain and this wallet has ${fmtSats(spendable)}. Deposit bitcoin on the Receive tab first.`
				};
			}
			return { code, text: 'This wallet does not have the bitcoin on-chain that opening needs. Deposit some on the Receive tab first.' };
		}
		case 'INSUFFICIENT_ASSET_BALANCE':
			return {
				code,
				text: `This wallet does not hold that much ${name} on-chain. Only what is on-chain can go into a new channel.`
			};
		case 'AMOUNT_REQUIRED':
			return { code, text: 'This invoice does not name an amount, so say how many sats to pay.' };
		case 'BAD_INVOICE':
			return { code, text: 'The wallet could not read that invoice. Check that all of it was pasted.' };
		case 'LIGHTNING_UNAVAILABLE':
			return { code, text: 'This wallet has no Lightning, so it has no asset channels to use.' };
		case 'CHANNEL_NOT_FOUND':
			return { code, text: 'This wallet no longer has that channel. It may already be closed.' };
		default:
			break;
	}
	if (error.unknown) {
		return { code: 'NO_ANSWER', text: 'No answer came back from the wallet, so it is not known whether this went through. Check before trying again.' };
	}
	if (isRefusal(error) && error.message) return { code, text: sentence(error.message) };
	if (!isRefusal(error)) {
		return { code: code || 'NO_ANSWER', text: `The wallet did not answer: ${sentence(error.message || 'no answer')}` };
	}
	return { code, text: 'The wallet refused this, and did not say why.' };
}

/** A failed payment, in words: what the wallet said went wrong, and that nothing left. */
export function payFailure(answer) {
	const why = String((answer && answer.failureDescription) || '').trim();
	const reason = why ? sentence(why.charAt(0).toUpperCase() + why.slice(1)) : 'The wallet did not say why.';
	return `The payment did not go through, and nothing was paid. ${reason}`;
}

/* ------------------------------------------- the bitcoin in asset channels */

const wholeSats = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/**
 * The bitcoin on this wallet's side of its asset channels, from the
 * daemon's GET /balance: `assetChannelSats` for the channels that are there
 * (opening, open, waiting for their peer, failed and not yet closed) and
 * `assetChannelClosingSats` for those that are closing. Neither is in the
 * daemon's `lightning` or `total`, so a page says each on a quiet line of
 * its own and adds it to no figure: [{ kind, sats, words, home }], to
 * follow the amount. `home` says that the bitcoin of a channel that is
 * there comes home when the channel closes, which a page says on the line
 * or in its help, as its layout fits; a closing channel's line says it is
 * on its way home already, and has none. Both keys are absent on a wallet
 * without an asset channel and on an engine that cannot carry one, and the
 * answer is null then.
 */
export function assetChannelBitcoin(balance) {
	if (!balance || typeof balance !== 'object') return null;
	const open = wholeSats(balance.assetChannelSats);
	const closing = wholeSats(balance.assetChannelClosingSats);
	const lines = [];
	if (open > 0) lines.push({ kind: 'open', sats: open, words: 'in asset channels', home: 'comes home when the channel closes' });
	if (closing > 0) lines.push({ kind: 'closing', sats: closing, words: 'on their way home from a closing asset channel', home: null });
	return lines.length > 0 ? lines : null;
}

/* ------------------------------------- results a channel has not taken in */

/**
 * What a channel's row says while the wallet has not taken in the results
 * of earlier payments on it (`undeliveredOutcomes`, on the row only while
 * above zero): the sentence a payment through it is refused with
 * (OUTCOMES_UNDELIVERED), said of the channel. Null for a channel that has
 * taken them all in.
 */
/**
 * How many more payments one way of a channel carries, as a few words to
 * set under what it can send or receive. Null where the wallet's node does
 * not say.
 */
export function paymentsLeft(n) {
	if (!Number.isInteger(n) || n < 0) return null;
	if (n === 0) return 'no payment left';
	return n === 1 ? '1 more payment' : `${n.toLocaleString('en-US')} more payments`;
}

/** The host's sentence for a payment this side's bitcoin in the channel cannot carry (CHANNEL_BITCOIN_SHORT). */
export const CHANNEL_BITCOIN_SHORT_TEXT =
	"Your side of the asset channel has too little bitcoin left to carry a payment, so nothing was paid. Each payment moves a little of the channel's bitcoin to the one who is paid. Once you have been paid through the channel, you can pay through it again.";

/** Whether a channel holds units this side's bitcoin in it can no longer carry out. */
export function carriesNothing(channel) {
	if (!channel || channel.sendablePayments !== 0) return false;
	try {
		return BigInt(channel.localBalance || 0) > 0n;
	} catch {
		return false;
	}
}

/**
 * The note of a channel that holds units one way cannot move, for want of
 * bitcoin on the side that pays, in the words the refusal uses. Null when
 * both ways carry, or the node does not say.
 */
export function bitcoinShortNote(channel) {
	if (!channel) return null;
	const held = (v) => {
		try {
			return BigInt(v || 0) > 0n;
		} catch {
			return false;
		}
	};
	const out = channel.sendablePayments === 0 && held(channel.localBalance);
	const back = channel.receivablePayments === 0 && held(channel.remoteBalance);
	const why = "Each payment moves a little of the channel's bitcoin to the one who is paid.";
	if (out && back) return `Neither side of this channel has enough bitcoin left to carry a payment, so it carries none. ${why}`;
	if (out) return `Your side of this channel has too little bitcoin left to carry a payment. ${why} Once you have been paid through it, you can pay through it again.`;
	if (back) return `The peer's side of this channel has too little bitcoin left to carry a payment to you. ${why} Once you have paid the peer through it, it can pay you again.`;
	return null;
}

/**
 * The line of a channel closed by force whose units and bitcoin wait out
 * the delay of the close: after which block they come back. Null when the
 * wallet does not say.
 */
export function waitsNote(channel) {
	const height = channel && channel.recoveryWaitsUntil;
	if (!Number.isInteger(height) || height <= 0) return null;
	return `What is in this channel comes back on-chain after block ${height.toLocaleString('en-US')}, once the delay of a close without the peer has run out.`;
}

export function undeliveredNote(channel) {
	const n = channel && channel.undeliveredOutcomes;
	if (!Number.isInteger(n) || n <= 0) return null;
	const what = n === 1 ? 'the result of an earlier payment' : `the results of ${n} earlier payments`;
	return `This wallet has not yet taken in ${what} on this channel, so nothing is paid through it until it has. Nothing is wrong with the channel. Restart the wallet, and if this is said again afterwards, its log says why.`;
}
