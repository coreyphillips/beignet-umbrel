'use strict';

/**
 * Asset channels: what the ten Lightning routes do, what the loop does for
 * them, and what the host answers the library's Lightning service.
 *
 * Everything here works against `host.ln`, the facade adapter.js builds over
 * the library's Lightning entry (`createLightning`). In tests it is the same
 * facade, over a stand-in for the entry. A wallet whose engine or library
 * cannot carry asset channels has none: `host.ln` is null,
 * the status says lightning is off, and every route but the channel list
 * refuses with LIGHTNING_UNAVAILABLE.
 *
 * The mode
 *
 *   'full'  the manager asked for asset channels and the wallet can have
 *           them. Everything below is served.
 *   'off'   it did not, or the wallet cannot. Nothing is opened, no invoice
 *           is made or paid, and a channel a peer offers is turned down.
 *           A wallet that already has a channel still lists it, closes it
 *           and brings its assets home: the provider is attached whatever
 *           the mode, because a channel has to stay enforceable.
 *
 * The lock
 *
 *   The library's Lightning service is called back by the node while it
 *   works (a peer's answer arrives, and the open that waits for it goes on
 *   from inside that callback). So nothing of `host.ln` that can reach the
 *   node is ever called with the host's lock held, or inside a storage
 *   transaction: the lock is taken for the host's own rows and let go
 *   before the library is asked for anything.
 *
 * Opening a channel
 *
 *   The peer is connected to and asked whether it takes asset channels, and
 *   the proofs of the assets are put on the proof server, before anything
 *   is written. Then one storage transaction writes the `committed/
 *   funding:<id>` marker, the answer to the request key and the channel's
 *   note, and only then is the library told to open, under an id the host
 *   chose. A crash before that write leaves nothing. A crash after it
 *   leaves a marker the next start opens again under the same id, which the
 *   library takes as the same open and never as a second one. A funding
 *   flow the library holds with no marker was never confirmed by anyone,
 *   and the next start cancels it before anything is carried on.
 *
 *   An open is undone, and its request key freed to open again, only once
 *   it is final that nothing was opened under its id and nothing will be:
 *   the library says nothing is left of it, and no call that could still
 *   open it is out. So a close of an open that is being started stops that
 *   open and waits for it before it believes what the library says. An
 *   open whose funding transaction is signed is a channel in being,
 *   whatever its phase says: it is listed and counted, its units are in
 *   the books, and it is never undone. The one exception is the library's:
 *   a signed funding it has proven unable to confirm and given up, which
 *   is over, and said. The loop looks at every confirmed open that nobody
 *   is working on, on every pass, and reads all of this from the library's
 *   list and never from an event alone.
 *
 *   The library answers an open once its funding is negotiated, before the
 *   peer has signed, and the id it answers with is written into the note.
 *   So the note says two things apart: `channelId`, that the library
 *   answered, and `stage`, 'asked' until the host has itself seen the open
 *   past its point of no return. An open that was answered, was never seen
 *   signed, and that the library no longer lists is one a crash cut short
 *   (endLost). It is ended only once nothing is left of it anywhere: the
 *   library lists nothing under either id, the node holds no channel
 *   under either, the library has said it neither keeps what the funding
 *   set aside nor saw it spent, no on-chain record is set aside under its
 *   name, and the library answers that nothing will be opened under the
 *   id. Then it is a failed open: its note stays, as a FAILED row with
 *   the reason, its marker goes, an `error` event says so, and its request
 *   key answers that failure from then on, and never `funding` again.
 *   An open the library was never heard to answer is opened again under
 *   the same id at the next start, as before, unless the node holds a
 *   channel under that id; left unlisted after that, it ends the same way.
 *
 *   Until a funding has confirmed, its inputs stay in the on-chain records,
 *   set aside under its name. What of them goes into the channel is counted
 *   in the channel and taken off the on-chain figure, so nothing is counted
 *   twice, and what they hold beyond that, the change, stays on-chain.
 *
 * A channel the node does not hold
 *
 *   The library lists what its records say the node held and the node does
 *   not hold, with no close on record: what a restore from a backup leaves.
 *   The host calls it MISSING. It is listed with its last known balance,
 *   counted as a live channel, never usable, never an open under way, and
 *   a close of it is refused in a sentence. The status says so.
 *
 * Paying an invoice
 *
 *   The price is shown first (a quote), and paying names the quote and the
 *   most of the asset it may take. The answer to the request key and the
 *   activity row are written in one transaction before the library is told
 *   to pay, so the same key never pays twice, also across a restart.
 *
 *   How a payment ended is only ever written from the node's own record of
 *   it (`host.ln.payment`). A call that throws, times out or is cut short
 *   by a stop says nothing about the payment, which stays pending until a
 *   later pass of the loop reads the record, also after a restart. The one
 *   exception is a refusal the library makes before anything leaves the
 *   wallet (the codes it exports for that, `host.ln.refusals`), and a
 *   payment the library never took that the node has no record of. Those
 *   the host concludes itself, marks as its own conclusion, and takes back
 *   if the node turns out to have the payment after all.
 *
 *   The record of a payment hash is that of its latest try, which it
 *   numbers. A row keeps the number that stood when it was written
 *   (`attemptBefore`), and takes its end only from a record numbered above
 *   it: what an earlier try at the same invoice left is not this one's.
 *
 *   Two things a record can say are neither an end nor a failure, and the
 *   row says them as a `notice`: that the node no longer has a record of
 *   the payment (it stays pending, time ends nothing, and the invoice is
 *   never paid again), and that the node took the send without confirming
 *   that it went out as an asset payment (it ends as the node reports).
 *   The wallet's own spending limit refusing a payment is a refusal before
 *   anything left, in a sentence that names the limit when the engine does.
 *
 * Being paid
 *
 *   An invoice says what was invoiced and, once paid, what arrived: a
 *   payer's rate can round that one unit down. The activity row and the
 *   balance count what arrived.
 *
 * Rows
 *
 *   chan/<id>            what the host knows of a channel that the library
 *                        does not: who the user said the peer is, when it
 *                        was asked for, when it was over
 *   committed/funding:<id>  an open the user confirmed
 *   l-quote/<id>         a price given, until it is used or runs out
 *   l-change/<id>        the change of a channel funding that is in no
 *                        record of the wallet's (settleReservations)
 *   inv/<paymentHash>    an invoice made, for the list of them
 *   row/ln-send-<hash>   a payment, and row/ln-receive-<hash> an invoice,
 *                        as activity
 */
const crypto = require('crypto');
const { sha256Hex } = require('./store');
const { CHANNEL_SATS, CARRIER_SATS, unhex } = require('./adapter');
const { refusal, isRefusal, mapLightning, isFenced, plainMessage, codeOf, paymentFailure, engineCodeOf, ENGINE_REFUSALS, LIGHTNING_REFUSALS, modeUnavailable, FEE_POLICY_REFUSED } = require('./errors');
const views = require('./views');
const ops = require('./ops');

// What the peer has to keep on its side of a channel, when neither the
// library nor the engine says: a hundredth of it.
const RESERVE_PERCENT = 1;
// A funding transaction's size, for a quote the wallet could not fund.
const OPEN_VBYTES_GUESS = 300;
// Channels peers have offered and that are not open yet. More are turned down.
const MAX_INBOUND_PENDING = 4;
const ACCEPTED_KEPT_MS = 2 * 60 * 1000;
const INVOICE_SECONDS = 60 * 60;
const MAX_DESCRIPTION = 200;
const MAX_INVOICES_LISTED = 100;
const INVOICE_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// A force-closed channel stays in the list this long after its assets are home.
const FORCE_CLOSED_SHOWN_MS = 24 * 60 * 60 * 1000;
// How often a request looks at the payment it began, while it waits for its end.
const PAY_POLL_MS = 200;
// A payment the library never said it took, and the node has no record of,
// is taken to have never left once it is this old.
const UNSENT_AFTER_MS = 30 * 1000;
const PRICE_MOVED = ['ERR_BEIGNET_LN_PRICE_BOUND', 'ERR_BEIGNET_LN_QUOTE_EXPIRED'];
// What the library says when the peer a payment would go through is not
// connected.
const PEER_AWAY = 'ERR_BEIGNET_LN_PEER_OFFLINE';
const CLOSED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
// The phases of an open that came to nothing. They say so only of an open
// that signed nothing: a signed funding transaction is a channel in being.
const FAILED_PHASES = ['rejected', 'failed', 'cancelled'];
// An open the user confirmed, that nobody is working on and the library has
// no record of, is taken to have come to nothing once it is this old.
const OPEN_LOST_AFTER_MS = 30 * 1000;
// How long an open that failed stays on the channel list.
const FAILED_OPEN_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;

// An open that came to nothing before anything was signed.
const isEnded = (c) => !c.signed && FAILED_PHASES.includes(c.phase);
// A signed funding the library has proven unable to confirm and given up:
// the one way a signed funding ends. What it had set aside is released by
// then. Until it is, the flow is still a channel in being.
const isAbandoned = (c) => c.signed && c.phase === 'failed' && !c.fundingReservation;
// Why an open that failed after it was answered did, by the code its note keeps.
const OPEN_FAILURES = Object.freeze({
	CHANNEL_OPEN_INTERRUPTED: 'This channel open was interrupted before any bitcoin or asset left the wallet, so nothing was opened and nothing was spent. It can be tried again.',
	// Ended by the library with nothing signed, after this host had answered for it.
	CHANNEL_OPEN_FAILED: 'This channel open ended before any bitcoin or asset left the wallet, so nothing was opened and nothing was spent. It can be tried again.'
});
// Why the library ended an open, by the reason code it names on the flow
// (`reasonCode`): the closed set it exports as ASSET_OPEN_ENDED_REASONS,
// each with a sentence of the host's own. adapter.js reads the code from
// the entry, and this is the one table that knows the names. A code not
// listed here gets the general sentence of OPEN_FAILURES.
const OPEN_ENDED_TAIL = 'so nothing was opened and nothing was spent. It can be tried again.';
const OPEN_ENDED_BECAUSE = Object.freeze({
	INTERRUPTED_BEFORE_SIGNED: `This channel open was interrupted before the peer had signed for it, and before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	PEER_REFUSED: `The peer refused this channel open before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	PEER_ENDED: `The peer's side of this channel open ended before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	TERMS_EXPIRED: `The terms of this channel open ran out before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	ENGINE_DROPPED: `The wallet's node dropped this channel open before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	NEVER_FUNDED: `This channel open was never funded, and no bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	CANCELLED: `This wallet gave up this channel open before any bitcoin or asset left it, ${OPEN_ENDED_TAIL}`,
	POLICY_REFUSED: `This wallet's own rules turned this channel down before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	FUNDING_INVALID: `A funding message of the peer did not pass this wallet's checks, so the open ended before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	FUNDING_FAILED: `This wallet could not fund its side of this channel open, so it ended before any bitcoin or asset left the wallet, ${OPEN_ENDED_TAIL}`,
	// The one reason past the point of no return: the funding was signed and
	// can never confirm.
	FUNDING_CONFLICT: 'The funding of this channel open can never confirm, because another transaction spent one of its inputs, so the open was given up and nothing went into a channel. It can be tried again.'
});
// The library's own words for an open it ended, on one line. They are its
// internals ("Funding wallet terms changed"): for the log, and for the
// detail a row shows beneath the host's sentence. Never part of a sentence.
const reasonOf = (text) =>
	String(text || '')
		.replace(/\s+/g, ' ')
		.trim()
		.replace(/[.!]+$/, '')
		.slice(0, 200);
/**
 * What a failed open says: { code, message, detail? }. The message is the
 * host's own sentence, whatever the library said: that of the reason code
 * the library named (`because`) where this host knows it, else the general
 * one of the host's code. `detail` is the library's words (`reason`), when
 * it gave any.
 */
const failedOpen = (code, { reason, because } = {}) => {
	const known = typeof because === 'string' && Object.prototype.hasOwnProperty.call(OPEN_ENDED_BECAUSE, because);
	const message = known ? OPEN_ENDED_BECAUSE[because] : OPEN_FAILURES[code] || 'This channel was not opened, and nothing was spent.';
	const detail = reasonOf(reason);
	return detail ? { code, message, detail } : { code, message };
};
const cancelledError = () => Object.assign(new Error('the open was cancelled'), { code: 'ERR_BEIGNET_LN_CANCELLED' });

const hexKey = (value) => String(value || '').trim().toLowerCase();
const isId = (text) => typeof text === 'string' && /^[0-9a-f]{8,128}$/.test(text);
const clone = (value) => JSON.parse(JSON.stringify(value));
const isOver = (word) => views.CHANNEL_OVER.includes(word);
const sentence = (text) => `${String(text).replace(/[.\s]+$/, '')}.`;

/* -------------------------------------------------------------------- mode */

/** 'full' when the wallet was asked for asset channels and can have them. Otherwise 'off'. */
const NOT_ADVERTISED =
	"This wallet's node does not offer asset channels to its peers: a Lightning feature they depend on is turned off in the node's settings. Nothing new can be opened, invoiced or paid over asset channels until it is turned on. The channels there already are stay listed and can still be closed.";

/**
 * What the node says of offering asset channels to its peers, when it says
 * it does not: { reason }, the reason being the node's own word, for the
 * status alone. Null when it offers them, when it cannot say, and when it
 * cannot be asked: only the node's own no turns anything off.
 */
function notAdvertised(host) {
	try {
		if (!host.ln || !host.ln.ready()) return null;
		const said = host.ln.advertisement();
		if (!said || said.advertised) return null;
		// The node's own words, as it wrote them: one line, and no longer than a reason needs to be.
		const reason = said.reason
			? String(said.reason)
					.replace(/[\u0000-\u001f\u007f]+/g, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 300)
			: '';
		return { reason: reason || null };
	} catch (_) {
		return null;
	}
}

/** Asset channels are wanted and there, apart from what the node says of offering them. */
const wanted = (host) => !!host.ln && !host.mem.lnError && host.cfg.lightning === 'full';

// 'full' only while the node offers asset channels: a node that does not is
// one no peer opens a channel with, so nothing new is begun over it.
const modeOf = (host) => (wanted(host) && !notAdvertised(host) ? 'full' : 'off');

const unavailable = () => refusal('LIGHTNING_UNAVAILABLE', 'This wallet has no Lightning for its assets, so it has no asset channels to use.', 409);
/** Why nothing new can be begun: the node's own no where that is the reason, and no Lightning otherwise. */
const whyOff = (host) => {
	const quiet = wanted(host) ? notAdvertised(host) : null;
	return quiet ? refusal('LIGHTNING_NOT_ADVERTISED', NOT_ADVERTISED, 409, quiet.reason ? { reason: quiet.reason } : undefined) : unavailable();
};
const starting = () => refusal('ASSETS_STARTING', 'Lightning is still starting. Try again in a moment.', 503);

/** The node is there and the opens a restart interrupted are settled. */
function requireStarted(host) {
	if (!host.ln.ready() || !host.mem.lnSettled) throw starting();
}

/** For a route that begins something: asset channels are on. */
function requireFull(host) {
	host.requireUp();
	if (modeOf(host) !== 'full') throw whyOff(host);
	requireStarted(host);
}

/** For a route that works on a channel there already is: whatever the mode. */
function requireProvider(host) {
	host.requireUp();
	if (!host.ln) throw unavailable();
	if (!host.ln.ready()) throw starting();
}

/* ---------------------------------------------------------------- channels */

/**
 * Every channel of the wallet, as the host reasons about it: the library's
 * list, with the note the host keeps beside each, and the opens the user
 * confirmed that the library has not heard of yet. Empty until the node is
 * there to ask.
 *
 *   id         the id the open was given (the pending channel id)
 *   channelId  the engine's id, once it has one
 *   word       the state the dashboard is told (views.channelWord)
 *   usable     whether it can carry a payment now
 *   over       whether it is closed and its assets are back on-chain
 *   opening    whether it is an open still under way
 *   counted    whether its assets are in it, and not on the chain
 *   reclaimable  whether the bitcoin of its funding can be taken back,
 *              which ends the open: one this wallet funded, whose funding
 *              transaction is made and has not confirmed, with what it set
 *              aside still held (reclaimFunding)
 */
