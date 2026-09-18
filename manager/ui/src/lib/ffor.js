/**
 * FFOR offline receive (Fast-Forward Offline Receive, beignet #729): the
 * pure presentation half. The wallet pre-signs a book of fixed-amount
 * vouchers with a settlement peer (an epoch), hands out one invoice per
 * slot, and can then be paid while its daemon is off; the peer settles the
 * payer's HTLC at once and the wallet's credit lands when it returns and
 * closes the epoch. Everything here is derived once from the daemon's
 * epoch view and the manager's return record (the pattern of lib/lfbw.js),
 * so the card, the Overview row, the header badge and the return panel
 * read the same figures.
 */
import { fmtSats } from './format.js';
import { fmtBlocksDuration } from './close-story.js';

// The engine refuses a book whose voucher expiry sits under the settlement
// deadline plus this margin (FF_RECONCILE_MARGIN_BLOCKS): the window after
// the return-by height in which the wallet can still claim on-chain.
export const MIN_MARGIN_BLOCKS = 1008;
// Extra room past the margin, so a return on the last day still reconciles.
export const EXPIRY_HEADROOM_BLOCKS = 144;
export const BLOCKS_PER_DAY = 144;
// The settlement peer's fee on each voucher, offered by the receiver and
// checked against the peer's floor. A sibling's floor is zero by default.
export const DEFAULT_FEE = Object.freeze({ baseMsat: 1000, ppm: 100 });
// Under a day of margin before the return-by height, the return panel warns.
export const RETURN_WARN_BLOCKS = 144;
// The engine's ceiling on slots per epoch (FF_MAX_K).
export const MAX_SLOTS = 483;

const SETUP_STATES = ['NEGOTIATING', 'VOUCHERS_COMMITTED', 'ACTIVATING'];
// A channel in one of these states takes no channel actions any more: an
// epoch on it is being claimed on-chain, not paid against.
const CLOSED_CHANNEL_STATES = ['CLOSED', 'FORCE_CLOSED'];

export function isClosedChannelState(state) {
	return CLOSED_CHANNEL_STATES.includes(state);
}

// The engine's abort reasons (FforAbortReason), in the receiver's words. A
// peer that refuses the book answers after the start call returned, so the
// refusal arrives as an ABORTED epoch rather than a 400.
const ABORT_REASONS = {
	0: 'cancelled from this side',
	1: 'the peer did not answer in time',
	2: 'the peer refused the terms: it does not settle offline receives, or the book is over its limits or under its fee floor',
	3: 'the two sides disagreed on the book',
	4: 'the two sides disagreed on the commitment',
	5: 'signing the vouchers failed',
	6: 'the peer disconnected during setup',
	7: 'the peer broke the protocol'
};

export function abortReasonText(reason) {
	if (reason == null) return null;
	return ABORT_REASONS[Number(reason)] || `reason ${reason}`;
}

/** True while the epoch can still be paid against. */
export function isLiveEpoch(epoch) {
	return !!epoch && epoch.state === 'ACTIVE';
}

/** The receiver's own epochs, newest first by start height. */
export function receiverEpochs(epochs) {
	return (Array.isArray(epochs) ? epochs : [])
		.filter((e) => e && e.role === 'R')
		.sort((a, b) => (b.epochStartHeight || 0) - (a.epochStartHeight || 0));
}

/** The epoch the Receive card should show: a live or setting-up one first, else the newest. */
export function currentEpoch(epochs) {
	const mine = receiverEpochs(epochs);
	return mine.find((e) => isLiveEpoch(e) || SETUP_STATES.includes(e.state) || e.state === 'DRAINING') || mine[0] || null;
}

/**
 * The body for POST /ffor/epoch/start from the card's fields, or an error
 * naming the field. Heights are absolute: the return-by height is the tip
 * plus the days away, the voucher expiry sits the engine's margin past it.
 * witnessPeers stays empty: a named list makes the peer refuse HTLCs from
 * anyone else, and these invoices are meant for any payer.
 */
