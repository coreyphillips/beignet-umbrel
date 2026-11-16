/**
 * Where an asset operation has got to, as steps a person can follow.
 *
 * A mint, a receive, a send and a burn each take a while, and most of the
 * while is waiting for blocks. The wallet reports one row per operation
 * (lib/assets-api.js: Row); this file turns a row into the list of steps the
 * timeline draws, one line for a list, and the notes about waiting.
 *
 * All of it is pure: a row in, plain data out. The steps carry text and a few
 * plain fields (`txid`, `meter`) and the page decides how to draw those, so
 * everything here can be checked without a browser.
 *
 * A step is { key, label, state, detail, at, txid, meter } with state one of
 * done, current, pending, failed.
 */
import { fmtAsset } from './asset-amount.js';
import { fmtDuration } from './format.js';

/** How many confirmations an asset needs before it is usable. */
export function confirmationsNeeded(row, network) {
	const n = Number(row && row.confirmationsRequired);
	if (Number.isInteger(n) && n > 0) return n;
	return network === 'regtest' ? 1 : 6;
}

const TERMINAL = new Set(['complete', 'failed', 'cancelled']);

/** Still going: worth polling for, and worth a line under "In progress". */
export function isPending(row) {
	return !!row && !TERMINAL.has(row.state) && !row.failed && !handedOver(row);
}

/**
 * A send whose proof the sender gave to the recipient as a file, and said
 * so. The proof server has still not taken it, and the wallet still offers
 * it, but nothing is left for the reader to wait for.
 */
export function handedOver(row) {
	return !!row && row.kind === 'send' && row.state === 'proofs' && !isFailed(row) && !!row.handedOver;
}

/** Stopped without finishing, and kept on screen until the reader has seen why. */
export function isFailed(row) {
	return !!row && (row.failed === true || row.state === 'failed');
}

/**
 * A mint that finished, whose issuance proof the proof server has not taken
 * yet. The assets are in the wallet and can be spent; what waits is anyone
 * else being able to check them. Never a failure: the wallet keeps trying.
 */
export function proofUnpublished(row) {
	return !!row && row.kind === 'mint' && row.state === 'complete' && !isFailed(row) && !!row.failure && row.failure.retrying !== false;
}

/**
 * An address nobody has paid that the wallet has stopped looking at by
 * itself: it checks an unpaid address for seven days. A payment to it is
 * still found by asking.
 */
export function unwatched(row) {
	return !!row && row.kind === 'receive' && row.state === 'waiting' && row.watching === false;
}

/** A transaction that was broadcast and has no block yet: the one thing that can be sent to the network again. */
export function canRebroadcast(row) {
	return !!row && ['mint', 'send', 'burn'].includes(row.kind) && row.state === 'broadcast' && !isFailed(row);
}

/** "BUSD", "BUSD and Club Points", "3 assets". */
export function namesOf(row) {
	const list = (row && row.assets) || [];
	if (list.length === 0) return 'an asset';
	if (list.length === 1) return list[0].name || 'an asset';
	if (list.length === 2) return `${list[0].name} and ${list[1].name}`;
	return `${list.length} assets`;
}

/** "100.00 BUSD", or the names when a row carries several. */
export function amountOf(row) {
	const list = (row && row.assets) || [];
	if (list.length === 1 && list[0].amount != null) return fmtAsset(list[0].amount, list[0]);
	return namesOf(row);
}

const FIRST_BLOCK_WAIT = {
	mainnet: 'Waiting for a block. Usually about 10 minutes.',
	testnet: 'Waiting for a block. Testnet blocks are irregular, so this can take a while.',
	regtest: 'Waiting for a block. Mine one to continue.'
};

function waitForBlock(network) {
	return FIRST_BLOCK_WAIT[network] || FIRST_BLOCK_WAIT.mainnet;
}

/**
 * How long the remaining confirmations should take, said the way a person
 * would: ten minutes a block on mainnet, and no promise at all on testnet.
 */
export function etaText(row, network) {
	const need = confirmationsNeeded(row, network);
	const left = Math.max(0, need - (Number(row && row.confirmations) || 0));
	if (left === 0) return '';
	if (network === 'regtest') return left === 1 ? 'Mine one more block to continue.' : `Mine ${left} more blocks to continue.`;
	if (network === 'testnet') return 'Testnet blocks are irregular, so this can take a while.';
	const minutes = left * 10;
	if (minutes >= 55 && minutes <= 65) return 'about an hour left';
	return `about ${fmtDuration(minutes * 60)} left`;
}