function channelList(host) {
	const ln = host.ln;
	if (!ln || !ln.ready()) return [];
	const registry = host.registry();
	const keyOf = (assetId, groupKey) => groupKey || (assetId && registry.get(assetId) ? registry.get(assetId).groupKey : null) || assetId || null;
	const notes = new Map(host.rows.list('chan/').map((r) => [r.value.id, r.value]));
	const seen = new Set();
	const out = [];
	// Whether the node is connected to a peer, asked once for each. A node
	// that cannot say is not taken to say no.
	const there = new Map();
	const connected = (pubkey) => {
		if (!there.has(pubkey)) {
			let said = null;
			try {
				said = ln.peerConnected(pubkey);
			} catch (_) {
				said = null;
			}
			there.set(pubkey, said !== false);
		}
		return there.get(pubkey);
	};
	for (const c of ln.channels()) {
		seen.add(c.pendingChannelId);
		// An open that came to nothing is not a channel. One whose funding
		// transaction is signed is, whatever its phase says: the transaction
		// may confirm, and its units are set aside for it. The one signed
		// funding that is no channel is the one given up as unable to confirm.
		if (isEnded(c) || isAbandoned(c)) {
			// One this host has ended as a failed open is listed from its note,
			// also while the library has not taken it off its list yet.
			if ((notes.get(c.pendingChannelId) || {}).failed) seen.delete(c.pendingChannelId);
			continue;
		}
		// A channel a peer began to open that the engine let go of before
		// anything was signed: nothing of this wallet's is in it.
		if (!c.signed && !c.initiator && c.engine === 'missing') continue;
		const note = notes.get(c.pendingChannelId) || {};
		const word = views.channelWord(c);
		// Its peer is there, and the two have agreed where the channel stands.
		const peerConnected = connected(c.peerPubkey) && c.state !== 'AWAITING_REESTABLISH';
		// A channel the node holds, with no close asked for: all a payment
		// needs of it but its peer. Only with the peer there does it carry one.
		const steady = word === 'NORMAL' && c.engine === 'held' && c.recovery === 'none';
		const usable = steady && c.state === 'NORMAL' && peerConnected;
		const spare = c.local > c.reserved ? c.local - c.reserved : 0n;
		// A side whose bitcoin in the channel carries no further payment
		// sends nothing, whatever units it holds, until a payment comes its
		// way: the library refuses before anything is sent. Where the
		// library does not say, the units are what counts.
		const paysOut = c.sendablePayments !== 0;
		const paysIn = c.receivablePayments !== 0;
		const assetId = c.assetId || note.assetId || null;
		const groupKey = c.groupKey || note.groupKey || null;
		out.push({
			id: c.pendingChannelId,
			channelId: c.channelId || note.channelId || null,
			peerPubkey: c.peerPubkey,
			peerAlias: note.peerAlias || null,
			initiator: c.initiator,
			assetId,
			groupKey,
			key: keyOf(assetId, groupKey),
			word,
			usable,
			peerConnected,
			// Kept from carrying a payment by nothing but its peer being away,
			// and what it could send and receive were the peer there.
			away: steady && !usable,
			couldSend: steady && paysOut ? spare : 0n,
			couldReceive: steady && paysIn ? c.remote : 0n,
			// Units a channel with its peer there holds and cannot move for
			// want of bitcoin on the side that pays: this wallet's going out,
			// the peer's coming in.
			heldOut: usable && !paysOut ? spare : 0n,
			heldIn: usable && !paysIn ? c.remote : 0n,
			sendablePayments: Number.isInteger(c.sendablePayments) ? c.sendablePayments : null,
			receivablePayments: Number.isInteger(c.receivablePayments) ? c.receivablePayments : null,
			// What its close brings back waits out a time lock until this height.
			waitsUntil: c.recovery === 'pending' && Number.isInteger(c.recoveryWaitsUntil) ? c.recoveryWaitsUntil : null,
			over: isOver(word),
			// Its funding transaction is not on chain, as the library says it:
			// an open under way or one that ended, with nothing on chain to close.
			unfunded: !c.confirmed,
			// The node has given the channel up. With its funding on chain
			// that is a failed channel. Without, an open that will not go through.
			gaveUp: c.state === 'ERRORED',
			// Not usable yet and not on its way out: an open still under way.
			opening: !isOver(word) && word !== 'MISSING' && word !== 'ERRORED' && !views.CHANNEL_CLOSING.includes(word) && c.recovery === 'none' && (word === 'OPENING' || !c.confirmed),
			// Its units are the channel's from the point of no return of its
			// open (`signed`). Before it, what the open set aside is still
			// the wallet's, and comes back when the open is given up.
			counted: (c.signed || c.committed || c.confirmed) && !isOver(word),
			fundingTxid: c.fundingTxid || null,
			reclaimable: !!c.initiator && !!c.fundingTxid && !!c.fundingReservation && !c.confirmed && !isOver(word),
			reclaimTxid: note.reclaim ? note.reclaim.txid : null,
			// On record, and not held by the node: see views.channelWord.
			missing: word === 'MISSING',
			// Results of earlier payments the wallet has not taken in yet, as
			// the library counts them. While there are any it pays nothing
			// through the channel (OUTCOMES_UNDELIVERED), and the row says so.
			undeliveredOutcomes: Number.isInteger(c.undeliveredOutcomes) && c.undeliveredOutcomes > 0 ? c.undeliveredOutcomes : 0,
			signed: c.signed,
			phase: c.phase,
			engine: c.engine,
			known: true,
			// Past the point of no return of its open, as the library has it.
			past: !!(c.signed || c.committed || c.confirmed),
			failure: null,
			// What it was funded with, by issuance: while its funding has not
			// confirmed, that much of the on-chain records is the channel's.
			assets: c.assets,
			local: c.local,
			remote: c.remote,
			sendable: usable && paysOut ? spare : 0n,
			receivable: usable && paysIn ? c.remote : 0n,
			fundingSats: c.fundingSats || note.fundingSats || 0,
			createdAt: note.createdAt || null,
			closedAt: note.closedAt || null
		});
	}
	for (const note of notes.values()) {
		// An open that failed stays listed for a while, as what it is.
		const failed = note.failed ? failedOpen(note.failed.code, note.failed) : null;
		if (seen.has(note.id) || (note.closedAt && !failed)) continue;
		// An open the user confirmed that the library has not heard of yet is
		// on its way. Anything else the library no longer lists was a channel,
		// and is over: it is never taken for an open still to be made.
		// One the library answered and the host never saw signed is still an
		// open, on its way or cut short: the loop finds out which (endLost).
		const coming = !failed && !!note.initiator && (!note.channelId || note.stage === 'asked');
		out.push({
			id: note.id,
			channelId: note.channelId || null,
			peerPubkey: note.peerPubkey,
			peerAlias: note.peerAlias || null,
			initiator: !!note.initiator,
			assetId: note.assetId,
			groupKey: note.groupKey || null,
			key: note.key,
			word: failed ? 'FAILED' : coming ? 'OPENING' : 'CLOSED',
			usable: false,
			peerConnected: connected(note.peerPubkey),
			away: false,
			couldSend: 0n,
			couldReceive: 0n,
			heldOut: 0n,
			heldIn: 0n,
			sendablePayments: null,
			receivablePayments: null,
			waitsUntil: null,
			over: !coming,
			opening: coming,
			counted: false,
			fundingTxid: null,
			reclaimable: false,
			reclaimTxid: null,
			missing: false,
			signed: !coming && !failed,
			phase: '',
			engine: 'absent',
			known: false,
			past: false,
			failure: failed,
			...(failed ? { capacity: BigInt(note.amount || 0) } : {}),
			assets: [],
			local: coming ? BigInt(note.amount) : 0n,
			remote: 0n,
			sendable: 0n,
			receivable: 0n,
			fundingSats: note.fundingSats || 0,
			createdAt: note.createdAt || null,
			closedAt: note.closedAt || null
		});
	}
	return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * How many channels are not over, where "cannot be asked" may count as
 * none: whether the wallet holds assets. The count is liveChannels', the
 * one function that says what an asset channel that is not over is.
 */
function channelCount(host) {
	const live = liveChannels(host);
	return live === null ? 0 : live;
}

/**
 * How many channels are not over, for whoever must not take "cannot be
 * asked" for "none": null while there is a node to ask that is not there
 * yet, and when the list cannot be read. A wallet with no Lightning side
 * has none, and says 0.
 *
 * This is the one count of asset channels. The status gives it as
 * `assetChannels`, taken when the status is asked, and the manager refuses
 * by that same number: it asks the status and counts no rows itself. So a
 * row the list shows and the number the status gives cannot disagree.
 */
function liveChannels(host) {
	if (!host.ln) return 0;
	try {
		if (!host.ln.ready()) return null;
		return channelList(host).filter((c) => !c.over).length;
	} catch (_) {
		return null;
	}
}

/** The `lightning` part of the status. */
function statusOf(host) {
	let usableChannels = 0;
	try {
		usableChannels = channelList(host).filter((c) => c.usable).length;
	} catch (_) {
		usableChannels = 0;
	}
	const fees = feeStatusOf(host);
	const warnings = warningsOf(host, fees);
	// Off by the node's own word: said with the node's reason, so that it
	// is not taken for a wallet that has no Lightning for its assets.
	const quiet = wanted(host) ? notAdvertised(host) : null;
	return {
		mode: modeOf(host),
		usableChannels,
		feeCoins: feeCoinsOf(fees),
		...(quiet ? { unavailable: { code: 'NOT_ADVERTISED', message: NOT_ADVERTISED, reason: quiet.reason } } : {}),
		...(warnings.length ? { warning: warnings.map((w) => w.text).join(' '), warnings } : {})
	};
}

/* ---------------------------------------------------- the fee coin pool */

// Claiming a payment on chain after a channel is closed without its peer
// takes a small confirmed coin of the wallet's own bitcoin for the miner
// fee, and a block to prepare it. The engine says whether it could prepare
// one now (the adapter's feeStatus), and the status hands that on.
const feeCoinsText = (neededSats) =>
	`Keep at least ${neededSats} sats of confirmed bitcoin on-chain in this wallet. A payment caught in an asset channel that has to be closed without the peer is claimed with an on-chain transaction, and its miner fee comes from the wallet's own bitcoin. The wallet has no confirmed coin large enough for that now, so such a claim could come too late.`;

/**
 * What the engine says of its fee coin pool, or null when nobody can say.
 * A policy the engine refused is logged the once, in the host's words, and
 * again only if it is refused anew after it was taken. Never throws.
 */
function feeStatusOf(host) {
	try {
		if (!host.ln || !host.ln.ready() || typeof host.ln.feeStatus !== 'function') return null;
		const said = host.ln.feeStatus() || null;
		const refused = said && said.available === false ? said.error || {} : null;
		const why = refused
			? `${refused.code || 'FEE_POLICY_REFUSED'}: ${String(refused.message || '')
					.replace(/[\u0000-\u001f\u007f]+/g, ' ')
					.replace(/\s+/g, ' ')
					.trim()
					.slice(0, 300)}`
			: null;
		if (why !== (host.mem.feePolicySaid || null)) {
			host.mem.feePolicySaid = why;
			if (why) host.say('warn', `assets: asset channels: the node refused the fee settings this app gives it for asset channels, so no new asset channel is opened until that is put right (${why})`);
		}
		return said;
	} catch (_) {
		return null;
	}
}

/** `status.lightning.feeCoins`: whether a fee coin could be prepared now, and from what. Null when nobody can say. */
function feeCoinsOf(fees) {
	if (!fees || fees.available !== true) return null;
	const p = fees.preparation;
	return {
		possible: p.possible,
		neededSats: p.neededSats,
		largestConfirmedSats: p.largestConfirmedSats,
		ready: fees.feeCoins.ready,
		budgetRemainingSats: fees.budget.remainingSats,
		// Why not, in the engine's word: FEE_FUNDS_UNAVAILABLE or FEE_BUDGET_EXHAUSTED.
		reason: p.possible ? null : p.reason
	};
}

/** No new channel while the node has refused its fee settings: said before anything is read or written. */
function requireFeePolicy(host) {
	const fees = feeStatusOf(host);
	if (fees && fees.available === false) throw refusal('FEE_POLICY_REFUSED', FEE_POLICY_REFUSED, 409);
}

const CHANNEL_MISSING =
	"An asset channel is on record that the wallet's node does not hold, as happens after a restore from a backup. It cannot be used or closed from this wallet, and its balance is the last one known. This wallet cannot bring the assets in it back by itself.";
const CHANGE_NOT_BACK =
	"Part of an asset went into the funding transaction of a channel as change and is not in this wallet's records, so it is not in the balance shown. The wallet's log says which asset and how much.";
const RECOVERY_STUCK = 'The assets of a closed channel have not come back on-chain yet. The wallet keeps trying, and its log says why.';

/**
 * What the status says is wrong with the wallet's asset channels: each a
 * code the dashboard can tell apart and a sentence of the host's. A wait
 * (RECOVERY_STUCK) is not a loss, and the reader should not be shown the
 * two alike. FEE_BUDGET_EXHAUSTED is the engine refusing a fee action of
 * the loop's (carrying a channel on, bringing its assets home) because the
 * budget for channel fees is used up: said while a pass meets it, and gone
 * with the first pass that does not. Never throws: the status must not.
 */
function warningsOf(host, fees = feeStatusOf(host)) {
	const said = [];
	try {
		if (channelList(host).some((c) => c.missing)) said.push({ code: 'CHANNEL_MISSING', text: CHANNEL_MISSING });
		if (host.rows.list('l-change/').length > 0) said.push({ code: 'CHANGE_NOT_BACK', text: CHANGE_NOT_BACK });
		if (recoveryStuck(host)) said.push({ code: 'RECOVERY_STUCK', text: RECOVERY_STUCK });
		if (host.mem.feeBudgetOut === true) said.push({ code: 'FEE_BUDGET_EXHAUSTED', text: ENGINE_REFUSALS.FEE_BUDGET_EXHAUSTED[1] });
		// The fee coin pool. A refused policy stops new channels, whatever the
		// wallet holds. A pool that cannot prepare a fee coin matters to a
		// wallet with a channel that is not over: for want of bitcoin it is
		// said with the figure to keep, and for a used-up budget by the note
		// the loop's own refusal has, the once.
		if (fees && fees.available === false) {
			said.push({ code: 'FEE_POLICY_REFUSED', text: FEE_POLICY_REFUSED });
		} else if (fees && fees.preparation.possible === false && channelList(host).some((c) => !c.over && !c.missing)) {
			if (fees.preparation.reason === 'FEE_FUNDS_UNAVAILABLE') said.push({ code: 'FEE_COINS_UNAVAILABLE', text: feeCoinsText(fees.preparation.neededSats) });
			else if (fees.preparation.reason === 'FEE_BUDGET_EXHAUSTED' && !said.some((w) => w.code === 'FEE_BUDGET_EXHAUSTED')) {
				said.push({ code: 'FEE_BUDGET_EXHAUSTED', text: ENGINE_REFUSALS.FEE_BUDGET_EXHAUSTED[1] });
			}
		}
	} catch (_) {
		/* what could not be read is not said */
	}
	return said;
}

/**
 * The most one payment can send and can receive of each asset, by the
 * host's key for it. A payment goes over one channel, so each figure is
 * that of the best single channel and never a sum: the least of what the
 * host's own list says a usable channel can move and what the library says,
 * which also knows whether the channel's peer is there.
 */
function paymentLimits(host) {
	const out = new Map();
	const ln = host.ln;
	if (!ln || !ln.ready()) return out;
	const registry = host.registry();
	const keyOf = (assetId, groupKey) => groupKey || (assetId && registry.get(assetId) ? registry.get(assetId).groupKey : null) || assetId || null;
	const said = new Map();
	for (const l of ln.paymentLimits()) {
		const key = keyOf(l.assetId, l.groupKey);
		if (!key) continue;
		const known = said.get(key) || { maxSend: 0n, maxReceive: 0n };
		said.set(key, { maxSend: l.maxSend > known.maxSend ? l.maxSend : known.maxSend, maxReceive: l.maxReceive > known.maxReceive ? l.maxReceive : known.maxReceive });
	}
	for (const c of channelList(host)) {
		if (!c.usable || !c.key || !said.has(c.key)) continue;
		const limit = out.get(c.key) || { maxSend: 0n, maxReceive: 0n, send: null, receive: null };
		if (c.sendable > limit.maxSend) Object.assign(limit, { maxSend: c.sendable, send: c });
		if (c.receivable > limit.maxReceive) Object.assign(limit, { maxReceive: c.receivable, receive: c });
		out.set(c.key, limit);
	}
	for (const [key, limit] of out) {
		const lib = said.get(key);
		if (lib.maxSend < limit.maxSend) limit.maxSend = lib.maxSend;
		if (lib.maxReceive < limit.maxReceive) limit.maxReceive = lib.maxReceive;
	}
	return out;
}

function listChannels(host) {
	host.requireUp();
	// A wallet that cannot have an asset channel has none, and says so: the
	// manager counts what this lists before it lets Lightning be taken away.
	if (!host.ln) return { channels: [] };
	// One that might, and cannot be asked yet, must not be read as "none".
	if (!host.ln.ready()) throw starting();
	const now = host.now();
	const gone = (c, word, after) => c.word === word && !!c.closedAt && now - c.closedAt >= after;
	const shown = (c) => c.word !== 'CLOSED' && !gone(c, 'FORCE_CLOSED', FORCE_CLOSED_SHOWN_MS) && !gone(c, 'FAILED', FAILED_OPEN_SHOWN_MS);
	return {
		channels: channelList(host)
			.filter(shown)
			.map((c) => views.channelView(c, c.key ? host.known(c.key) : null))
	};
}

/**
 * Tell whoever is listening about every channel whose state changed, and
 * note when one is over. Nothing is said the first time a generation looks:
 * that is the state it started with. A route that is about to change a
 * channel looks first, so that its own change is one that is told.
 */
async function noteChannels(host) {
	const { mem, rows } = host;
	const list = channelList(host);
	const before = mem.channelWords;
	const after = new Map();
	let changed = false;
	const tell = (channelId, state, key) => {
		changed = true;
		host.emitEvent('channel', { channelId, state });
		if (key) host.emitEvent('balance', { key });
	};
	for (const c of list) {
		after.set(c.id, { word: c.word, channelId: c.channelId || c.id, key: c.key });
		// Told when its state changes, and when the engine gives it its id.
		const was = before ? before.get(c.id) : null;
		if (before && (!was || was.word !== c.word || was.channelId !== (c.channelId || c.id))) tell(c.channelId || c.id, c.word, c.key);
	}
	// An open that was dropped is no channel any more.
	if (before) for (const [id, was] of before) if (!after.has(id) && !isOver(was.word)) tell(was.channelId, 'CLOSED', was.key);
	mem.channelWords = after;
	// The library's own rows changed with it, and they are in the backup.
	if (changed) host.markDirty();
	for (const c of list) {
		const note = rows.get(`chan/${c.id}`);
		// Its id as a channel is written down once the funding is signed, and
		// not before: an open with one is never opened a second time.
		const learnt = c.signed && c.channelId && note && !note.channelId;
		// Seen past its point of no return: a channel from here on, and never
		// again an open that may have come to nothing.
		const past = c.past && note && note.stage === 'asked';
		const ended = c.over && !c.closedAt;
		if (!learnt && !past && !ended) continue;
		await host.lock.run(() =>
			rows.tx(() => {
				const current = rows.get(`chan/${c.id}`) || { id: c.id, initiator: c.initiator, peerPubkey: c.peerPubkey, key: c.key, assetId: c.assetId, groupKey: c.groupKey, createdAt: null };
				rows.put(`chan/${c.id}`, { ...current, channelId: c.channelId || current.channelId || null, ...(past ? { stage: 'signed' } : {}), ...(ended ? { closedAt: host.now() } : {}) });
				// It is over: nothing is left for a restart to carry on.
				if (ended) rows.del(`committed/funding:${c.id}`);
			})
		);
	}
	// The note of a channel long over, once the library has let go of it too.
	const listed = new Set(list.filter((c) => c.known).map((c) => c.id));
	const old = host.now() - CLOSED_KEEP_MS;
	for (const { key, value } of rows.list('chan/')) {
		if (value.closedAt && value.closedAt < old && !listed.has(value.id)) await host.lock.run(() => rows.del(key));
	}
}

/* ----------------------------------------------------------------- opening */

function readPeer(peer) {
	const p = peer && typeof peer === 'object' ? peer : {};
	const pubkey = hexKey(p.pubkey);
	if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) {
		throw refusal('INVALID_PARAMS', 'A peer is named by its node public key: 66 characters, starting with 02 or 03.');
	}
	const where = p.host === undefined || p.host === null ? '' : String(p.host).trim();
	if (!where) return { pubkey, host: null, port: null, alias: aliasOf(p) };
	const port = p.port === undefined || p.port === null || p.port === '' ? 9735 : Number(p.port);
	if (where.length > 253 || /[\s/@]/.test(where)) throw refusal('INVALID_PARAMS', 'A peer is reached at a host name or an address, with nothing else around it.');
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw refusal('INVALID_PARAMS', 'A port is a number from 1 to 65535.');
	return { pubkey, host: where, port, alias: aliasOf(p) };
}