export function planEpoch({ channelId, amountSats, count, awayDays, tip, feeBaseMsat, feePpm }) {
	if (!channelId) return { error: 'Pick the channel to your settlement peer.' };
	const amount = Number(amountSats);
	if (!Number.isInteger(amount) || amount < 1) return { error: 'Each voucher needs a whole number of sats.' };
	const k = Number(count);
	if (!Number.isInteger(k) || k < 1 || k > MAX_SLOTS) {
		return { error: `Between 1 and ${MAX_SLOTS} vouchers.` };
	}
	const days = Number(awayDays);
	if (!(days > 0) || days > 365) return { error: 'Between one day and a year away.' };
	if (!(tip > 0)) return { error: 'The block height is not known yet.' };
	const settlementDeadline = tip + Math.ceil(days * BLOCKS_PER_DAY);
	const voucherExpiry = settlementDeadline + MIN_MARGIN_BLOCKS + EXPIRY_HEADROOM_BLOCKS;
	const base = feeBaseMsat == null || feeBaseMsat === '' ? DEFAULT_FEE.baseMsat : Number(feeBaseMsat);
	const ppm = feePpm == null || feePpm === '' ? DEFAULT_FEE.ppm : Number(feePpm);
	if (!Number.isInteger(base) || base < 0 || !Number.isInteger(ppm) || ppm < 0) {
		return { error: 'Fees are whole numbers, zero or more.' };
	}
	return {
		body: {
			channelId,
			voucherAmountsMsat: Array.from({ length: k }, () => String(amount * 1000)),
			settlementDeadline,
			voucherExpiry,
			feeBaseMsat: base,
			feeProportionalMillionths: ppm,
			witnessPeers: []
		},
		budgetSats: amount * k,
		settlementDeadline,
		voucherExpiry
	};
}

/**
 * Whether the peer's side of the channel can back the book. The engine's
 * check is stricter (reserve, fee buffer, HTLC limits); this only stops the
 * obvious case before the round trip, and says what the peer holds.
 */
export function bookFits(budgetSats, channel) {
	if (!channel) return { ok: false, note: 'Pick a channel.' };
	const remote = channel.remoteBalanceSats || 0;
	if (budgetSats > remote) {
		return {
			ok: false,
			note: `The book needs ${fmtSats(budgetSats)} on the peer's side of the channel, which holds ${fmtSats(remote)}.`
		};
	}
	return { ok: true, note: `The peer's side holds ${fmtSats(remote)}; the book locks ${fmtSats(budgetSats)} of it until the epoch closes.` };
}

/** The wallet's channels a settlement candidate is on the other end of, tagged with its name. */
export function settlementChannels(channels, candidates) {
	// A candidate that holds only the witness or issuer role is not a
	// settlement peer; older managers sent no role flags, so absent means yes.
	const byNode = new Map((candidates || []).filter((c) => c.settles !== false).map((c) => [c.nodeId, c]));
	return (channels || [])
		.filter((c) => c.state === 'NORMAL' && byNode.has(c.peerPubkey))
		.map((c) => ({ ...c, settler: byNode.get(c.peerPubkey) }));
}

const TONES = {
	NEGOTIATING: 'blue',
	VOUCHERS_COMMITTED: 'blue',
	ACTIVATING: 'blue',
	ACTIVE: 'green',
	DRAINING: 'yellow',
	CLOSED: 'muted',
	ABORTED: 'red'
};

const LABELS = {
	NEGOTIATING: 'setting up',
	VOUCHERS_COMMITTED: 'setting up',
	ACTIVATING: 'activating',
	ACTIVE: 'receiving offline',
	DRAINING: 'closing',
	CLOSED: 'closed',
	ABORTED: 'aborted'
};

/** Slot counts from an epoch view. */
export function slotCounts(epoch) {
	const slots = epoch && Array.isArray(epoch.slots) ? epoch.slots : [];
	const by = (s) => slots.filter((x) => x.state === s).length;
	return {
		total: slots.length,
		settled: by('settled'),
		exposed: by('exposed'),
		unissued: by('unissued'),
		unsettled: by('unsettled')
	};
}

