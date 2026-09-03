// The close story of a closing or closed channel, in the words the detail
// view prints. Pure: it reads the daemon's closeStatus (beignet 0.9.0+, on
// each /channels row for closing and closed channels) and the current block
// height, and answers what happened, whether the close has confirmed, when
// the funds come back, and whether asking the daemon to rebroadcast makes
// sense. Everything the daemon cannot say is said as such, never guessed: a
// confirmationHeight of 0 covers both "not yet confirmed" and "the daemon has
// not reported it", so the line reads "not yet reported" rather than a
// claim about the chain.

const MINUTES_PER_BLOCK = 10;

// The automatic close reasons the engine stamps (closeStatus.reason) when it
// closed a channel on its own, in plain words. Anything unlisted prints its
// code, so a newer engine's reasons still show up.
const REASONS = {
	REESTABLISH_TIMEOUT_FORCE_CLOSED:
		'the peer stayed away past the reestablish deadline, so the watchdog force-closed it',
	HTLC_TIMEOUT_FORCE_CLOSED:
		'an in-flight payment reached its deadline, so the channel was force-closed to claim it',
	PROTOCOL_VIOLATION: 'the peer broke the protocol',
	FUNDING_MISSING: 'the funding transaction never appeared on chain',
	PEER_ERROR: 'the peer sent an error for this channel'
};

function humanizeReason(code) {
	if (!code) return null;
	if (REASONS[code]) return REASONS[code];
	return code.replace(/_/g, ' ').toLowerCase();
}

/** Who closed the channel and why, as one sentence. */
export function closerSentence(status) {
	if (!status) return null;
	switch (status.closer) {
		case 'cooperative':
			return status.reason === 'user'
				? 'You closed this channel cooperatively.'
				: 'Closed cooperatively.';
		case 'remote':
			return 'The peer closed it.';
		case 'local':
			if (!status.reason || status.reason === 'user') return 'You closed this channel.';
			return `This wallet force-closed it: ${humanizeReason(status.reason)}.`;
		default:
			return 'Closed; the daemon could not tell who closed it.';
	}
}

/** Blocks as a rough wall-clock duration at ten minutes a block. */
export function fmtBlocksDuration(blocks) {
	if (!(blocks > 0)) return 'now';
	const minutes = blocks * MINUTES_PER_BLOCK;
	if (minutes < 60) return `about ${minutes} minutes`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `about ${hours} hour${hours === 1 ? '' : 's'}`;
	const days = Math.round(hours / 24);
	return `about ${days} days`;
}

/**
 * The display facts for a close. `blockHeight` is the wallet's current tip
 * (from /info); when it is unknown the confirmation count and the funds ETA
 * are left null and the lines say only what the daemon said.
 */
export function closeStory(status, blockHeight) {
	if (!status) return null;
	const tip = Number.isFinite(blockHeight) && blockHeight > 0 ? blockHeight : null;
	const confirmedAt = status.confirmationHeight > 0 ? status.confirmationHeight : null;
	const confirmations =
		confirmedAt && tip ? Math.max(1, tip - confirmedAt + 1) : null;

	let confirmation;
	if (confirmedAt) {
		confirmation =
			confirmations != null
				? `Confirmed at block ${confirmedAt} (${confirmations} confirmation${confirmations === 1 ? '' : 's'}).`
				: `Confirmed at block ${confirmedAt}.`;
	} else if (!status.closingTxid) {
		confirmation = 'No closing transaction recorded yet.';
	} else if (!status.broadcast) {
		confirmation = 'The closing transaction has not reached the network yet.';
	} else {
		confirmation = 'Broadcast; confirmation not yet reported by the daemon.';
	}

	let funds = null;
	let fundsBlocksLeft = null;
	if (status.fundsAvailableHeight) {
		if (tip && status.fundsAvailableHeight <= tip) {
			fundsBlocksLeft = 0;
			funds = 'Your balance is spendable: the timelock has matured.';
		} else if (tip) {
			fundsBlocksLeft = status.fundsAvailableHeight - tip;
			funds = `Your balance becomes spendable at block ${status.fundsAvailableHeight}, ${fundsBlocksLeft} block${fundsBlocksLeft === 1 ? '' : 's'} from now (${fmtBlocksDuration(fundsBlocksLeft)}).`;
		} else {
			funds = `Your balance becomes spendable at block ${status.fundsAvailableHeight}.`;
		}
	}

	let resolution;
	switch (status.resolution) {
		case 'resolved':
			resolution = 'Every output of the close has been swept; nothing is left on chain.';
			break;
		case 'sweeping':
			resolution = 'Sweeping the close outputs back into the wallet.';
			break;
		default:
			resolution = confirmedAt
				? 'Waiting to sweep the close outputs.'
				: 'Nothing is being swept until the close confirms.';
	}

	// A rebroadcast can only help a close the network may not have: a known
	// closing txid that has not confirmed, or one the daemon never got out.
	const canRebroadcast =
		!!status.closingTxid && (!confirmedAt || status.broadcast === false);

	return {
		closer: closerSentence(status),
		closingTxid: status.closingTxid || null,
		confirmedAt,
		confirmations,
		confirmation,
		funds,
		fundsBlocksLeft,
		resolution,
		canRebroadcast
	};
}

/**
 * Whether a rebroadcast refusal means the network already has the close,
 * which is a calm notice rather than an error: the daemon answers this way
 * for a close that confirmed, or whose outputs are already in the utxo set.
 */
export function rebroadcastAlreadyDone(message) {
	return /already|utxo set|confirmed|in the chain/i.test(String(message || ''));
}