const aliasOf = (p) => (typeof p.alias === 'string' && p.alias.trim() ? p.alias.trim().slice(0, 64) : null);

function insufficientAsset(needed, total, free) {
	return refusal(
		'INSUFFICIENT_ASSET_BALANCE',
		total >= needed
			? 'Part of this asset is set aside for a send or a channel that has not confirmed yet. Wait for it to confirm, then try again.'
			: 'This wallet does not hold that much of the asset on-chain. Only what is on-chain can go into a new channel.',
		409,
		{ needed: needed.toString(), available: free.toString() }
	);
}

/**
 * What opening a channel with `body.amount` of `body.key` takes: which
 * issuance the units come from (one, always), and the bitcoin. Reads, and asks the
 * library what the funding transaction would cost; changes nothing.
 */
async function planOpen(host, body, feeRate) {
	requireFeePolicy(host);
	const amount = ops.parseUnits(body.amount);
	const key = hexKey(body.key);
	const registry = host.registry();
	const keyOf = (r) => r.groupKey || (registry.get(r.assetId) || {}).groupKey || r.assetId;
	const mine = (await host.tap.stores.assets.listAssets()).filter((r) => views.isLive(r) && (keyOf(r) === key || r.assetId === key));
	if (!key || mine.length === 0) throw refusal('ASSET_NOT_FOUND', 'This wallet does not hold that asset.', 404);
	const held = views.heldByAsset(mine);
	const reg = host.known(key, held) || { assetId: mine[0].assetId, groupKey: mine[0].groupKey || null, name: mine[0].name || null, type: mine[0].type, decimalDisplay: 0 };
	if (views.typeName(reg.type) === 'collectible') {
		throw refusal('INVALID_PARAMS', 'A collectible cannot go into a channel: a channel holds an amount, and a collectible is one of one.');
	}
	// One issuance a channel: the library funds a channel with units of one
	// asset ID, so a wallet that holds several issuances of a group opens a
	// channel for each. The one with the most free units is the one used,
	// and the most a channel can be opened with is what that one holds.
	const order = [...held.entries()].sort((a, b) => (a[1].free === b[1].free ? 0 : a[1].free > b[1].free ? -1 : 1));
	const [issuance, most] = order[0];
	if (most.free < amount) {
		const sum = (field) => order.reduce((total, [, h]) => total + h[field], 0n);
		if (order.length > 1 && sum('free') >= amount) {
			throw refusal(
				'CHANNEL_ASSETS',
				`A channel holds units of one issuance of an asset. This wallet holds enough of this asset in all, spread over ${order.length} issuances, and the most it has of a single one on-chain is ${most.free} units. Open a channel with that much or less, and another for the rest.`,
				409,
				{ needed: amount.toString(), largest: most.free.toString(), available: sum('free').toString(), issuances: order.length }
			);
		}
		throw insufficientAsset(amount, sum('total'), sum('free'));
	}
	const assets = [{ assetId: issuance, amount: amount.toString() }];
	const groupKey = reg.groupKey || null;
	const spendableSats = await host.settledSpendable();
	let quoted = null;
	try {
		quoted = await host.ln.quoteFunding({ assets: assets.map((a) => ({ assetId: a.assetId, amount: BigInt(a.amount) })), groupKey, fundingSats: CHANNEL_SATS, feeRate });
	} catch (err) {
		if (isFenced(err)) throw err;
		// A wallet short of bitcoin is answered with the figures. Anything
		// else the library refuses is the caller's to hear.
		const mapped = lightningError(host, err);
		if (!isRefusal(mapped) || mapped.extensionCode !== 'INSUFFICIENT_BTC') throw mapped;
	}
	const feeSats = quoted ? quoted.feeSats : Math.ceil(OPEN_VBYTES_GUESS * feeRate);
	if (feeSats > host.cfg.limits.maxFeeSats) {
		throw refusal('FEE_TOO_HIGH', `Opening would pay ${feeSats} sats to miners, above the ${host.cfg.limits.maxFeeSats} this wallet allows for an asset transaction.`, 400, {
			feeSats,
			maxFeeSats: host.cfg.limits.maxFeeSats
		});
	}
	const reserve = quoted && Number.isInteger(quoted.reserveSats) && quoted.reserveSats >= 0 ? quoted.reserveSats : Math.ceil((CHANNEL_SATS * RESERVE_PERCENT) / 100);
	const totalSats = CHANNEL_SATS + feeSats;
	return {
		key: reg.groupKey || reg.assetId,
		reg,
		amount,
		assets,
		groupKey,
		channelSats: CHANNEL_SATS,
		// What starts on the peer's side, so that it can pay back: the reserve
		// it has to keep, and the bitcoin two asset payments travel with.
		pushSats: reserve + 2 * CARRIER_SATS,
		feeSats,
		totalSats,
		spendableSats,
		sufficient: !!quoted && spendableSats >= totalSats,
		feeRate
	};
}

async function channelQuote(host, body) {
	requireFull(host);
	const feeRate = await host.feeRate(body.feeRate);
	const plan = await planOpen(host, body, feeRate);
	return {
		channelSats: plan.channelSats,
		pushSats: plan.pushSats,
		feeSats: plan.feeSats,
		totalSats: plan.totalSats,
		spendableSats: plan.spendableSats,
		sufficient: plan.sufficient
	};
}

/**
 * Put the proof of every output of the asset that may go into the channel
 * on the wallet's proof server. The peer checks where the assets came from
 * before it signs anything, and that server is where it asks.
 */
async function publishProvenance(host, plan) {
	const universe = host.cfg.defaultUniverse;
	if (!universe) {
		throw refusal('NO_PROOF_SERVER', 'This wallet has no proof server, and a peer looks an asset up there before it takes it into a channel. Nothing was opened.', 409);
	}
	const ids = new Set(plan.assets.map((a) => a.assetId));
	const records = (await host.tap.stores.assets.listAssets()).filter((r) => views.isLive(r) && !r.reservedBy && ids.has(r.assetId));
	const courier = host.courierFor(universe.courier);
	for (const r of records) {
		try {
			const file = await host.tap.freighter.exportProof(unhex(r.assetId), unhex(r.scriptKey), r.anchorOutPoint);
			await courier.deliverProof({ assetId: r.assetId, scriptKey: r.scriptKey, anchorOutPoint: r.anchorOutPoint }, file);
		} catch (err) {
			if (isFenced(err)) throw err;
			throw refusal(
				'PROOF_SERVER_UNREACHABLE',
				`The proof server did not take the asset's proof, which the peer needs before it opens a channel: ${sentence(plainMessage(err, 'it did not answer'))} Nothing was opened.`,
				502
			);
		}
	}
}

/** What a failed open says, in the dashboard's codes. What the library wrote of it goes to the log, and to nobody else. */
function openFailure(host, err) {
	const mapped = mapLightning(err);
	if (mapped) return mapped;
	host.say('warn', `assets: a channel could not be opened: ${plainMessage(err)}`);
	return refusal('CHANNEL_OPEN_FAILED', 'The channel could not be opened, and nothing was spent.', 502);
}

const openCancelled = () => refusal('CHANNEL_CANCELLED', 'This channel open was cancelled before anything was signed, so nothing was opened and nothing was spent.', 409);
/** An open that cannot be dropped any more. `c` is its entry in the list, which says whether its funding can be taken back instead. */
const openSigned = (c) =>
	c && c.reclaimable
		? refusal(
				'CHANNEL_OPENING',
				'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain. If that transaction will not confirm, its bitcoin can be taken back instead, which ends the open.',
				409,
				{ reclaimable: true }
			)
		: refusal('CHANNEL_OPENING', 'This channel is still being opened, and its funding transaction is already signed. It can be closed once it is on the chain.', 409);

/**
 * Forget an open that came to nothing: its marker, its note, and the answer
 * to its request key. The key can then open a channel again, so this is
 * called only once it is final that nothing was opened under the id and
 * nothing will be (giveUp answered true).
 */
function forgetOpen(host, id) {
	const { rows } = host;
	return host.lock.run(() =>
		rows.tx(() => {
			const note = rows.get(`chan/${id}`);
			rows.del(`committed/funding:${id}`);
			rows.del(`chan/${id}`);
			if (note && note.journal) rows.del(note.journal);
		})
	);
}

/**
 * Take an open that is over off the library's list, which keeps every open
 * that ended until it is told to let go. Asked once: should the library not
 * let go of it yet, the loop asks again after the next start (forgetEnded).
 */
function letGo(host, id) {
	host.mem.forgetAsked.add(id);
	try {
		if (host.ln.ready()) host.ln.forgetChannel(id);
	} catch (err) {
		if (isFenced(err)) throw err;
		host.say('warn', `assets: an open that is over could not be taken off the list: ${plainMessage(err)}`);
	}
}

/**
 * Ask the library to give an open up, which also stops one it is working
 * on. True: nothing is left of it and nothing will be opened under its id.
 * False: its funding transaction is signed, and it stays. Null: that cannot
 * be said now, because the library could not be asked, or because a call
 * that may still open the channel is out: a library that has not heard of
 * an open yet says there is nothing to cancel, and that is only the truth
 * once nobody is telling it to open.
 */
async function giveUp(host, id) {
	let gone = null;
	try {
		gone = !!(await host.ln.cancelFlow(id));
	} catch (err) {
		if (isFenced(err)) throw err;
		host.say('warn', `assets: a channel open could not be cancelled: ${plainMessage(err)}`);
		return null;
	}
	const task = host.mem.opens.get(id);
	return gone && task && task.calling ? null : gone;
}

/**
 * An open failed, or is one nobody is working on any more. When nothing was
 * signed it is undone: forgotten, with an `error` event unless the user
 * asked for it to be dropped. When the funding transaction was signed it
 * may be on the network: the open is kept and the loop carries it on.
 * Resolves to { error }, the refusal of an open that was undone or null for
 * one that is kept, or to { stopped } for one the user dropped.
 *
 * `again` says the open is one a restart interrupted, that this host began
 * again by itself. Nobody is waiting for that answer, and the request that
 * asked for the open never got one, so an open the library then refuses is
 * not forgotten: it becomes a failed open with the library's reason, which
 * is listed, said, and what its request key answers from then on.
 */
