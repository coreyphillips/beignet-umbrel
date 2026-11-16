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
import { isRefusal, sentence } from './assets.js';
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
	return typeof mode === 'string' && mode !== 'off';
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
	// On the wallet's record and not held by its node: what a restore from a
	// backup leaves. It carries nothing and cannot be closed from here.
	if (s === 'MISSING') return { word: 'not held here', tone: 'red', usable: false };
	return { word: s ? s.toLowerCase().replace(/_/g, ' ') : 'unknown', tone: 'muted', usable: false };
}

/** Whether a close can still be asked for: not for one already on its way out. */
export function canClose(channel) {
	const s = String((channel && channel.state) || '').toUpperCase();
	return !CLOSING.has(s) && s !== 'CLOSED' && s !== 'FORCE_CLOSED' && s !== 'MISSING';
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
 * Where an invoice made here stands: 'paid', 'failed', 'expired' or
 * 'waiting'. Paid is the activity row saying complete, or the invoice list
 * saying so, whichever is heard first; it is never guessed from the clock.
 */
export function invoiceStanding({ invoice, row, listed, now = Date.now() } = {}) {
	if (row && row.state === 'complete') return 'paid';
	if (listed && PAID.has(String(listed.status || '').toUpperCase())) return 'paid';
	if (row && row.failed) return 'failed';
	const deadline = invoiceDeadline(invoice);
	if (deadline !== null && now >= deadline) return 'expired';
	return 'waiting';
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
export function lightningRefusal(error, { asset } = {}) {
	if (!error) return null;
	const code = error.code || '';
	const details = error.details || {};
	const name = asset && asset.name ? asset.name : 'this asset';
	switch (code) {
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