/**
 * Lay a list of steps out from what has been reached.
 *
 * `reached` is how many of them are behind us. The next one is the current
 * step, or the failed one when the row stopped there.
 */
function layout(steps, reached, row) {
	const stopped = isFailed(row) || row.state === 'cancelled';
	const done = row.state === 'complete' ? steps.length : Math.min(reached, steps.length);
	return steps.map((s, i) => {
		const state = i < done ? 'done' : i === done ? (stopped ? 'failed' : 'current') : 'pending';
		const pick = s[state];
		const detail = typeof pick === 'function' ? pick() : pick;
		return {
			key: s.key,
			label: s.label,
			state,
			detail: (detail && detail.text !== undefined ? detail.text : detail) || null,
			txid: (detail && detail.txid) || null,
			meter: (detail && detail.meter) || null,
			at: state === 'done' ? s.at || null : null
		};
	});
}

function failureText(row, fallback) {
	const said = row.failure && row.failure.message;
	return said ? `${String(said).replace(/[.\s]+$/, '')}.` : fallback;
}

function confirmationsStep(row, network) {
	const need = confirmationsNeeded(row, network);
	const have = Math.min(need, Number(row.confirmations) || 0);
	return {
		key: 'confirmations',
		label: `${need} confirmations`,
		current: () => ({ text: etaText(row, network), meter: { have, need } }),
		done: `${need} of ${need}`,
		failed: () => failureText(row, 'Stopped while confirming.')
	};
}

const inBlock = (row) => (row.blockHeight ? `In block ${Number(row.blockHeight).toLocaleString('en-US')}` : null);

/**
 * A mint: Prepared, Broadcast, First confirmation, N confirmations, Ready.
 * With one confirmation needed (regtest) the fourth step would repeat the
 * third, so it is left out.
 */
export function mintSteps(row, { network } = {}) {
	const need = confirmationsNeeded(row, network);
	const conf = Number(row.confirmations) || 0;
	const count = (row.assets || []).length;
	const past = (...states) => states.includes(row.state);
	const steps = [
		{
			key: 'prepared',
			label: 'Prepared',
			at: row.at?.created,
			current: 'Building the transaction…',
			done: `${count} asset${count === 1 ? '' : 's'}${row.satsPerVbyte ? ` · ${row.satsPerVbyte} sat/vB` : ''}`,
			failed: () =>
				row.state === 'cancelled'
					? 'Cancelled before it was broadcast. Nothing was spent.'
					: `Minting stopped before anything was broadcast: ${failureText(row, 'the wallet could not build the transaction.')} Nothing was spent.`
		},
		{
			key: 'broadcast',
			label: 'Broadcast',
			at: row.at?.broadcast,
			current: 'Sending it to the network…',
			done: () => ({ text: null, txid: row.txid }),
			failed: () => failureText(row, 'The network did not take the transaction.')
		},
		{
			key: 'first',
			label: 'First confirmation',
			at: row.at?.confirmed,
			current: waitForBlock(network),
			done: () => inBlock(row),
			failed: () => failureText(row, 'The transaction did not confirm.')
		}
	];
	if (need > 1) steps.push(confirmationsStep(row, network));
	steps.push({
		key: 'ready',
		label: 'Ready',
		at: row.at?.completed,
		current: 'Writing the proofs…',
		done: `${namesOf(row)} ${count > 1 ? 'are' : 'is'} in your holdings.`,
		failed: () => failureText(row, 'The proofs could not be written.')
	});

	let reached = 0;
	if (row.txid || past('broadcast', 'confirming', 'proofs', 'complete')) reached = 1;
	if (past('broadcast', 'confirming', 'proofs', 'complete')) reached = 2;
	if (conf >= 1 || past('confirming', 'proofs', 'complete')) reached = 3;
	if (need > 1 && (conf >= need || past('proofs', 'complete'))) reached = 4;
	return layout(steps, reached, row);
}

/**
 * A receive: Waiting for the sender, First confirmation, N confirmations,
 * Proof received, Complete.
 *
 * There is no "seen, unconfirmed" step. The wallet learns of an incoming
 * asset from a confirmed output, so the first thing it can honestly say after
 * "nothing yet" is that a block has it.
 */