async function undoOpen(host, id, err, { again = false } = {}) {
	// No answer in time is not a no: the flow is the library's to carry on.
	if (codeOf(err) === 'ERR_BEIGNET_LN_TIMEOUT') return { error: null };
	if ((await giveUp(host, id)) !== true) return { error: null };
	const asked = host.mem.dropping.delete(id) || codeOf(err) === 'ERR_BEIGNET_LN_CANCELLED';
	const note = again && !asked ? host.rows.get(`chan/${id}`) : null;
	if (note && !note.closedAt && host.rows.get(`committed/funding:${id}`)) {
		const why = reasonOf(plainMessage(err, ''));
		const failed = failedOpen('CHANNEL_OPEN_FAILED', { reason: why });
		await endOpen(
			host,
			id,
			note,
			failed,
			{ reason: why },
			(channelId) => `assets: a channel open a restart interrupted (${channelId}) could not be begun again${why ? `: ${why}` : ''}. Nothing left the wallet, and it can be asked for again.`
		);
		return { error: refusal(failed.code, failed.message, 409) };
	}
	const failure = asked ? openCancelled() : openFailure(host, err);
	await forgetOpen(host, id);
	letGo(host, id);
	if (!asked) host.emitEvent('error', { code: failure.extensionCode, message: failure.message, channelId: id });
	await noteChannels(host);
	return asked ? { stopped: true } : { error: failure };
}

/**
 * Tell the library to open the channel the note `chan/<id>` describes, with
 * the lock let go. One open per id runs at a time, and it goes on only
 * while the user's confirmation stands: the marker and the note are read
 * again after every wait, and an open that was dropped meanwhile stops
 * before the library is told anything. Resolves to { ok }, to { error }
 * (the refusal of an open that failed and was undone, or null for one that
 * failed and is kept), or to { stopped } for one that was dropped.
 */
function startOpen(host, id, { reconnect = false } = {}) {
	const { mem, rows } = host;
	const running = mem.opens.get(id);
	if (running) return running.run;
	const task = { calling: false, run: null, stop: null };
	const stopped = new Promise((resolve) => {
		task.stop = resolve;
	});
	const confirmed = () => (mem.dropping.has(id) || !rows.get(`committed/funding:${id}`) ? null : rows.get(`chan/${id}`));
	// Before anything runs: an open that ends at once must find its own entry to remove.
	mem.opens.set(id, task);
	task.run = host.lock.outside(async () => {
		try {
			let note = confirmed();
			// After a restart the peer may not be connected yet.
			if (note && reconnect) {
				await Promise.race([host.ln.connect({ pubkey: note.peerPubkey, host: note.host || undefined, port: note.port || undefined }).catch(() => undefined), stopped]);
				note = confirmed();
			}
			if (!note) return { stopped: true };
			// It got as far as a channel once: it is never opened a second time.
			if (note.channelId) return { ok: true };
			let opened = null;
			task.calling = true;
			try {
				opened = await host.ln.openChannel({
					pendingChannelId: id,
					peerPubkey: note.peerPubkey,
					assets: note.assets.map((a) => ({ assetId: a.assetId, amount: BigInt(a.amount) })),
					groupKey: note.groupKey || null,
					decimalDisplay: note.decimalDisplay,
					fundingSats: note.fundingSats,
					pushSats: note.pushSats,
					feeRate: note.feeRate,
					// The most the funding transaction itself may pay: a quote is an estimate.
					maxFeeSats: Number.isInteger(note.maxFeeSats) ? note.maxFeeSats : host.cfg.limits.maxFeeSats
				});
			} finally {
				task.calling = false;
			}
			await host.lock.run(() => {
				const current = rows.get(`chan/${id}`);
				if (current && !current.channelId) rows.put(`chan/${id}`, { ...current, channelId: opened.channelId });
			});
			await noteChannels(host);
			host.nudge();
			return { ok: true };
		} catch (err) {
			if (isFenced(err)) {
				host.shutdown();
				return { error: refusal('ASSETS_STOPPING', 'The wallet is restarting. Try again in a moment.', 503) };
			}
			try {
				return await undoOpen(host, id, err, { again: reconnect });
			} catch (undoError) {
				if (isFenced(undoError)) host.shutdown();
				return { error: null };
			}
		} finally {
			if (mem.opens.get(id) === task) mem.opens.delete(id);
		}
	});
	return task.run;
}

/**
 * Drop an open the user no longer wants. An open that is being started is
 * stopped first, and waited for: only when it is over is what the library
 * says of it the last word. Resolves to 'gone' (nothing was opened, and
 * nothing of it is left), 'signed' (its funding transaction is signed, and
 * it stays) or 'busy' (it could not be stopped in time; the loop drops it,
 * or keeps it, once it is over).
 */
async function dropOpen(host, id) {
	const { mem } = host;
	mem.dropping.add(id);
	let gone = await giveUp(host, id);
	const task = mem.opens.get(id);
	if (task) {
		task.stop();
		const over = await within(
			task.run.then(
				() => true,
				() => true
			),
			host.cfg.openWaitMs
		);
		gone = over ? await giveUp(host, id) : null;
	}
	if (gone === null) return 'busy';
	mem.dropping.delete(id);
	if (!gone) return 'signed';
	await forgetOpen(host, id);
	letGo(host, id);
	await noteChannels(host);
	return 'gone';
}