/**
 * One epoch in the words the Overview row and the header badge print:
 * a label, its tone, a detail sentence, the return-by height and how far
 * off it is, and whether the margin is under a day.
 */
export function describeEpoch(epoch, tip, channel = null) {
	if (!epoch) return null;
	const counts = slotCounts(epoch);
	const state = epoch.state || 'NEGOTIATING';
	const mismatch = !!epoch.activationMismatch;
	// A force close leaves the epoch ACTIVE on the record by design: the
	// settled vouchers are claimed through the commitment. The channel's
	// state is what says so.
	const enforced = !!channel && isClosedChannelState(channel.state) && state !== 'CLOSED' && state !== 'ABORTED';
	const label = enforced ? 'enforced on-chain' : mismatch ? 'peer disagrees' : LABELS[state] || state.toLowerCase();
	const tone = enforced ? 'yellow' : mismatch ? 'red' : TONES[state] || 'muted';
	const deadline = Number(epoch.settlementDeadline) || null;
	const blocksLeft = deadline && tip > 0 ? deadline - tip : null;
	const returnBy = deadline
		? {
				height: deadline,
				blocksLeft,
				text:
					blocksLeft == null
						? `by block ${deadline}`
						: blocksLeft <= 0
						? `block ${deadline}, already passed`
						: `by block ${deadline}, ${fmtBlocksDuration(blocksLeft)} from now at ten minutes a block`
		  }
		: null;
	const warn = !enforced && state === 'ACTIVE' && blocksLeft != null && blocksLeft < RETURN_WARN_BLOCKS;
	let detail;
	if (enforced) {
		detail = `The channel was force-closed with ${counts.settled} of ${counts.total} vouchers known paid; they are claimed on-chain as the close confirms, and the rest time out back to the peer at block ${epoch.voucherExpiry || '?'}.`;
	} else if (mismatch) {
		detail = 'The settlement peer reported a different epoch at reconnect. Enforce on-chain to claim what was paid.';
	} else if (state === 'ACTIVE') {
		detail = `${counts.settled} of ${counts.total} vouchers paid so far. Return ${returnBy ? returnBy.text : 'before the deadline'}.`;
	} else if (state === 'DRAINING') {
		detail = `Closing with the peer: ${counts.settled} of ${counts.total} vouchers paid.`;
	} else if (state === 'CLOSED') {
		detail = `${counts.settled} of ${counts.total} vouchers were paid while away${counts.unsettled > 0 ? `; ${counts.unsettled} not paid` : ''}.`;
	} else if (state === 'ABORTED') {
		detail = `Setup aborted${epoch.abortReason != null ? `: ${abortReasonText(epoch.abortReason)}` : ''}. Nothing was locked.`;
	} else {
		detail = 'Committing the voucher book with the settlement peer.';
	}
	return { label, tone, detail, state, mismatch, enforced, ...counts, returnBy, warn };
}

/** A slot's state in plain words. */
export function slotLabel(slot) {
	switch (slot && slot.state) {
		case 'unissued':
			return 'Waiting for an invoice';
		case 'exposed':
			return 'Invoice shared';
		case 'settled':
			return 'Paid while away';
		case 'unsettled':
			return 'Not paid';
		case 'settling':
			return 'Settling';
		case 'unused':
			return 'Unused';
		default:
			return (slot && slot.state) || '-';
	}
}

export function slotTone(slot) {
	switch (slot && slot.state) {
		case 'settled':
			return 'green';
		case 'exposed':
			return 'blue';
		case 'unsettled':
			return 'red';
		default:
			return 'muted';
	}
}