export function receiveSteps(row, { network, host } = {}) {
	const need = confirmationsNeeded(row, network);
	const conf = Number(row.confirmations) || 0;
	const where = host || row.courier || 'the proof server';
	const past = (...states) => states.includes(row.state);
	const late = !!row.failure && !isFailed(row);
	const steps = [
		{
			key: 'waiting',
			label: 'Waiting for the sender',
			current: unwatched(row)
				? 'Nothing seen. This address is no longer checked automatically.'
				: 'Nothing seen yet. This page updates by itself.',
			done: () => ({ text: null, txid: row.txid }),
			failed: () => failureText(row, 'This address was never paid.')
		},
		{
			key: 'first',
			label: 'First confirmation',
			at: row.at?.confirmed,
			current: waitForBlock(network),
			done: () => inBlock(row),
			failed: () => failureText(row, 'The transaction did not confirm.')
		}
	];
	if (need > 1) steps.push(confirmationsStep(row, network));
	steps.push(
		{
			key: 'proof',
			label: 'Proof received',
			at: row.at?.proof,
			current: late ? `Not here yet. The wallet keeps asking ${where}.` : `Fetching it from ${where}…`,
			done: `Fetched from ${where} and checked.`,
			failed: () => failureText(row, `The proof could not be fetched from ${where}.`)
		},
		{
			key: 'complete',
			label: 'Complete',
			at: row.at?.completed,
			current: 'Adding it to your holdings…',
			done: `${amountOf(row)} is in your holdings.`,
			failed: () => failureText(row, 'The receive could not be finished.')
		}
	);

	const confirmed = conf >= 1 || past('confirming', 'proofs', 'complete');
	let reached = 0;
	// The first confirmation is how the payment is seen at all, so the two
	// steps are reached together.
	if (confirmed) reached = 2;
	if (need > 1 && (conf >= need || past('proofs', 'complete'))) reached = 3;
	const beforeProof = need > 1 ? 3 : 2;
	if (row.at?.proof && reached >= beforeProof) reached = beforeProof + 1;
	return layout(steps, reached, row);
}

/** A send: Broadcast, Confirmed, Proof delivered, Complete. */
export function sendSteps(row, { network, host } = {}) {
	const conf = Number(row.confirmations) || 0;
	const where = host || row.courier || 'the proof server';
	const past = (...states) => states.includes(row.state);
	const late = !!row.failure && !isFailed(row);
	// A server that answers "no" is not one that is down: waiting for it to
	// come back is not what the reader should be told.
	const refused = late && row.failure.code === 'PROOF_REFUSED';
	// Given to the recipient as a file: the proof step is behind us, by hand.
	const byHand = handedOver(row);
	const why = refused ? String(row.failure.message || '').replace(/^The proof server did not (take|accept) the proof:?\s*/i, '').replace(/\.$/, '') : '';
	const steps = [
		{
			key: 'broadcast',
			label: 'Broadcast',
			at: row.at?.broadcast,
			current: 'Sending it to the network…',
			done: () => ({ text: null, txid: row.txid }),
			failed: () => `Nothing was sent: ${failureText(row, 'the network did not take the transaction.')}`
		},
		{
			key: 'confirmed',
			label: 'Confirmed',
			at: row.at?.confirmed,
			current: waitForBlock(network),
			done: () => inBlock(row),
			failed: () => failureText(row, 'The transaction did not confirm.')
		},
		{
			key: 'proof',
			label: byHand ? 'Proof handed over' : 'Proof delivered',
			at: byHand ? row.handedOver : row.at?.proof,
			current: refused
				? `${where} did not take the proof${why ? `: ${why}` : ''}. The asset has moved, and the recipient cannot receive it until the server takes its proof. This wallet keeps the proof and offers it again from time to time.`
				: late
					? `${where} is not answering. The asset has moved, and the proof is delivered once it can be reached.`
					: `Delivering it through ${where}…`,
			done: byHand ? 'Given to the recipient as a file.' : `Delivered through ${where}.`,
			failed: () => failureText(row, `The proof could not be delivered through ${where}.`)
		},
		{
			key: 'complete',
			label: 'Complete',
			at: row.at?.completed,
			current: byHand
				? `The recipient has the asset once they import the file. This wallet still offers the proof to ${where} from time to time.`
				: 'Finishing…',
			done: 'The recipient has the asset and its proof.',
			failed: () => failureText(row, 'The send could not be finished.')
		}
	];
	let reached = 0;
	if (past('broadcast', 'confirming', 'proofs', 'complete')) reached = 1;
	if (conf >= 1 || past('confirming', 'proofs', 'complete')) reached = 2;
	if ((row.at?.proof || byHand) && reached >= 2) reached = 3;
	return layout(steps, reached, row);
}