/** `promise`, or null when it has not settled within `ms`. */
function within(promise, ms) {
	let timer = null;
	const late = new Promise((resolve) => {
		timer = setTimeout(() => resolve(null), Math.max(0, ms));
		if (typeof timer.unref === 'function') timer.unref();
	});
	return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

async function openChannel(host, body, key) {
	const route = 'channels/open';
	const first = await host.lock.run(() => {
		if (!key) {
			requireFull(host);
			throw keyRequired('open two channels');
		}
		const done = ops.replay(host, route, key, body);
		if (done) return done;
		requireFull(host);
		host.requireReady();
		return null;
	});
	if (first) return first;
	if (!host.mem.channelWords) await noteChannels(host);
	const peer = readPeer(body.peer);
	const feeRate = await host.feeRate(body.feeRate);
	const plan = await planOpen(host, body, feeRate);
	if (!plan.sufficient) {
		throw refusal('INSUFFICIENT_BTC', 'This wallet does not have the bitcoin on-chain that opening this channel needs.', 409, {
			needed: plan.totalSats,
			spendable: plan.spendableSats,
			feeSats: plan.feeSats
		});
	}
	// The peer is asked before anything is written or spent.
	try {
		await host.ln.connect({ pubkey: peer.pubkey, host: peer.host || undefined, port: peer.port || undefined });
	} catch (err) {
		if (isFenced(err)) throw err;
		throw refusal('PEER_UNREACHABLE', 'The peer could not be reached, so nothing was opened and nothing was spent. Check its address, and that it is online.', 502);
	}
	// Whose refusal it is decides what is said: the peer's, or this node's own.
	const no = host.ln.peerRefusal(peer.pubkey);
	if (no) {
		if (no.code === 'ERR_BEIGNET_LN_MODE_UNAVAILABLE') throw modeUnavailable(no.reason);
		if (no.code === 'ERR_BEIGNET_LN_PEER_OFFLINE') {
			throw refusal('PEER_UNREACHABLE', 'The peer could not be reached, so nothing was opened and nothing was spent. Check its address, and that it is online.', 502);
		}
		throw refusal('PEER_NO_ASSET_CHANNELS', 'That peer does not open asset channels, so nothing was opened and nothing was spent.', 409);
	}
	await publishProvenance(host, plan);

	const id = crypto.randomBytes(32).toString('hex');
	const answer = { pendingChannelId: id, phase: 'funding' };
	const again = await host.lock.run(() => {
		const done = ops.replay(host, route, key, body);
		if (done) return done;
		requireFull(host);
		host.requireReady();
		host.rows.tx(() => {
			host.rows.put(`committed/funding:${id}`, { kind: 'funding', at: host.now() });
			ops.journal(host, route, key, body, { answer });
			host.rows.put(`chan/${id}`, {
				id,
				initiator: true,
				// Until the host has seen it past its point of no return (noteChannels).
				stage: 'asked',
				peerPubkey: peer.pubkey,
				peerAlias: peer.alias,
				host: peer.host,
				port: peer.port,
				key: plan.key,
				assetId: plan.reg.assetId,
				groupKey: plan.groupKey,
				amount: plan.amount.toString(),
				assets: plan.assets,
				decimalDisplay: Number.isInteger(plan.reg.decimalDisplay) ? plan.reg.decimalDisplay : 0,
				fundingSats: plan.channelSats,
				pushSats: plan.pushSats,
				feeRate,
				maxFeeSats: host.cfg.limits.maxFeeSats,
				journal: key ? ops.journalKey(route, key) : null,
				createdAt: host.now(),
				channelId: null,
				closedAt: null
			});
		});
		return null;
	});
	if (again) return again;
	await noteChannels(host);
	// The open itself, with the lock let go. A peer that says no within a
	// few seconds is this request's answer; a slower open is the loop's.
	const early = await within(startOpen(host, id), host.cfg.openWaitMs);
	if (early && early.error) throw early.error;
	if (early && early.stopped) throw openCancelled();
	return answer;
}

/**
 * A close refused because the channel's funding transaction is not on
 * chain: there is nothing on chain to close. An open this wallet funded
 * says what can be done instead. One a peer began ends by itself.
 */
function notFunded(c) {
	return refusal(
		'CHANNEL_NOT_FUNDED',
		c.reclaimable
			? 'The funding transaction of this channel is not on chain yet, so there is nothing on chain to close and nothing was done. The channel can be closed once that transaction has confirmed. If it will not confirm, its bitcoin can be taken back instead, which ends the open.'
			: 'The funding transaction of this channel is not on chain, so there is nothing on chain to close and nothing was done. An open that does not go through ends by itself, and the channel then goes from the list.',
		409,
		c.reclaimable ? { reclaimable: true } : undefined
	);
}

async function closeChannel(host, body) {
	requireProvider(host);
	const wanted = hexKey(body.channelId);
	const force = !!body.force;
	const c = isId(wanted) ? channelList(host).find((x) => x.id === wanted || x.channelId === wanted) : null;
	if (!c || c.over) throw refusal('CHANNEL_NOT_FOUND', 'This wallet has no asset channel with that id.', 404);
	if (!host.mem.channelWords) await noteChannels(host);
	if (c.missing) {
		throw refusal('CHANNEL_MISSING', "This channel is on record, but the wallet's node does not hold it, as happens after a restore from a backup. It cannot be closed from this wallet.", 409);
	}
	if (!c.channelId) {
		// Not a channel yet. Once its funding transaction is signed it will be
		// one, and can be closed when it is. Before that the open is dropped.
		if (c.signed) throw openSigned(c);
		const how = await dropOpen(host, c.id);
		// The library would not give it up: past its point of no return by
		// now, or the node holds its funding transaction and waits for the peer.
		if (how === 'signed') throw openSigned(channelList(host).find((x) => x.id === c.id) || c);
		if (how === 'busy') throw refusal('CHANNEL_OPENING', 'This channel is still being opened, and the open could not be stopped yet. Try again in a moment.', 409);
		return { channelId: c.id, closing: true, force };
	}
	// A force close spends the funding transaction, and this one is on no
	// chain. Nor is there a close with the peer for an open the node gave up.
	if (c.unfunded && (force || c.gaveUp)) throw notFunded(c);
	if (!force) {
		// Neither would work, and the library's own no to them is not one a
		// person can act on: said here, before anything is asked of the peer.
		if (views.CHANNEL_NO_COOPERATIVE.includes(c.word)) {
			throw refusal('CHANNEL_ERRORED', 'This channel has failed and can no longer be closed together with its peer. Force close it to bring what is in it back on-chain.', 409);
		}
		if (c.peerConnected === false) {
			throw refusal(
				'PEER_OFFLINE',
				`The peer of this channel, ${peerSaid(c)}, is not connected, and a channel is closed together with its peer only while it is. Try again once it is back${c.unfunded ? '' : ', or force close the channel'}.`,
				409,
				{ peerPubkey: c.peerPubkey, peerAlias: c.peerAlias || null }
			);
		}
	}
	try {
		await host.ln.closeChannel({ channelId: c.channelId, force });
	} catch (err) {
		if (isFenced(err)) throw err;
		const mapped = mapLightning(err);
		if (mapped) throw mapped;
		host.say('warn', `assets: a channel could not be closed: ${plainMessage(err)}`);
		throw refusal('CHANNEL_CLOSE_FAILED', 'The channel could not be closed. Try again in a moment.', 502);
	}
	await noteChannels(host);
	host.nudge();
	return { channelId: c.channelId, closing: true, force };
}

/**
 * Take back the bitcoin of a channel funding that will not confirm: the
 * library publishes a spend of the funding transaction's own Bitcoin inputs
 * back to the wallet, so that the two conflict. Nothing is released by it.
 * Whichever of the two is buried decides: the loop ends the open and frees
 * what it set aside once the spend is, and carries the channel on as if
 * nothing had been asked if the funding confirms after all.
 *
 * The request key is written down before the library is asked, so the same
 * key never asks twice, also across a restart: a key whose first try did
 * not come back answers with no `txid`, and the channel list says the rest.
 * A try the library refuses, or that fails, frees the key again. A second
 * spend of the same inputs could at worst conflict with the first.
 */
async function reclaimFunding(host, body, key) {
	const route = 'channels/reclaim';
	const wantedId = hexKey(body.channelId);
	const begin = () => {
		const done = ops.replay(host, route, key, body);
		if (done) return done;
		requireProvider(host);
		host.requireReady();
		return null;
	};
	const first = await host.lock.run(() => {
		if (!key) {
			requireProvider(host);
			throw keyRequired('take the same funding back twice');
		}
		return begin();
	});
	if (first) return first;
	if (!host.mem.channelWords) await noteChannels(host);
	const c = isId(wantedId) ? channelList(host).find((x) => x.id === wantedId || x.channelId === wantedId) : null;
	if (!c || c.over) throw refusal('CHANNEL_NOT_FOUND', 'This wallet has no asset channel with that id.', 404);
	if (!c.reclaimable) {
		throw refusal(
			'CHANNEL_NOT_RECLAIMABLE',
			c.usable || (c.known && c.word !== 'OPENING' && !c.opening)
				? 'The funding of this channel is on the chain, so there is nothing to take back. Close the channel instead.'
				: 'The funding of this channel cannot be taken back. That can be done only for a channel this wallet is opening with its own bitcoin, once its funding transaction is made and while it has not confirmed.',
			409
		);
	}
	const feeRate = await host.feeRate(body.feeRate);
	const answer = { channelId: c.channelId || c.id, pendingChannelId: c.id, txid: null, feeSats: null, feeRate };
	const again = await host.lock.run(() => {
		const done = begin();
		if (done) return done;
		ops.journal(host, route, key, body, { answer });
		return null;
	});
	if (again) return again;
	let made = null;
	try {
		made = await host.ln.reclaimFunding({ pendingChannelId: c.id, feeRate });
	} catch (err) {
		if (isFenced(err)) throw err;
		await host.lock.run(() => host.rows.del(ops.journalKey(route, key)));
		const mapped = mapLightning(err);
		if (mapped) throw mapped;
		host.say('warn', `assets: the funding of a channel (${c.id}) could not be taken back: ${plainMessage(err)}`);
		// What the library refuses before it makes anything, in its own code.
		if (codeOf(err) === 'ERR_BEIGNET_LN_FUNDING') {
			throw refusal(
				'CHANNEL_NOT_RECLAIMABLE',
				"The funding of this channel cannot be taken back: it has confirmed, the open is over, or none of this wallet's own bitcoin went into it. Nothing was spent.",
				409
			);
		}
		throw refusal(
			'CHANNEL_RECLAIM_FAILED',
			'The transaction that takes the funding back could not be made or sent. If the funding transaction is already on the network, it takes a fee rate above the one that transaction pays.',
			502
		);
	}
	const done = { ...answer, txid: made.txid, feeSats: made.feeSats };
	await host.lock.run(() =>
		host.rows.tx(() => {
			ops.journal(host, route, key, body, { answer: done });
			const note = host.rows.get(`chan/${c.id}`);
			if (note) host.rows.put(`chan/${c.id}`, { ...note, reclaim: { txid: made.txid, feeSats: made.feeSats, feeRate, at: host.now() } });
		})
	);
	host.say('info', `assets: the funding of a channel (${c.id}) is being taken back in transaction ${made.txid}`);
	host.markDirty();
	// The channel's row changed, though its state did not.
	host.emitEvent('channel', { channelId: done.channelId, state: c.word });
	host.nudge();
	return done;
}

/* ------------------------------------------------------------------ prices */

function knownAsset(host, wanted) {
	const key = hexKey(wanted);
	let reg = key ? host.known(key) : null;
	// An asset this wallet's own records do not name by that key, such as a
	// group it holds only in a channel a peer opened, is known by the
	// channel that carries it: the channel says its asset ID and its group.
	if (!reg && key) {
		const c = channelList(host).find((x) => x.key === key || x.groupKey === key || x.assetId === key);
		if (c) reg = { ...(host.registry().get(c.assetId) || {}), assetId: c.assetId, groupKey: c.groupKey || null };
	}
	if (!reg) throw refusal('ASSET_NOT_FOUND', 'This wallet does not know that asset.', 404);
	return { reg, key: reg.groupKey || reg.assetId };
}

/** The figures of a price, as both quotes and an invoice carry them. */
function priceFields(reg, amountMsat, rate, said = true) {
	// No price at all when the library says the peer set none, and when the
	// rate is the nominal one whatever the library says.
	const priced = said !== false && !views.isNominal(rate);
	return { amountSats: views.satsOf(amountMsat), rateText: priced ? views.rateText(reg, rate) : '', priced };
}

/** What a Lightning refusal of the library says, with what only the host knows. */
function lightningError(host, err, details) {
	if (isFenced(err)) return err;
	const mapped = mapLightning(err, details ? { details } : {});
	if (!mapped) {
		// Nothing the host has words for. What the library wrote is logged.
		host.say('warn', `assets: a Lightning request failed: ${plainMessage(err)}`);
		return refusal('LIGHTNING_FAILED', 'Lightning could not do that just now. Try again in a moment.', 502);
	}
	// Only those whose figures the dashboard words carry them: the two that
	// are about a channel's balance, and bitcoin on the wrong address types.
	if (!['INSUFFICIENT_OUTBOUND', 'INSUFFICIENT_INBOUND', 'FUNDING_INPUTS', 'PEER_OFFLINE', 'CHANNEL_MODE_UNAVAILABLE', 'OUTCOMES_UNDELIVERED', 'CHANNEL_PAYMENTS_FULL'].includes(mapped.extensionCode)) delete mapped.details;
	return mapped;
}

/** A channel's peer as a person is told of it: the name the user gave it, or its key cut short. */
const peerSaid = (c) => c.peerAlias || `${String(c.peerPubkey).slice(0, 8)}\u2026${String(c.peerPubkey).slice(-6)}`;

/**
 * The channel of an asset that could carry `units` one way were its peer
 * there, and cannot now for that reason alone: the one that could carry
 * the most. Null when there is none, which leaves the amount as the reason.
 */
function awayChannel(host, key, side, units) {
	const idle = channelList(host).filter((c) => c.key === key && c.away && c[side] >= units && c[side] > 0n);
	return idle.sort((a, b) => (b[side] > a[side] ? 1 : b[side] < a[side] ? -1 : 0))[0] || null;
}

/**
 * The refusal for `units` of `key` that a channel with its peer there holds
 * and cannot move for want of bitcoin on the side that pays: this wallet's
 * for a payment ('send'), the peer's for an invoice ('receive'). The same
 * sentence the library's own refusal gets. Null when that is not why.
 */
function bitcoinShort(host, key, way, units) {
	const side = way === 'send' ? 'heldOut' : 'heldIn';
	if (!channelList(host).some((c) => c.key === key && c[side] >= units && c[side] > 0n)) return null;
	const [code, message, status] = LIGHTNING_REFUSALS[way === 'send' ? 'ERR_BEIGNET_LN_CARRIER_UNFUNDED' : 'ERR_BEIGNET_LN_PEER_CARRIER_UNFUNDED'];
	return refusal(code, message, status);
}

/**
 * A price refused because the peer of the channel it would go through is
 * not connected, with the peer named. `c` is that channel, or null where
 * only the library knows which. `way` is what was asked: a price to pay
 * at ('pay'), a payment at a price already given ('send'), or an invoice.
 */
function peerOffline(c, way) {
	const through = way === 'pay' || way === 'send' ? 'this would be paid through' : 'this would be received through';
	const so = way === 'pay' ? 'so nothing was priced and nothing was paid' : way === 'send' ? 'so nothing was paid' : 'so no invoice was made';
	return refusal(
		'PEER_OFFLINE',
		`The peer of the asset channel ${through}${c ? `, ${peerSaid(c)},` : ''} is not connected, ${so}. Try again once it is back.`,
		409,
		c ? { peerPubkey: c.peerPubkey, peerAlias: c.peerAlias || null } : undefined
	);
}

/** Drop the prices that have run out. The caller holds the lock. */
function dropOldQuotes(host) {
	const now = host.now();
	for (const { key, value } of host.rows.list('l-quote/')) if (!value || (value.expiresAt || 0) <= now) host.rows.del(key);
}

/* ---------------------------------------------------------------- invoices */

async function invoiceQuote(host, body) {
	requireFull(host);
	const amount = ops.parseUnits(body.amount);
	const { reg, key } = knownAsset(host, body.key);
	// A payment arrives through one channel: the most that can be received
	// is the most any one of them has on the peer's side.
	const limit = paymentLimits(host).get(key);
	const best = limit ? limit.receive : null;
	const maxReceivable = best ? limit.maxReceive : 0n;
	const short = () => refusal('INSUFFICIENT_INBOUND', 'No asset channel of this wallet can receive that much.', 409, { maxReceivable: maxReceivable.toString() });
	if (amount > maxReceivable) {
		// A channel that could take it with its peer there: not the amount's fault.
		const idle = awayChannel(host, key, 'couldReceive', amount);
		throw idle ? peerOffline(idle, 'receive') : bitcoinShort(host, key, 'receive', amount) || short();
	}
	let quoted;
	try {
		// The price is asked to stand as long as an invoice may live. The peer may give less.
		quoted = await host.ln.quoteInvoice({ assetId: best.assetId, groupKey: best.groupKey, amount, peerPubkey: best.peerPubkey, expirySeconds: INVOICE_SECONDS });
	} catch (err) {
		// The library saw the peer go after the host's list was read.
		if (codeOf(err) === 'ERR_BEIGNET_LN_PEER_OFFLINE') throw peerOffline(awayChannel(host, key, 'couldReceive', amount) || best, 'receive');
		throw lightningError(host, err, { maxReceivable: maxReceivable.toString() });
	}
	const price = priceFields(reg, quoted.amountMsat, quoted.unitsPerBtc, quoted.priced);
	const quote = {
		kind: 'receive',
		quoteId: quoted.quoteId,
		key,
		amount: amount.toString(),
		peerPubkey: quoted.peerPubkey,
		peerAlias: best.peerAlias || null,
		...price,
		expiresAt: quoted.expiresAt
	};
	await host.lock.run(() => {
		dropOldQuotes(host);
		host.rows.put(`l-quote/${quote.quoteId}`, quote);
	});
	return {
		quoteId: quote.quoteId,
		peerPubkey: quote.peerPubkey,
		peerAlias: quote.peerAlias,
		assetAmount: quote.amount,
		amountSats: quote.amountSats,
		rateText: quote.rateText,
		priced: quote.priced,
		expiresAt: quote.expiresAt,
		maxReceivable: maxReceivable.toString()
	};
}

const quoteExpired = () => refusal('QUOTE_EXPIRED', 'That price has expired. Ask for a new one.', 410);

/** An invoice as the list and the answer that made it give it. */
function invoiceView(host, inv) {
	const deadline = Math.min(...[inv.expiresAt, inv.invoiceExpiresAt].filter((t) => Number.isFinite(t) && t > 0), Infinity);
	return {
		bolt11: inv.bolt11,
		paymentHash: inv.paymentHash,
		assetAmount: inv.assetAmount,
		amountSats: inv.amountSats,
		rateText: inv.rateText,
		priced: inv.priced,
		expiresAt: inv.expiresAt,
		invoiceExpiresAt: inv.invoiceExpiresAt,
		description: inv.description,
		asset: inv.asset,
		status: inv.status === 'PAID' ? 'PAID' : deadline <= host.now() ? 'EXPIRED' : 'OPEN',
		// What a paid invoice brought in. A payer's rate can round it one
		// unit under what was invoiced, which `assetAmount` goes on saying.
		receivedAmount: inv.status === 'PAID' ? inv.receivedAmount || inv.assetAmount : null,
		createdAt: inv.createdAt
	};
}

async function createInvoice(host, body) {
	requireFull(host);
	const quoteId = hexKey(body.quoteId);
	const description = body.description === undefined || body.description === null ? '' : String(body.description).trim();
	if (description.length > MAX_DESCRIPTION) throw refusal('INVALID_PARAMS', `A description can be up to ${MAX_DESCRIPTION} characters.`);
	const quote = isId(quoteId) ? host.rows.get(`l-quote/${quoteId}`) : null;
	// A price is for one asset and one amount. Asked to use it for another, it has run out.
	const same =
		!!quote &&
		quote.kind === 'receive' &&
		quote.expiresAt > host.now() &&
		(body.key === undefined || body.key === null || hexKey(body.key) === quote.key) &&
		(body.amount === undefined || body.amount === null || String(body.amount).trim() === quote.amount);
	if (!same) throw quoteExpired();
	const { reg } = knownAsset(host, quote.key);
	// The peer of the channel may have gone since the price was given. That
	// is said as it is for a price, with the peer named, and not as an
	// amount no channel can receive. The price is kept for when it is back.
	const away = () => {
		const units = ops.parseUnits(quote.amount);
		const limit = paymentLimits(host).get(quote.key);
		return units > (limit ? limit.maxReceive : 0n) ? awayChannel(host, quote.key, 'couldReceive', units) : null;
	};
	const idle = away();
	if (idle) throw peerOffline(idle, 'receive');
	let made;
	try {
		// The invoice lives no longer than the price it is made on: paid after
		// that, the peer would no longer convert at it.
		const left = Math.ceil((quote.expiresAt - host.now()) / 1000);
		made = await host.ln.createInvoice({ quoteId, description, expirySeconds: Math.max(1, Math.min(INVOICE_SECONDS, left)) });
	} catch (err) {
		// The library saw the peer go after the host's list was read.
		const late = away();
		if (late) throw peerOffline(late, 'receive');
		throw lightningError(host, err);
	}
	const now = host.now();
	const invoice = {
		bolt11: made.bolt11,
		paymentHash: made.paymentHash,
		key: quote.key,
		assetAmount: quote.amount,
		amountSats: quote.amountSats,
		rateText: quote.rateText,
		priced: quote.priced,
		expiresAt: quote.expiresAt,
		invoiceExpiresAt: made.expiresAt,
		description,
		asset: views.brief(reg),
		status: 'OPEN',
		createdAt: now
	};
	const row = views.newRow({
		id: `ln-receive-${made.paymentHash}`,
		kind: 'ln-receive',
		ref: made.paymentHash,
		created: now,
		state: 'waiting',
		assets: [views.brief(reg, quote.amount)],
		paymentHash: made.paymentHash,
		// It can be paid until the price or the invoice runs out, whichever is first.
		expiresAt: Math.min(quote.expiresAt, made.expiresAt)
	});
	await host.lock.run(() =>
		host.rows.tx(() => {
			host.rows.put(`row/${row.id}`, row);
			host.rows.put(`inv/${made.paymentHash}`, invoice);
			host.rows.del(`l-quote/${quoteId}`);
		})
	);
	host.markDirty();
	host.emitRow(row);
	return { ...invoiceView(host, invoice), row: host.view(row) };
}

function listInvoices(host) {
	host.requireUp();
	if (modeOf(host) !== 'full') throw whyOff(host);
	const all = host.rows
		.list('inv/')
		.map((r) => r.value)
		.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
	return { invoices: all.slice(0, MAX_INVOICES_LISTED).map((inv) => invoiceView(host, inv)) };
}

/**
 * An invoice was paid, or ran out unpaid. That it was paid is the node's
 * word and wins at any time, also over a row that already says nobody
 * paid: a payment can arrive as the invoice runs out. `received` is what
 * arrived, which is what the row then counts: the amount invoiced stays on
 * the invoice.
 */
function recordInvoice(host, rowId, outcome, received) {
	const { rows } = host;
	return host.lock.run(() => {
		const row = host.getRow(rowId);
		if (!row || row.kind !== 'ln-receive' || row.state === 'complete') return null;
		if (outcome !== 'paid' && row.state !== 'waiting') return null;
		const next = clone(row);
		const now = host.now();
		const inv = rows.get(`inv/${row.paymentHash}`);
		if (outcome === 'paid') {
			next.state = 'complete';
			next.failure = null;
			next.at.completed = now;
			if (received !== undefined && received !== null && next.assets[0]) next.assets[0].amount = received.toString();
		} else {
			next.state = 'failed';
			next.failure = { code: 'INVOICE_EXPIRED', message: 'Nobody paid this invoice before it ran out.' };
		}
		rows.tx(() => {
			rows.put(`row/${rowId}`, next);
			if (inv && outcome === 'paid') {
				rows.put(`inv/${row.paymentHash}`, { ...inv, status: 'PAID', paidAt: now, ...(received !== undefined && received !== null ? { receivedAmount: received.toString() } : {}) });
			}
		});
		host.markDirty();
		host.emitRow(next);
		if (outcome === 'paid') for (const a of next.assets || []) host.emitEvent('balance', { key: a.key });
		return next;
	});
}

/* ------------------------------------------------------------------ paying */

const quoteChanged = (quote) =>
	refusal('QUOTE_CHANGED', 'The price moved before the payment was made, so nothing was paid.', 409, quote ? { quote } : undefined);

const payQuoteView = (q) => ({
	quoteId: q.quoteId,
	assetAmount: q.assetAmount,
	amountSats: q.amountSats,
	rateText: q.rateText,
	priced: q.priced,
	peerAlias: q.peerAlias,
	expiresAt: q.expiresAt,
	sendable: q.sendable
});

const cleanInvoice = (text) =>
	String(text || '')
		.trim()
		.replace(/^lightning:/i, '');

/**
 * The channel a payment at this price would leave through whose peer is
 * away, or null when a channel that is usable now can carry it. A price
 * taken while the peer was there is still good when it is back.
 */
function awayForPayment(host, quote) {
	const units = BigInt(quote.assetAmount);
	const limit = paymentLimits(host).get(quote.key);
	return units > (limit ? limit.maxSend : 0n) ? awayChannel(host, quote.key, 'couldSend', units) : null;
}

/** Ask the channel's peer what paying an invoice takes, and keep the answer until it is used or runs out. */
async function makePayQuote(host, body) {
	const bolt11 = cleanInvoice(body.bolt11);
	if (!bolt11) throw refusal('BAD_INVOICE', 'That is not a Lightning invoice this wallet can read.', 400);
	const { reg, key } = knownAsset(host, body.key);
	let amountMsat = null;
	let asked = null;
	if (body.amountSats !== undefined && body.amountSats !== null && body.amountSats !== '') {
		asked = Number(body.amountSats);
		if (!Number.isSafeInteger(asked) || asked <= 0) throw refusal('INVALID_PARAMS', 'The amount to pay must be a whole number of sats above zero.');
		amountMsat = BigInt(asked) * 1000n;
	}
	const usable = channelList(host).filter((c) => c.key === key && c.usable);
	// A payment leaves through one channel: the most that can be paid is
	// the most any one of them can send.
	const limit = paymentLimits(host).get(key);
	const most = limit ? limit.maxSend : 0n;
	const short = () => refusal('INSUFFICIENT_OUTBOUND', 'No asset channel of this wallet can send that much.', 409, { sendable: most.toString() });
	// Nothing can be sent now, and a channel could send were its peer there.
	const idle = (units) => awayChannel(host, key, 'couldSend', units);
	if (most === 0n) throw idle(1n) ? peerOffline(idle(1n), 'pay') : bitcoinShort(host, key, 'send', 1n) || short();
	let quoted;
	try {
		quoted = await host.ln.quotePayment({ bolt11, assetId: reg.assetId, groupKey: reg.groupKey || null, amountMsat });
	} catch (err) {
		// The library saw the peer go after the host's list was read.
		if (codeOf(err) === 'ERR_BEIGNET_LN_PEER_OFFLINE') throw peerOffline(idle(1n) || limit.send, 'pay');
		throw lightningError(host, err, { sendable: most.toString() });
	}
	const through = usable.find((c) => c.channelId === quoted.channelId) || null;
	if (quoted.assetAmount > (through && through.sendable < most ? through.sendable : most)) {
		throw idle(quoted.assetAmount) ? peerOffline(idle(quoted.assetAmount), 'pay') : short();
	}
	const quote = {
		kind: 'pay',
		quoteId: quoted.quoteId,
		key,
		invoice: sha256Hex(bolt11),
		paymentHash: quoted.paymentHash,
		assetAmount: quoted.assetAmount.toString(),
		...priceFields(reg, quoted.amountMsat, quoted.unitsPerBtc, quoted.priced),
		asked,
		peerPubkey: quoted.peerPubkey,
		peerAlias: through ? through.peerAlias : null,
		channelId: quoted.channelId,
		expiresAt: quoted.expiresAt,
		// What one payment can send, whichever channel this one goes through.
		sendable: most.toString()
	};
	await host.lock.run(() => {
		dropOldQuotes(host);
		host.rows.put(`l-quote/${quote.quoteId}`, quote);
	});
	return quote;
}

async function payQuote(host, body) {
	requireFull(host);
	return payQuoteView(await makePayQuote(host, body));
}

/** A payment as `POST /pay` answers it, from its row or the row's view. */
const payAnswer = (row) => ({
	status: row.state === 'complete' ? 'COMPLETED' : row.state === 'failed' ? 'FAILED' : 'PENDING',
	paymentHash: row.paymentHash,
	assetAmount: row.assets && row.assets[0] ? row.assets[0].amount : null,
	feeSats: row.feeSats === undefined ? null : row.feeSats,
	failureDescription: row.failure ? row.failure.message : null,
	...(row.notice ? { notice: row.notice } : {})
});

// What a payment's row says while the node cannot say how it ended, or did
// not confirm what it sent. Neither is a failure, and neither ends the row.
const PAYMENT_UNACCOUNTED = {
	code: 'PAYMENT_UNACCOUNTED',
	message: 'The node no longer has a record of this payment, so how it ended cannot be known. It may have been paid. This wallet will not pay the invoice again.'
};
const PAYMENT_UNCONFIRMED = {
	code: 'PAYMENT_UNCONFIRMED',
	message: 'The node took this payment without confirming that it went out as an asset payment. It ends as the node reports, and its units are not known to have left the channel.'
};

/**
 * Whether the library's record `seen` speaks of the try that `row` stands
 * for. The record of a payment hash is that of its latest try, numbered
 * from 1, and a try the library refuses leaves the record of the one before
 * as it was. So a record numbered no higher than what stood when this row
 * was written says nothing of this row. A record or a row that names no try
 * cannot be told apart that way, and is taken as before.
 */
const ofThisTry = (row, seen) => !!seen && (seen.attempt === null || seen.attempt === undefined || !Number.isInteger(row.attemptBefore) || seen.attempt > row.attemptBefore);

const keyRequired = (so) => refusal('IDEMPOTENCY_KEY_REQUIRED', `This request needs an X-Idempotency-Key header, so that sending it twice does not ${so}.`, 400);

/** The node's record of a payment: the record, null when it has none, undefined when it cannot be asked now. */
function lookAtPayment(host, paymentHash) {
	try {
		return host.ln.payment(paymentHash) || null;
	} catch (err) {
		if (isFenced(err)) throw err;
		return undefined;
	}
}

/**
 * Bring a payment's row to what the node's own record of it says. That
 * record is the only word on how a payment ended: nothing else writes
 * `complete`, and nothing else writes a failure the node did not report.
 * `seen` is the record. With none, `handed` says the library took the
 * payment, which is all that is then written. `own` is for the request that
 * began the payment: the loop leaves a row alone while one has it.
 */
function recordPayment(host, rowId, seen, { handed = false, own = false } = {}) {
	return host.lock.run(() => {
		const row = host.getRow(rowId);
		if (!row || row.kind !== 'ln-send') return row;
		if (!own && host.mem.paying.has(rowId)) return row;
		// What the node said is final. What the host concluded itself is not.
		if (row.state === 'complete' || (row.state === 'failed' && !row.assumed)) return row;
		if (seen && !ofThisTry(row, seen)) {
			// The record of an earlier try says nothing of how this one ended.
			// That it is still the latest does say one thing: the library
			// never recorded this try, so it never sent it. What the host had
			// concluded of it stands for good, in the host's own words.
			if (row.state === 'failed' && row.assumed && !handed) {
				const settled = clone(row);
				delete settled.assumed;
				host.rows.put(`row/${rowId}`, settled);
				return settled;
			}
			seen = null;
		}
		if (!seen && !handed) return row;
		const next = clone(row);
		const now = host.now();
		const numbered = !!seen && Number.isInteger(seen.attempt);
		if (numbered) next.attempt = seen.attempt;
		if (row.state === 'failed' && seen && seen.status === 'failed' && !numbered) {
			// The host had concluded as much, and a record that names no try
			// agrees: it may be that of an earlier try of the same invoice.
			// The host's own words for why this one failed stand.
			delete next.assumed;
			host.rows.put(`row/${rowId}`, next);
			return next;
		}
		delete next.assumed;
		next.sent = true;
		if (seen && seen.status === 'complete') {
			next.state = 'complete';
			next.failure = null;
			next.at.completed = now;
			if (seen.assetAmount !== null && seen.assetAmount !== undefined && next.assets[0]) next.assets[0].amount = seen.assetAmount.toString();
			next.feeSats = seen.feeMsat === null || seen.feeMsat === undefined ? 0 : views.satsOf(seen.feeMsat);
		} else if (seen && seen.status === 'failed') {
			const why = paymentFailure(seen.failure, { neverSent: seen.neverSent === true });
			if (!why.known && seen.failure) host.say('warn', `assets: a Lightning payment failed: ${plainMessage({ message: seen.failure })}`);
			next.state = 'failed';
			next.failure = { code: 'PAYMENT_FAILED', message: why.message };
			next.at.completed = now;
		} else {
			// In the node's hands, and not over.
			next.state = 'pending';
			next.failure = null;
			next.at.completed = null;
		}
		// Pending for good, as far as anything can say now: the node forgot
		// the payment. And, whatever became of it, a send the node never
		// confirmed as an asset payment.
		const notice = seen && seen.status === 'pending' && seen.lost ? PAYMENT_UNACCOUNTED : seen && seen.unconfirmed ? PAYMENT_UNCONFIRMED : null;
		if (notice) next.notice = { ...notice };
		else if (seen) delete next.notice;
		if (notice && !(row.notice && row.notice.code === notice.code)) host.say('warn', `assets: Lightning payment ${row.paymentHash}: ${notice.message}`);
		if (JSON.stringify(next) === JSON.stringify(row)) return row;
		host.rows.put(`row/${rowId}`, next);
		host.markDirty();
		host.emitRow(next);
		if (next.state !== 'pending') for (const a of next.assets || []) host.emitEvent('balance', { key: a.key });
		return next;
	});
}

/**
 * The host's own conclusion that a payment never left the wallet: the
 * library refused it before sending, or took no payment and the node has no
 * record of one. It is marked as a conclusion (`assumed`), and the loop
 * takes it back the moment the node turns out to have the payment after all.
 */
function failUnsent(host, rowId, failure, { own = false } = {}) {
	return host.lock.run(() => {
		const row = host.getRow(rowId);
		if (!row || row.kind !== 'ln-send' || row.state !== 'pending' || row.sent) return row;
		if (!own && host.mem.paying.has(rowId)) return row;
		const next = clone(row);
		next.state = 'failed';
		next.failure = failure;
		next.assumed = true;
		next.at.completed = host.now();
		host.rows.put(`row/${rowId}`, next);
		host.markDirty();
		host.emitRow(next);
		return next;
	});
}

/**
 * Hand a payment to the library and follow it until it is over or the
 * request has waited long enough. Runs with the lock let go, and goes on
 * after the request that began it has answered. Resolves to { row }, to
 * { changed, quote } when the price moved and nothing was paid, or to
 * { fenced } when the wallet is restarting.
 */
async function sendPayment(host, { row, quote, quoteId, bound, key, route, body, state }) {
	const started = Date.now();
	try {
		let handed = false;
		let error = null;
		try {
			await host.ln.payInvoice({ quoteId, maxAssetAmount: bound === null ? BigInt(quote.assetAmount) : bound });
			handed = true;
		} catch (err) {
			if (isFenced(err)) throw err;
			error = err;
		}
		let seen = lookAtPayment(host, quote.paymentHash);
		// The library names the rejections that mean nothing left the wallet.
		// After one there is no record of this try: none at all, or that of
		// an earlier try of the same invoice, which is a failure. A record of
		// this try is followed, whatever was thrown.
		const refused = !!error && host.ln.refusals.includes(codeOf(error));
		const earlier = !!seen && (Number.isInteger(seen.attempt) ? !ofThisTry(row, seen) : seen.status === 'failed');
		if (refused && (seen === null || earlier)) {
			// The library saw the peer go after the host's list was read, and
			// lists that among the rejections it makes before sending. Nothing
			// was sent, so this is no failed payment: it is said as the peer
			// being away, with the peer named, and the price is kept for when
			// it is back, as long as someone is waiting to hear it. From a
			// library that does not list it, the row waits for the node's record.
			if (codeOf(error) === PEER_AWAY) {
				const through =
					awayChannel(host, quote.key, 'couldSend', BigInt(quote.assetAmount)) || channelList(host).find((c) => c.key === quote.key && c.peerPubkey === quote.peerPubkey && !c.over) || null;
				const away = peerOffline(through, 'send');
				if (state.answered) return { row: await failUnsent(host, row.id, { code: away.extensionCode, message: away.message }, { own: true }) };
				await host.lock.run(() =>
					host.rows.tx(() => {
						host.rows.del(`row/${row.id}`);
						if (key) host.rows.del(ops.journalKey(route, key));
						if (quote.expiresAt > host.now()) host.rows.put(`l-quote/${quoteId}`, quote);
					})
				);
				return { away };
			}
			// A price that moved is shown again, as long as someone is still
			// waiting to see it.
			if (PRICE_MOVED.includes(codeOf(error)) && !state.answered) {
				await host.lock.run(() =>
					host.rows.tx(() => {
						host.rows.del(`row/${row.id}`);
						if (key) host.rows.del(ops.journalKey(route, key));
					})
				);
				let fresh = null;
				try {
					fresh = payQuoteView(await makePayQuote(host, { bolt11: body.bolt11, key: quote.key, amountSats: quote.asked || undefined }));
				} catch (again) {
					if (isFenced(again)) throw again;
				}
				return { changed: true, quote: fresh };
			}
			const mapped = mapLightning(error);
			if (!mapped) host.say('warn', `assets: a Lightning payment was not sent: ${plainMessage(error)}`);
			const failure = mapped ? { code: mapped.extensionCode, message: mapped.message } : { code: 'PAYMENT_NOT_SENT', message: 'This payment was not sent, so nothing was paid.' };
			return { row: await failUnsent(host, row.id, failure, { own: true }) };
		}
		// Anything else may have come after the node took the payment. Its
		// record says how it ended, now or on a later pass of the loop.
		if (error) host.say('warn', `assets: a Lightning payment was handed over and not confirmed: ${plainMessage(error)}`);
		if (seen && !ofThisTry(row, seen)) seen = null;
		let current = await recordPayment(host, row.id, seen || null, { handed, own: true });
		const deadline = started + host.cfg.payWaitMs;
		while ((handed || seen) && !(seen && seen.status !== 'pending') && !host.mem.stopped && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, PAY_POLL_MS));
			if (host.mem.stopped) break;
			const again = lookAtPayment(host, quote.paymentHash);
			// A service that cannot be asked has said nothing about the payment.
			if (again === undefined) break;
			if (again && ofThisTry(row, again)) seen = again;
			if (seen && seen.status !== 'pending') current = await recordPayment(host, row.id, seen, { own: true });
		}
		return { row: current || row };
	} catch (err) {
		if (isFenced(err)) {
			if (state.answered) host.shutdown();
			return { fenced: err };
		}
		// Whatever went wrong here says nothing about the payment: it stays pending.
		host.say('warn', `assets: a Lightning payment could not be followed: ${plainMessage(err)}`);
		return { row };
	} finally {
		host.mem.paying.delete(row.id);
		if (!host.mem.stopped) host.nudge();
	}
}