/** The daemon's refusal in the words the card prints. */
export function refusalText(err) {
	const msg = (err && err.message) || 'The daemon refused.';
	if (/settlement service not offered/i.test(msg)) {
		return 'This peer does not settle offline receives. On a sibling wallet, turn on "Settle offline receives" in its Edit dialog; it restarts with the role.';
	}
	if (/does not advertise option_ff_receive/i.test(msg)) {
		return 'This peer does not speak the offline-receive protocol.';
	}
	if (/cannot cover budget/i.test(msg)) {
		return 'The peer cannot lock that much: the book plus its reserve is more than its side of the channel holds.';
	}
	if (/fee terms are below/i.test(msg)) {
		return "The peer's fee floor is above what this book offers. Raise the fees under Advanced.";
	}
	if (/live epoch|already/i.test(msg)) {
		return 'There is already an epoch on this channel.';
	}
	if (/budget above|epoch longer/i.test(msg)) {
		return `The peer's limits refuse this book: ${msg}`;
	}
	return msg;
}

/**
 * What the manager's return produced (rec.fforReturn), in the panel's
 * words. Never complete while the peer was unreachable (action 'nothing')
 * or a slot still reads unsettled: the credit is only real once the epoch
 * closed with the settled bitmap in hand.
 */
export function describeReturn(ret) {
	if (!ret || typeof ret !== 'object') return null;
	const counts = slotCounts(ret.epoch);
	// preimagesKnown is what witnesses returned before the close; a
	// cooperative close credits through the settled bitmap.
	const credited = Math.max(Array.isArray(ret.preimagesKnown) ? ret.preimagesKnown.length : 0, counts.settled);
	const action = ret.action || (ret.error ? 'failed' : 'nothing');
	const state = ret.epoch ? ret.epoch.state : null;
	const outcome = ret.outcome || returnOutcome({ action, state, channelState: ret.channelState, error: ret.error });
	const complete = (outcome === 'closed' || outcome === 'force-closed') && counts.unsettled === 0;
	let tone = 'green';
	let title;
	let detail;
	if (outcome === 'failed') {
		tone = 'red';
		title = 'The return failed';
		detail = ret.error || 'The daemon refused.';
	} else if (outcome === 'unreachable') {
		tone = 'yellow';
		title = 'Your settlement peer was not reachable';
		detail = `${counts.settled} of ${counts.total} vouchers are known paid so far. The epoch stays open until the peer is back, or you enforce it on-chain.`;
	} else if (outcome === 'draining') {
		tone = 'blue';
		title = 'Closing the book with your settlement peer';
		detail = `${counts.settled} of ${counts.total} vouchers known paid so far; the rest are settling. This updates by itself.`;
	} else if (outcome === 'enforced') {
		tone = 'yellow';
		title = 'Enforced on-chain';
		detail = `The channel is closed with ${counts.settled} of ${counts.total} vouchers known paid; they are claimed as the close confirms.`;
	} else if (outcome === 'force-closed') {
		tone = 'yellow';
		title = 'Enforced on-chain';
		detail = `${credited} voucher${credited === 1 ? '' : 's'} claimed through the force close. The funds return as the close confirms.`;
	} else {
		title = complete ? 'Back online, epoch closed' : 'Back online';
		detail =
			counts.settled === 0
				? 'Nothing was paid while away; the vouchers were released back to the peer.'
				: `${counts.settled} voucher${counts.settled === 1 ? '' : 's'} paid while away, credited to your channel balance${
						counts.unsettled > 0 ? `; ${counts.unsettled} not paid` : ''
				  }.`;
	}
	return { action, outcome, credited, complete, tone, title, detail, state, at: ret.at || null, channelId: ret.channelId || null, ...counts };
}

/**
 * What a return came to, from the epoch and the channel rather than the
 * daemon's action alone: the action says what the recover call initiated,
 * and it is 'nothing' for a drain in progress and for an epoch already
 * closed as well as for a peer that is not there. Mirrors the manager.
 */
export function returnOutcome({ action, state, channelState, error }) {
	if (error) return 'failed';
	if (state === 'CLOSED' || state === 'ABORTED') return action === 'force-closed' ? 'force-closed' : 'closed';
	if (action === 'force-closed') return 'force-closed';
	if (state === 'DRAINING') return 'draining';
	if (isClosedChannelState(channelState)) return 'enforced';
	return 'unreachable';
}