/** A burn: Broadcast, Confirmed, Burned. */
export function burnSteps(row, { network } = {}) {
	const conf = Number(row.confirmations) || 0;
	const past = (...states) => states.includes(row.state);
	const steps = [
		{
			key: 'broadcast',
			label: 'Broadcast',
			at: row.at?.broadcast,
			current: 'Sending it to the network…',
			done: () => ({ text: null, txid: row.txid }),
			failed: () => `Nothing was burned: ${failureText(row, 'the network did not take the transaction.')}`
		},
		{
			key: 'confirmed',
			label: 'Confirmed',
			at: row.at?.confirmed,
			current: waitForBlock(network),
			done: () => inBlock(row),
			failed: () => failureText(row, 'The transaction did not confirm.')
		},
		{
			key: 'complete',
			label: 'Burned',
			at: row.at?.completed,
			current: 'Recording the burn…',
			done: `${amountOf(row)} no longer exists.`,
			failed: () => failureText(row, 'The burn could not be recorded.')
		}
	];
	let reached = 0;
	if (past('broadcast', 'confirming', 'proofs', 'complete')) reached = 1;
	if (conf >= 1 || past('confirming', 'proofs', 'complete')) reached = 2;
	return layout(steps, reached, row);
}

/** The steps of any row, by its kind. Lightning rows settle in one step and have none. */
export function stepsOf(row, context) {
	if (!row) return [];
	if (row.kind === 'mint') return mintSteps(row, context);
	if (row.kind === 'receive') return receiveSteps(row, context);
	if (row.kind === 'send') return sendSteps(row, context);
	if (row.kind === 'burn') return burnSteps(row, context);
	return [];
}

const TIMELINE_LABEL = { mint: 'Mint progress', receive: 'Receive progress', send: 'Send progress', burn: 'Burn progress' };
export const timelineLabel = (row) => TIMELINE_LABEL[row && row.kind] || 'Progress';

function confirmationsSoFar(row, network) {
	const need = confirmationsNeeded(row, network);
	return `${Math.min(need, Number(row.confirmations) || 0)} of ${need} confirmations`;
}

/**
 * One line that says what a row is and where it is. Used as the title of an
 * item in progress, and as the sentence a screen reader hears when it moves.
 */
export function headline(row, { network } = {}) {
	if (!row) return '';
	const what = amountOf(row);
	const names = namesOf(row);
	const s = row.state;
	const failed = isFailed(row);
	switch (row.kind) {
		case 'mint':
			if (s === 'cancelled') return `Minting ${names} was cancelled`;
			if (failed) return `Minting ${names} failed`;
			if (proofUnpublished(row)) return `Minted ${what}: the proof server has not taken its proof yet`;
			if (s === 'complete') return `Minted ${what}`;
			if (s === 'pending') return `Minting ${names}: building the transaction`;
			if (s === 'broadcast') return `Minting ${names}: waiting for a block`;
			if (s === 'confirming') return `Minting ${names}: ${confirmationsSoFar(row, network)}`;
			return `Minting ${names}: writing the proofs`;
		case 'receive':
			if (failed) return `Receiving ${what} failed`;
			if (s === 'complete') return `Received ${what}`;
			if (unwatched(row)) return `Waiting for ${what}: no longer checked automatically`;
			if (s === 'waiting') return `Waiting for ${what}`;
			if (s === 'confirming') return `Receiving ${what}: ${confirmationsSoFar(row, network)}`;
			return row.failure ? `Receiving ${what}: the proof has not arrived yet` : `Receiving ${what}: fetching the proof`;
		case 'send':
			if (failed) return `Sending ${what} failed`;
			if (s === 'complete') return `Sent ${what}`;
			if (s === 'pending') return `Sending ${what}: broadcasting`;
			if (s === 'broadcast') return `Sending ${what}: waiting for a block`;
			if (handedOver(row)) return `Sent ${what}: its proof was handed over as a file`;
			if (proofRefused(row)) return `Sending ${what}: the proof server did not take the proof`;
			return row.failure ? `Sending ${what}: the proof is waiting to be delivered` : `Sending ${what}: delivering the proof`;
		case 'burn':
			if (failed) return `Burning ${what} failed`;
			if (s === 'complete') return `Burned ${what}`;
			if (s === 'pending') return `Burning ${what}: broadcasting`;
			return `Burning ${what}: waiting for a block`;
		case 'ln-receive':
			if (failed) return `Lightning invoice for ${what} expired`;
			return s === 'complete' ? `Received ${what} over Lightning` : `Lightning invoice for ${what}: waiting to be paid`;
		case 'ln-send':
			if (failed) return `Paying ${what} over Lightning failed`;
			return s === 'complete' ? `Paid ${what} over Lightning` : `Paying ${what} over Lightning`;
		default:
			return names;
	}
}