async function pay(host, body, key) {
	const route = 'pay';
	const quoteId = hexKey(body.quoteId);
	const bound = body.maxAssetAmount === undefined || body.maxAssetAmount === null || body.maxAssetAmount === '' ? null : ops.parseUnits(body.maxAssetAmount);
	const step = await host.lock.run(() => {
		if (!key) {
			requireFull(host);
			throw keyRequired('pay twice');
		}
		const done = ops.replay(host, route, key, body);
		if (done) return { done: payAnswer(done.row) };
		requireFull(host);
		const quote = isId(quoteId) ? host.rows.get(`l-quote/${quoteId}`) : null;
		const live =
			!!quote &&
			quote.kind === 'pay' &&
			quote.expiresAt > host.now() &&
			(body.key === undefined || body.key === null || hexKey(body.key) === quote.key) &&
			(!cleanInvoice(body.bolt11) || sha256Hex(cleanInvoice(body.bolt11)) === quote.invoice);
		// The price ran out: a new one is asked for, with the lock let go.
		if (!live) return { stale: quote && quote.kind === 'pay' ? quote : null };
		// The price is past what the user agreed to. It still stands, and is shown.
		if (bound !== null && BigInt(quote.assetAmount) > bound) return { moved: quote };
		const rowId = `ln-send-${quote.paymentHash}`;
		const prev = host.getRow(rowId);
		// What the node says became of this invoice comes before what the row
		// says: a row can say failed for a payment the node is still making.
		const seen = lookAtPayment(host, quote.paymentHash);
		if (seen === undefined) throw starting();
		if ((seen && seen.status === 'complete') || (prev && prev.state === 'complete')) throw refusal('ALREADY_PAID', 'This wallet has already paid that invoice.', 409);
		// Nothing can say how that one ended, so it may have been paid.
		if (seen && seen.status === 'pending' && seen.lost) throw refusal(PAYMENT_UNACCOUNTED.code, PAYMENT_UNACCOUNTED.message, 409);
		if ((seen && seen.status === 'pending') || (prev && prev.state === 'pending')) {
			throw refusal('PAYMENT_IN_FLIGHT', 'This wallet is already paying that invoice. Wait for it to finish.', 409);
		}
		// The peer of the channel may have gone since the price was given.
		// That is said before anything is sent or written, with the peer
		// named, and not as a payment that failed. The price and the key are
		// left as they were, for when the peer is back.
		const idle = awayForPayment(host, quote);
		if (idle) throw peerOffline(idle, 'send');
		const { reg } = knownAsset(host, quote.key);
		const row = views.newRow({
			id: rowId,
			kind: 'ln-send',
			ref: quote.paymentHash,
			created: host.now(),
			assets: [views.brief(reg, quote.assetAmount)],
			paymentHash: quote.paymentHash,
			clientRef: key || null,
			amountSats: quote.amountSats,
			peerPubkey: quote.peerPubkey,
			// The try the library's record stood for before this one: 0 with
			// no record. A record of this row's own try is numbered above it.
			attemptBefore: seen && Number.isInteger(seen.attempt) ? seen.attempt : 0
		});
		host.rows.tx(() => {
			ops.journal(host, route, key, body, { rowId });
			host.rows.put(`row/${rowId}`, row);
			host.rows.del(`l-quote/${quoteId}`);
		});
		// From here the loop leaves this row to this request, which tells of
		// it once the library has taken the payment or refused it.
		host.mem.paying.add(rowId);
		host.markDirty();
		return { row, quote };
	});
	if (step.done) return step.done;
	if (step.moved) throw quoteChanged(payQuoteView(step.moved));
	if (step.stale !== undefined) {
		const fresh = await makePayQuote(host, {
			bolt11: body.bolt11,
			key: body.key || (step.stale && step.stale.key),
			amountSats: step.stale && step.stale.asked ? step.stale.asked : undefined
		});
		throw quoteChanged(payQuoteView(fresh));
	}
	const { row, quote } = step;
	// The payment goes on whatever becomes of this request. The request
	// waits for its end for a while, and answers PENDING when it has to.
	const state = { answered: false };
	const sending = host.lock.outside(() => sendPayment(host, { row, quote, quoteId, bound, key, route, body, state }));
	const out = await within(sending, host.cfg.payWaitMs + 2 * PAY_POLL_MS);
	if (!out) {
		state.answered = true;
		return payAnswer(host.getRow(row.id) || row);
	}
	if (out.fenced) throw out.fenced;
	if (out.away) throw out.away;
	if (out.changed) throw quoteChanged(out.quote);
	return payAnswer(out.row);
}