/** The siblings the card may name as witnesses: those that keep receipts, other than the settlement peer. */
export function witnessCandidates(candidates, settlerNodeId) {
	return (candidates || []).filter((c) => c.witnesses && c.nodeId !== settlerNodeId);
}

/** The offer an issuer answers for this epoch, if the manager holds one for it. */
export function issuanceFor(rec, epoch) {
	if (!rec || !epoch || !rec.fforIssuance) return null;
	const iss = rec.fforIssuance[epoch.channelId];
	return iss && iss.epochId === epoch.epochId ? iss : null;
}

const SETUP_STEPS = {
	starting: 'Starting the book with the settlement peer',
	activating: 'The two sides are signing the book',
	provisioning: 'Provisioning the witnesses',
	issuing: 'Handing the issuer its offer',
	done: 'Set up',
	failed: 'Failed'
};

/**
 * The manager's epoch setup (rec.fforSetup) in the card's words: the
 * current step, one line per witness, the issuer's line, and the error.
 */
export function describeSetup(setup) {
	if (!setup) return null;
	const witnesses = (setup.witnesses || []).map((w) => ({
		name: w.name,
		text:
			w.step === 'acknowledged'
				? `${w.name}: acknowledged the book`
				: w.step === 'failed'
				? `${w.name}: ${w.error || 'failed'}`
				: w.step === 'pending'
				? `${w.name}: waiting`
				: `${w.name}: ${w.step}`,
		tone: w.step === 'acknowledged' ? 'green' : w.step === 'failed' ? 'red' : 'muted'
	}));
	const issuer = setup.issuer
		? {
				name: setup.issuer.name,
				text:
					setup.issuer.step === 'provisioned'
						? `${setup.issuer.name}: issues invoices for this book`
						: setup.issuer.step === 'failed'
						? `${setup.issuer.name}: ${setup.issuer.error || 'failed'}`
						: `${setup.issuer.name}: ${setup.issuer.step}`,
				tone: setup.issuer.step === 'provisioned' ? 'green' : setup.issuer.step === 'failed' ? 'red' : 'muted'
		  }
		: null;
	return {
		running: !!setup.running,
		step: setup.step,
		label: SETUP_STEPS[setup.step] || setup.step,
		error: setup.error || null,
		witnesses,
		issuer,
		failed: !!setup.error
	};
}

/** One line per witness the return asked, from /ffor/recover's witnesses[]. */
export function witnessLines(witnesses, candidates = []) {
	const names = new Map((candidates || []).map((c) => [c.nodeId, c.name]));
	return (witnesses || []).map((w) => {
		const name = names.get(w.witnessNodeId) || `${String(w.witnessNodeId).slice(0, 8)}…`;
		if (!w.ok) return { name, tone: 'red', text: `${name} did not answer${w.error ? ` (${w.error})` : ''}` };
		const bad = (w.records || []).filter((r) => r.verified === false).length;
		return {
			name,
			tone: w.credited > 0 ? 'green' : 'muted',
			text: `${name}: ${(w.records || []).length} receipt${(w.records || []).length === 1 ? '' : 's'}, ${w.credited} credited${bad > 0 ? `, ${bad} did not verify` : ''}`
		};
	});
}

// The invoice for a slot is handed out once by the daemon and never again
// (the epoch view says the slot is exposed, not what was minted), so the
// dashboard keeps what it minted for the session.
const KEY = (walletId) => `beignet-ffor-${walletId}`;

function readMemory(walletId) {
	try {
		return JSON.parse(sessionStorage.getItem(KEY(walletId)) || '{}') || {};
	} catch (_) {
		return {};
	}
}

export function rememberSlotInvoice(walletId, epochId, k, invoice) {
	try {
		const all = readMemory(walletId);
		const mine = all[epochId] || {};
		mine[k] = invoice;
		all[epochId] = mine;
		sessionStorage.setItem(KEY(walletId), JSON.stringify(all));
	} catch (_) {
		/* no storage, no memory */
	}
}

export function slotInvoices(walletId, epochId) {
	return readMemory(walletId)[epochId] || {};
}