/** A row's state as a word and a tone, for a table cell's badge. */
export function statusOf(row, { network } = {}) {
	if (!row) return { text: '-', tone: 'muted' };
	if (row.state === 'cancelled') return { text: 'cancelled', tone: 'muted' };
	if (isFailed(row)) return { text: 'failed', tone: 'red' };
	if (row.state === 'complete') return { text: 'complete', tone: 'green' };
	if (unwatched(row)) return { text: 'not checked', tone: 'muted' };
	if (row.state === 'waiting') return { text: 'waiting', tone: 'muted' };
	if (row.state === 'pending') return { text: 'starting', tone: 'yellow' };
	if (row.state === 'broadcast') return { text: 'in mempool', tone: 'yellow' };
	if (row.state === 'confirming') {
		const need = confirmationsNeeded(row, network);
		return { text: `${Math.min(need, Number(row.confirmations) || 0)} of ${need}`, tone: 'yellow' };
	}
	if (handedOver(row)) return { text: 'handed over', tone: 'green' };
	if (proofRefused(row)) return { text: 'proof refused', tone: 'red' };
	return { text: row.failure ? 'proof late' : 'proof', tone: 'yellow' };
}

/**
 * A send that confirmed, whose proof a proof server answered "no" to. Not a
 * failed send (the wallet goes on offering the proof) and not a late one
 * either: the server is there, and the recipient is waiting on its answer.
 */
export function proofRefused(row) {
	return (
		!!row && row.kind === 'send' && row.state === 'proofs' && !isFailed(row) && !row.handedOver && !!row.failure && row.failure.code === 'PROOF_REFUSED'
	);
}

const KIND_WORD = {
	mint: 'Mint',
	receive: 'Receive',
	send: 'Send',
	burn: 'Burn',
	'ln-receive': 'Lightning receive',
	'ln-send': 'Lightning payment'
};
export const kindWord = (row) => KIND_WORD[row && row.kind] || 'Transfer';

/** Whether a row moved over Lightning or on-chain, for the Rail column. */
export const railOf = (row) => (row && String(row.kind).startsWith('ln-') ? 'lightning' : 'on-chain');

// A transaction that has not had a block in this long is worth a sentence.
const STUCK_AFTER_MS = 30 * 60 * 1000;

/**
 * The note for a transaction that has sat in the mempool: how long it has
 * waited, what it paid and what the network asks now. Null when nothing is
 * stuck. Asset transactions cannot be fee-bumped yet, and the note says so.
 * What can be done is to send the same transaction to the network again,
 * which the page offers beside it (canRebroadcast).
 */
export function stuckNote(row, fees, now = Date.now()) {
	if (!row || row.state !== 'broadcast' || (Number(row.confirmations) || 0) > 0) return null;
	const since = Number(row.at && row.at.broadcast);
	const waited = Number.isFinite(since) && since > 0 ? now - since : 0;
	const stuck = row.stuck === true || (row.stuck === undefined && waited > STUCK_AFTER_MS);
	if (!stuck) return null;
	const paid = Number(row.satsPerVbyte);
	const asked = Number(fees && fees.fast);
	const waitedText = waited > 0 ? `has waited ${fmtDuration(waited / 1000)}` : 'is waiting';
	const rates =
		Number.isFinite(paid) && paid > 0 && Number.isFinite(asked) && asked > paid
			? ` It paid ${paid} sat/vB and the network now asks about ${asked}.`
			: '';
	return `A transaction ${waitedText} for its first block.${rates} Asset transactions cannot be fee-bumped yet, so it stays queued until fees fall. Broadcasting it again sends the same transaction to the network once more.`;
}