/* -------------------------------------------------------------------- loop */

/**
 * Settle the payments and invoices whose end the node knows. A payment this
 * process is in the middle of is left to the request that began it.
 */
async function settleRows(host) {
	const ln = host.ln;
	const stored = host.listRows();
	for (const row of stored) {
		if (host.mem.stopped) return;
		if (row.kind !== 'ln-send' || host.mem.paying.has(row.id)) continue;
		// Pending, or failed by the host's own conclusion, which the node's
		// record overrules at any time.
		if (row.state !== 'pending' && !(row.state === 'failed' && row.assumed)) continue;
		const seen = lookAtPayment(host, row.paymentHash);
		// A service that cannot be asked has said nothing: every row stays as it is.
		if (seen === undefined) return;
		// The record of this try, or that of an earlier one for a row the
		// host has already concluded was never sent.
		if (seen && (ofThisTry(row, seen) || row.state === 'failed')) {
			await recordPayment(host, row.id, seen);
			continue;
		}
		// The node has no record of this try. A payment the library said it took is
		// the node's to answer for, and waits. One it never took, that nobody
		// is sending and that has had its time, never left.
		if (row.state === 'pending' && !row.sent && host.now() - (row.at.created || 0) >= UNSENT_AFTER_MS) {
			await failUnsent(host, row.id, { code: 'PAYMENT_NOT_SENT', message: 'This payment was never sent, so nothing was paid.' });
		}
	}
	// Every invoice that is not paid yet, the ones written down as run out
	// among them: the node saying one was paid is the last word on it.
	const unpaid = stored.filter((r) => r.kind === 'ln-receive' && r.state !== 'complete');
	if (unpaid.length === 0) return;
	const known = new Map(ln.invoices().map((i) => [i.paymentHash, i]));
	for (const row of unpaid) {
		if (host.mem.stopped) return;
		const inv = known.get(row.paymentHash);
		// What arrived, where the library says it: never nothing for an invoice it calls paid.
		if (inv && inv.status === 'paid') await recordInvoice(host, row.id, 'paid', inv.received !== null && inv.received > 0n ? inv.received : inv.assetAmount);
		else if (row.state === 'waiting' && ((inv && inv.status === 'expired') || (row.expiresAt || 0) <= host.now())) await recordInvoice(host, row.id, 'expired');
	}
}

/**
 * Once per generation, before anything is carried on: a funding flow the
 * library holds that no user confirmed, and that has signed nothing, is
 * cancelled. Resolves to false when one could not be: carried on, it could
 * sign, so nothing is carried on in that pass and the next one tries again.
 */
async function cancelUnasked(host) {
	const marks = host.markers();
	let clean = true;
	for (const c of host.ln.channels()) {
		if (host.mem.stopped) return false;
		if (!c.initiator || c.signed || FAILED_PHASES.includes(c.phase) || marks.has(`funding:${c.pendingChannelId}`)) continue;
		let gone = false;
		try {
			gone = !!(await host.ln.cancelFlow(c.pendingChannelId));
		} catch (err) {
			if (isFenced(err)) throw err;
			host.say('warn', `assets: a channel open nobody confirmed could not be cancelled: ${plainMessage(err)}`);
		}
		// Signed by now is the library's to carry on. Anything else is not.
		if (!gone && !host.ln.channels().some((x) => x.pendingChannelId === c.pendingChannelId && x.signed)) clean = false;
	}
	return clean;
}

/**
 * Every pass: the opens the user confirmed that no request and no earlier
 * pass is still working on. One that signed is kept, and the library
 * carries it on, unless the library has given its funding up as unable to
 * confirm: that open is over, and said. One that signed nothing and was
 * turned down or failed is undone, with its `error` event, and one the user
 * gave up is undone without a word, however the library lists it. One the
 * library is still negotiating is left alone, as long as the node holds the
 * channel being negotiated. `first` is the first look of a generation: an
 * open a restart interrupted before it signed is then opened again under
 * the same id, or undone when asset channels are off by now.
 *
 * All of it is read from the library's list, on every pass: an event that
 * never came, because the daemon stopped before it was sent, costs nothing.
 */
async function settleOpens(host, { first = false } = {}) {
	const { ln, rows, mem } = host;
	const flows = new Map(ln.channels().map((c) => [c.pendingChannelId, c]));
	const marks = host.markers();
	// What the user asked to be dropped and is no open any more.
	for (const id of [...mem.dropping]) if (!mem.opens.has(id) && !marks.has(`funding:${id}`)) mem.dropping.delete(id);
	for (const name of marks.keys()) {
		if (mem.stopped) return;
		if (!name.startsWith('funding:')) continue;
		const id = name.slice('funding:'.length);
		if (mem.opens.has(id)) continue;
		const flow = flows.get(id);
		const note = rows.get(`chan/${id}`);
		if (!note) {
			await host.lock.run(() => rows.del(`committed/${name}`));
			continue;
		}
		if (flow && isAbandoned(flow)) {
			await endAbandoned(host, id, note, flow);
			continue;
		}
		// The note alone says it was a channel only where it does not say the
		// open was merely asked for: the id the library answers with is given
		// before the peer has signed.
		const was = !!note.channelId && note.stage !== 'asked';
		const kept = was || (!!flow && (flow.signed || flow.confirmed || flow.phase === 'active'));
		if (mem.dropping.has(id)) {
			// A drop that could not be finished while the open was out.
			if (kept) mem.dropping.delete(id);
			else await undoOpen(host, id, new Error('the open was dropped'));
			continue;
		}
		// A channel, or about to be one: the library carries it on (resume).
		// One that got as far as a channel is never opened a second time,
		// whatever became of it since: the loop notes it as over.
		if (kept) continue;
		if (flow && isEnded(flow)) {
			// Dropped because the user asked, or turned down by the peer: undone
			// and forgotten, and said. Ended by the library itself (`failed`)
			// with nobody here opening it: what its resume() makes of an open a
			// restart interrupted. This host had answered for that open, so it
			// becomes a failed open with the library's reason.
			if (flow.cancelled) await undoOpen(host, id, cancelledError());
			else if (flow.phase === 'failed') await endFailed(host, id, note, flow);
			else await undoOpen(host, id, new Error(`the open ended as ${flow.phase}${flow.error ? ` (${flow.error})` : ''}`));
			continue;
		}
		// Answered by the library once, and not on its list now: cut short.
		if (!flow && note.channelId) {
			await endLost(host, id, note);
			continue;
		}
		if (modeOf(host) !== 'full') {
			await undoOpen(host, id, new Error('asset channels are off for this wallet'));
			continue;
		}
		if (first) {
			// A channel the node holds under the id, that the library does not
			// list, is not this host's to open a second time.
			if (!flow && host.ln.engineHolds([id]) !== false) {
				sayOnce(host, 'warn', `assets: a channel open a restart interrupted (${id}) is not opened again: the node holds a channel under its id, or could not be asked`);
				continue;
			}
			// Not waited for: the loop goes on, and the open reports through its note.
			startOpen(host, id, { reconnect: true });
			continue;
		}
		// Still being negotiated: left to the library, which carries it on for
		// as long as the node holds the channel the two are negotiating.
		if (flow && flow.engine !== 'missing') continue;
		if (flow) {
			await undoOpen(host, id, new Error('the node no longer holds the channel that was being negotiated'));
			continue;
		}
		// Nobody is opening it and the library has no record of it.
		if (host.now() - (note.createdAt || 0) >= OPEN_LOST_AFTER_MS) await endLost(host, id, note);
	}
}

/**
 * A confirmed open that the library does not list and nobody is opening:
 * what a daemon killed between the library's answer and its own record of
 * the open leaves. It is ended only once it cannot be an open whose funding
 * was published, which is asked of everything that could know, by the id
 * the open was given and by the id the library answered with:
 *
 *   the library's list, read again, since the one the pass began with is
 *   older than every wait since;
 *   the node itself, for a channel of any kind under either id;
 *   what the library said became of the funding's inputs, once it has
 *   been asked in this generation: kept (it has seen the funding
 *   transaction) and taken by the funding are both a no;
 *   the on-chain records, for anything still set aside under the open's
 *   name, spent or not;
 *   and last the library, which is told to give the open up and answers
 *   whether anything will still be opened under the id.
 *
 * Any of them holding anything leaves the open as it is, listed as on its
 * way, to be looked at on the next pass. With nothing anywhere, the open is
 * over and said: its note becomes a failed open, its marker goes, and its
 * request key answers the failure. In that order of care, said before it
 * is taken off the library's list.
 */
async function endLost(host, id, note) {
	const { mem, rows } = host;
	const ids = [id, note.channelId].filter(Boolean);
	const waits = (why) => sayOnce(host, 'warn', `assets: a channel open the library has no record of (${id}) is not ended: ${why}`);
	if (host.ln.channels().some((c) => ids.includes(c.pendingChannelId) || (!!c.channelId && ids.includes(c.channelId)))) return;
	const held = host.ln.engineHolds(ids);
	if (held !== false) return waits(held ? 'the node holds a channel under its id' : 'the node could not be asked for its channels');
	// Asked on every start, right after the opens are looked at: the next pass knows.
	if (!mem.lnReservations) return;
	const funding = mem.lnFundings.get(id);
	if (funding) return waits(funding === 'kept' ? 'the library keeps what its funding set aside' : 'the library says its funding took what was set aside');
	const name = `funding:${id}`;
	if ((await host.tap.stores.assets.listAssets()).some((r) => r.reservedBy === name)) return waits('what its funding set aside is still set aside in the on-chain records');
	if (mem.stopped || mem.opens.has(id)) return;
	if ((await giveUp(host, id)) !== true) return waits('the library would not give it up');
	await endOpen(
		host,
		id,
		note,
		failedOpen('CHANNEL_OPEN_INTERRUPTED'),
		{},
		(channelId) =>
			`assets: a channel open (${channelId}) was cut short before its funding was signed, and neither the library nor the node holds anything of it. It is ended, and can be asked for again.`
	);
}

/**
 * A confirmed open the library lists as ended with nothing signed, that
 * nobody here is opening: what its resume() makes of an open a restart
 * interrupted (the engine forgot it before the peer signed), with its
 * inputs released and its reason on the flow. The library is told to give
 * it up, which says whether anything will still be opened under the id,
 * and then the open is a failed open that carries the library's reason.
 */
async function endFailed(host, id, note, flow) {
	if (host.mem.stopped || host.mem.opens.has(id)) return;
	if ((await giveUp(host, id)) !== true) return;
	const why = reasonOf(flow.error);
	// The library's reason code for the flow it ended, where it names one.
	const because = flow.because || null;
	await endOpen(
		host,
		id,
		note,
		failedOpen('CHANNEL_OPEN_FAILED', { reason: why, because }),
		{ reason: why, because },
		(channelId) => `assets: a channel open (${channelId}) was ended by the library before its funding was signed${why ? `: ${why}` : ''}. Nothing left the wallet, and it can be asked for again.`
	);
}

/**
 * An open that is over with nothing signed becomes a failed open: its
 * marker goes, its note says why (the code, and the library's words and
 * reason code when it gave them), and the key that asked for it answers
 * the failure from now on, in the host's sentence. The library's words go
 * to the log (`line`) and to the row's detail, and nowhere else. Said,
 * announced, and only then taken off the library's list.
 */
async function endOpen(host, id, note, failure, { reason, because } = {}, line) {
	const { mem, rows } = host;
	const channelId = note.channelId || id;
	const done = await host.lock.run(() =>
		rows.tx(() => {
			const current = rows.get(`chan/${id}`);
			if (!current || current.closedAt || !rows.get(`committed/funding:${id}`)) return false;
			const at = host.now();
			rows.del(`committed/funding:${id}`);
			rows.put(`chan/${id}`, { ...current, closedAt: at, failed: { code: failure.code, at, ...(reason ? { reason } : {}), ...(because ? { because } : {}) } });
			// The key that asked for it answers what became of it from now on.
			const entry = current.journal ? rows.get(current.journal) : null;
			if (entry) rows.put(current.journal, { at: entry.at, body: entry.body, refusal: { code: failure.code, message: failure.message, status: 409 } });
			return true;
		})
	);
	if (!done) return;
	mem.dropping.delete(id);
	host.say('warn', line(channelId));
	host.emitEvent('error', { code: failure.code, message: failure.message, channelId });
	letGo(host, id);
	host.markDirty();
	await noteChannels(host);
}

const FUNDING_GIVEN_UP =
	'This channel was not opened. Its funding transaction can no longer confirm, because a coin it spends was spent by another transaction. What was set aside for the channel has been released.';

/**
 * The library gave a signed funding up: an input of it was spent by another
 * transaction, buried for good, so it can never confirm. The open is over.
 * It is said, in a sentence of the host's, and then forgotten, in that
 * order: said twice is better than never.
 */
async function endAbandoned(host, id, note, flow) {
	host.say('warn', `assets: the funding of a channel was given up (${note.channelId || id}): ${plainMessage({ message: flow.error || 'it can no longer confirm' })}`);
	host.emitEvent('error', { code: 'CHANNEL_FUNDING_FAILED', message: FUNDING_GIVEN_UP, channelId: note.channelId || id });
	await forgetOpen(host, id);
	letGo(host, id);
	await noteChannels(host);
}

/**
 * Take off the library's list the opens that are over and that the host has
 * nothing left to do for: its own once they are undone, and a peer's that
 * came to nothing. Asked once for each in a generation: an open the library
 * will not let go of yet is asked about again after the next start.
 */
function forgetEnded(host) {
	const { ln, rows, mem } = host;
	const marks = host.markers();
	for (const c of ln.channels()) {
		const id = c.pendingChannelId;
		if (!(isEnded(c) || isAbandoned(c)) || mem.forgetAsked.has(id)) continue;
		if (mem.opens.has(id) || mem.dropping.has(id) || marks.has(`funding:${id}`) || rows.get(`chan/${id}`)) continue;
		letGo(host, id);
	}
}

const unitsText = (list) => (list || []).map((a) => `${a.amount} of ${a.assetId}`).join(', ') || 'nothing';

/**
 * Settle what the funding of a channel left set aside in the on-chain
 * records when the library has no flow on record to do it: what a restore
 * from a backup leaves, since a backup carries no flows. Asked once after
 * each start and each restore, and then on every new block for as long as
 * the library keeps anything back, which it does for a funding transaction
 * it has seen and that is not buried yet.
 *
 * Released: the units are free again. Moved: the funding transaction took
 * them, and they are the channel's. What that transaction held as change
 * comes back with it, into the on-chain records: the library rebuilds the
 * transaction's outputs from what a backup carries of a signed funding.
 * The one case it cannot is a backup made before the funding was signed,
 * which carries nothing to rebuild them from. The change is then neither in
 * the on-chain records nor in a channel, so the host writes down what it
 * was (`l-change/<id>`), says so in its status, and stops saying so once a
 * record of that transaction's turns up. The rows a store already has from
 * before the library brought any change back are of that same kind, and are
 * read the same way: looked at after each start and on every new block.
 */
async function settleReservations(host, { block = false } = {}) {
	const { ln, rows, mem } = host;
	if (block || !mem.lnChangeLooked) {
		mem.lnChangeLooked = true;
		const lost = rows.list('l-change/');
		if (lost.length > 0) {
			const records = (await host.tap.stores.assets.listAssets()).filter(views.isLive);
			for (const { key, value } of lost) {
				const back =
					!!value &&
					!!value.fundingTxid &&
					(value.change || []).every((a) => records.some((r) => r.assetId === a.assetId && String(r.anchorOutPoint || '').startsWith(`${value.fundingTxid}:`)));
				if (back) await host.lock.run(() => rows.del(key));
			}
		}
	}
	if (mem.lnReservations === 'done' || (mem.lnReservations === 'kept' && !block)) return;
	const reports = await ln.settleFundingReservations();
	let kept = false;
	for (const r of reports) {
		const id = r.pendingChannelId || r.reservation;
		// Remembered by the open's id: an open is never ended as one that
		// came to nothing while its funding holds, or took, what was set aside.
		if (r.outcome === 'released') mem.lnFundings.delete(id);
		else mem.lnFundings.set(id, r.outcome === 'kept' ? 'kept' : 'moved');
		if (r.outcome === 'kept') {
			kept = true;
			sayOnce(host, 'info', `assets: what the funding of a channel (${id}) set aside stays set aside for now: ${plainMessage({ message: r.reason || 'the library gave no reason' })}`);
			continue;
		}
		if (r.outcome === 'released') {
			host.say('info', `assets: what the funding of a channel (${id}) had set aside is free again: ${unitsText(r.assets)}`);
			continue;
		}
		host.say('info', `assets: what the funding of a channel (${id}) had set aside went into it${r.fundingTxid ? `, in transaction ${r.fundingTxid}` : ''}: ${unitsText(r.assets)}`);
		if (r.change.length === 0) continue;
		if (r.changeRestored) {
			host.say('info', `assets: the change of that funding is back in this wallet's records: ${unitsText(r.change)}`);
			continue;
		}
		host.say('warn', `assets: the change of that funding is not in this wallet's records, and is not in its balance: ${unitsText(r.change)}`);
		await host.lock.run(() =>
			rows.put(`l-change/${id}`, {
				id,
				channelId: r.channelId,
				fundingTxid: r.fundingTxid,
				change: r.change.map((a) => ({ assetId: a.assetId, amount: a.amount.toString() })),
				at: host.now()
			})
		);
	}
	mem.lnReservations = kept ? 'kept' : 'done';
	if (reports.some((r) => r.outcome !== 'kept')) {
		host.markDirty();
		const registry = host.registry();
		const keys = new Set(reports.flatMap((r) => r.assets).map((a) => (registry.get(a.assetId) || {}).groupKey || a.assetId));
		for (const key of keys) host.emitEvent('balance', { key });
	}
}

/**
 * The Lightning part of a pass of the loop. Nothing here runs under the
 * host's lock, and each step is one look: the library is told to carry on
 * what it has, and the rows are brought up to what the node says.
 */
async function pass(host, { block = false } = {}) {
	const ln = host.ln;
	if (!ln || host.mem.stopped || host.mem.lnError || !ln.ready()) return;
	const quietly = async (what, run) => {
		try {
			await run();
			return true;
		} catch (err) {
			if (isFenced(err)) throw err;
			noteFeeBudget(host, err);
			host.say('warn', `assets: ${what}: ${plainMessage(err)}`);
			return false;
		}
	};
	// What may sign or send a transaction waits for the same start sequence
	// everything else that spends waits for: until the chain is known to be
	// the wallet's, nothing is carried on and nothing is brought back.
	if (host.mem.orphansDone && host.mem.guarded) {
		const first = !host.mem.lnSettled;
		let settled = !first;
		if (first) {
			await quietly('interrupted channel opens could not be settled', async () => {
				settled = await cancelUnasked(host);
			});
		}
		if (settled) settled = await quietly('channel opens could not be settled', () => settleOpens(host, { first }));
		if (settled) host.mem.lnSettled = true;
		// Carrying on is what could sign a funding transaction. It waits
		// until every flow nobody confirmed is known to be gone.
		if (host.mem.lnSettled) {
			await quietly('asset channels could not be carried on', () => ln.resume());
			await quietly('what a channel funding set aside could not be settled', () => settleReservations(host, { block }));
			await quietly('an open that is over could not be taken off the list', async () => forgetEnded(host));
		}
		await quietly('the assets of a closed channel could not be brought back', async () => noteRecovery(host, await ln.resumeRecovery()));
	}
	await quietly('a Lightning payment could not be settled', () => settleRows(host));
	await quietly('the asset channels could not be read', () => noteChannels(host));
	// The fee budget for channel fees: said for as long as a pass, or
	// anything the library reported since the pass before, met it used up.
	const out = host.mem.feeBudgetMet === true;
	host.mem.feeBudgetMet = false;
	// What the engine says of its fee coins is told when it changes.
	const feeNow = JSON.stringify([feeCoinsOf(feeStatusOf(host)), host.mem.feePolicySaid || null]);
	const feeMoved = host.mem.feeSeen !== undefined && host.mem.feeSeen !== feeNow;
	host.mem.feeSeen = feeNow;
	if (feeMoved) host.emitStatus();
	if (out !== (host.mem.feeBudgetOut === true)) {
		host.mem.feeBudgetOut = out;
		host.emitStatus();
	}
}

/**
 * Note that the engine refused a fee action because the budget this app
 * sets for the fees of a channel's fixed outputs is used up: `met` is an
 * error, or the text of one the library handed back as data. Nothing is
 * lost by it and the loop goes on, so it is a warning in the status
 * (warningsOf) and no failure of anything.
 */
function noteFeeBudget(host, met) {
	const err = typeof met === 'string' ? { message: met } : met;
	if (engineCodeOf(err) === 'FEE_BUDGET_EXHAUSTED') host.mem.feeBudgetMet = true;
}

/**
 * What bringing the assets of closed channels home reported. Each reason is
 * logged once, as it first comes, and never shown: it is the library's
 * text. A channel whose recovery has reported nothing but trouble for as
 * long as an on-chain transaction is given before it is called stuck is
 * said in the status (statusOf), in a sentence of the host's.
 */
function noteRecovery(host, reports) {
	const { mem } = host;
	const failing = new Set();
	for (const r of reports || []) {
		if (!r || !Array.isArray(r.errors) || r.errors.length === 0) continue;
		const id = r.channelId || '';
		failing.add(id);
		const known = mem.recovery.get(id) || { since: host.now(), sinceHeight: host.tip(), said: new Set() };
		for (const text of r.errors) {
			noteFeeBudget(host, text);
			if (known.said.has(text)) continue;
			if (known.said.size >= 16) known.said.clear();
			known.said.add(text);
			host.say('warn', `assets: the assets of a closed channel${id ? ` (${id})` : ''} could not be brought back yet: ${plainMessage({ message: text })}`);
		}
		mem.recovery.set(id, known);
	}
	for (const id of [...mem.recovery.keys()]) if (!failing.has(id)) mem.recovery.delete(id);
}

/** Whether a recovery has done nothing but fail for long enough to say so. */
function recoveryStuck(host) {
	const { cfg, mem } = host;
	const tip = host.tip();
	const now = host.now();
	for (const r of mem.recovery.values()) {
		if (cfg.stuckAfterBlocks != null ? tip - r.sinceHeight >= cfg.stuckAfterBlocks : now - r.since > cfg.stuckAfterMs) return true;
	}
	return false;
}

/** Rows that mean nothing any more. The caller holds the lock. */
function prune(host) {
	const now = host.now();
	dropOldQuotes(host);
	for (const { key, value } of host.rows.list('inv/')) {
		const deadline = Math.min(value.expiresAt || 0, value.invoiceExpiresAt || 0);
		if (value.status !== 'PAID' && deadline + INVOICE_KEEP_MS < now) host.rows.del(key);
	}
}

/* -------------------------------------------- what the library asks the host */

/** A proof file from the wallet's proof server, for an asset a peer puts into a channel. */
async function fetchProof(host, locator) {
	const universe = host.cfg.defaultUniverse;
	if (!universe) throw new Error('This wallet has no proof server to ask');
	return host.courierFor(universe.courier).receiveProof(locator);
}

/**
 * The proof file of the issuance that created a group, from the wallet's
 * proof server: what the library asks for when a peer puts an asset of a
 * group into a channel and this wallet has never held one of that group.
 * The library verifies what comes back before it trusts the group.
 */
async function fetchGroupProof(host, groupKey) {
	const universe = host.cfg.defaultUniverse;
	if (!universe) throw new Error('This wallet has no proof server to ask');
	const courier = host.courierFor(universe.courier);
	if (typeof courier.receiveGroupProof !== 'function') throw new Error("This wallet's proof server cannot be asked for the issuance of a group");
	return courier.receiveGroupProof(groupKey);
}

/**
 * Whether to take a channel a peer offers. Only a wallet whose asset
 * channels are on takes one, only a few at a time, and only for an asset
 * its own proof server can show the issuance of: that is also how the
 * wallet comes to know the name of what it is being handed.
 */
async function acceptIncoming(host, proposal) {
	const { mem } = host;
	try {
		if (mem.stopped || modeOf(host) !== 'full' || !host.ln.ready() || !mem.lnSettled) return false;
		const now = host.now();
		for (const [id, at] of mem.accepted) if (now - at > ACCEPTED_KEPT_MS) mem.accepted.delete(id);
		// Every channel a peer began that is not usable yet and not on its way
		// out, by what is known of it and not by what the engine calls it.
		const opening = new Set(
			channelList(host)
				.filter((c) => !c.initiator && c.opening)
				.map((c) => c.id)
		);
		for (const id of mem.accepted.keys()) opening.add(id);
		opening.delete(proposal.pendingChannelId);
		if (opening.size >= MAX_INBOUND_PENDING) return false;
		if (!Array.isArray(proposal.assets) || proposal.assets.length === 0) return false;
		// Counted from here, so offers that arrive together are not all taken.
		mem.accepted.set(proposal.pendingChannelId, now);
		for (const a of proposal.assets) {
			const reg = host.registry().get(a.assetId);
			const known = reg && reg.genesis ? reg : await ops.lookupAndLearn(host, a.assetId);
			if (views.typeName(known.type) === 'collectible') throw new Error('a collectible is not taken into a channel');
		}
		return true;
	} catch (err) {
		mem.accepted.delete(proposal && proposal.pendingChannelId);
		if (isFenced(err)) host.shutdown();
		else host.say('info', `assets: a channel a peer offered was turned down: ${plainMessage(err)}`);
		return false;
	}
}

/** Something happened in the library. The state is read from the node, so this is only a reason to look. */
function onEvent(host, event) {
	if (host.mem.stopped) return;
	if (event && (event.type === 'invoice' || event.type === 'payment')) {
		host.soon(async () => {
			try {
				if (host.ln && host.ln.ready()) await settleRows(host);
			} catch (err) {
				if (isFenced(err)) host.shutdown();
			}
		}, 50);
		return;
	}
	host.nudge();
}

// How long the same complaint of the library's is not logged again.
const SAME_ERROR_MS = 10 * 60_000;

/**
 * Something went wrong in the library where no call of the host's was
 * waiting: a message from a peer it could not use, a step of an open or of
 * a recovery that failed. It goes to the log, the same words at most once
 * in a while. It changes nothing by itself: every pass reads how things
 * stand from the library's own list.
 */
function libraryError(host, err) {
	if (isFenced(err)) {
		host.shutdown();
		return;
	}
	noteFeeBudget(host, err);
	// A peer's channel the library turned down before the host was asked:
	// said in the host's sentence, with the library's own words after it.
	if (TURNED_DOWN.has(codeOf(err))) {
		const said = mapLightning(err);
		if (said) {
			sayOnce(host, 'warn', `assets: asset channels: ${said.message} (${plainMessage(err, 'no more was said')})`);
			return;
		}
	}
	sayOnce(host, 'warn', `assets: asset channels: ${plainMessage(err, 'An asset channel step failed')}`);
}

// What the library says to onError of a channel a peer proposed and it
// turned down itself: a group that could not be shown to be real, and
// assets that cannot be one channel. The host keeps no list of such
// proposals (it was never asked about them), so they are for the log.
const TURNED_DOWN = new Set(['ERR_BEIGNET_LN_GROUP_PROOF', 'ERR_BEIGNET_LN_CHANNEL_ASSETS']);

/** Log `text`, unless the same words were logged a short while ago. */
function sayOnce(host, level, text) {
	const said = host.mem.lnSaid;
	const at = host.now();
	if (said.has(text) && at - said.get(text) < SAME_ERROR_MS) return;
	if (said.size > 200) said.clear();
	said.set(text, at);
	host.say(level, text);
}

/** What `host.ln.start` is given. Each callback begins outside the lock, whoever calls it. */
function startOptions(host) {
	const outside = (fn) => (...args) => host.lock.outside(() => fn(host, ...args));
	return {
		adapter: host.tap,
		lib: host.lib,
		quiet: host.cfg.lightning !== 'full',
		// What buries a transaction for good is the wallet's own measure.
		confirmations: host.cfg.minConfirmations,
		fetchProof: outside(fetchProof),
		fetchGroupProof: outside(fetchGroupProof),
		acceptIncoming: outside(acceptIncoming),
		onEvent: outside(onEvent),
		onError: (err) => libraryError(host, err)
	};
}

/* ------------------------------------------------------------------ backup */

const noRestore = (why) => refusal('ASSET_CHANNELS_OPEN', why, 409);

/**
 * A backup is never restored over an asset channel: what it says the wallet
 * holds on-chain is from before the channel, and the two would not agree.
 * For the route, which can ask the node.
 */
function refuseImportWhileLive(host) {
	if (!host.ln) return;
	if (!host.ln.ready()) throw starting();
	// A channel on record that the node does not hold is no channel to
	// restore over: it is what an earlier restore left, and it cannot be
	// closed. The wallet's own record of it stands (backup.js).
	if (channelList(host).some((c) => !c.over && !c.missing)) {
		throw noRestore('This wallet has an asset channel, and a backup is never restored over one. Close its asset channels first.');
	}
}

/** The same, before there is a node to ask: a wallet with Lightning rows of its own is left alone. */
function refuseImportUnasked(host) {
	if (host.storage.list('l/').length > 0) {
		throw noRestore('This wallet has Lightning records of its own, so the backup was left alone. Restore it from the dashboard once the wallet is running.');
	}
}

module.exports = {
	modeOf,
	channelList,
	channelCount,
	liveChannels,
	failedOpen,
	OPEN_ENDED_BECAUSE,
	statusOf,
	listChannels,
	paymentLimits,
	channelQuote,
	openChannel,
	closeChannel,
	reclaimFunding,
	invoiceQuote,
	createInvoice,
	listInvoices,
	payQuote,
	pay,
	pass,
	prune,
	settleOpens,
	settleRows,
	noteChannels,
	startOptions,
	acceptIncoming,
	fetchProof,
	onEvent,
	refuseImportWhileLive,
	refuseImportUnasked,
	MAX_INBOUND_PENDING,
	FORCE_CLOSED_SHOWN_MS
};
