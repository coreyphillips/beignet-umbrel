/**
 * What to do with what POST /direct-funding/send answered.
 *
 * The daemon's contract: the call REJECTS only before our witness has left
 * the device. After that it resolves, with whatever is known and a `caveat`,
 * because a payer that falls back to a plain on-chain send on any error
 * cannot tell a late rejection from an early one and would pay twice. So
 * the only answers that permit the plain send are a rejection and a status
 * from before the witness went out (CREATED, OFFERED); everything else is a
 * payment that is out of our hands, to be shown as it stands.
 */

const PRE_WITNESS = new Set(['CREATED', 'OFFERED']);
const SETTLED = new Set(['MEMPOOL_SEEN', 'CONFIRMED']);

/**
 * Returns { kind: 'fallback', reason } when a plain send is safe, or
 * { kind: 'sent', ... } describing the funding as the daemon reported it.
 */
export function fundingOutcome(answer) {
	if (answer instanceof Error) {
		return { kind: 'fallback', reason: answer.message || 'The direct funding was refused.' };
	}
	const status = answer && answer.status;
	if (!answer || PRE_WITNESS.has(status)) {
		return {
			kind: 'fallback',
			reason: answer && answer.caveat ? answer.caveat : 'The recipient did not take the direct funding.'
		};
	}
	return {
		kind: 'sent',
		status,
		txid: answer.fundingTxid || answer.spentTxid || null,
		amountSats: answer.amountSat ?? null,
		attested: answer.attested === true,
		receiptPreimageHex: answer.receiptPreimageHex || null,
		caveat: answer.caveat || null,
		settled: SETTLED.has(status),
		failed: status === 'FAILED' || status === 'ABORTED'
	};
}

/**
 * What a fallback leaves behind for the manager's durable record.
 *
 * The reason is the whole point of it: it exists in the daemon's answer to the
 * payer and nowhere else, and the ordinary payment that follows looks like any
 * other send. The rest names the request that was being paid, so a transaction
 * gone back to weeks later can be told apart from one that was never meant to
 * be a direct funding at all (umbrel #121).
 */
export function fallbackRecord(reason, { funding, address, amountSats, txid = null, error = null } = {}) {
	return {
		reason,
		address: address || null,
		amountSats: Number.isFinite(amountSats) ? amountSats : null,
		nodeId: (funding && funding.nodeId) || null,
		requestId: (funding && funding.requestId) || null,
		txid,
		error
	};
}

/** Save the diagnostic without turning a logging failure into a payment failure. */
export async function persistFallback(record, save) {
	try {
		const saved = await save(record);
		return { ...record, persisted: saved?.persisted === true };
	} catch (_) {
		return { ...record, persisted: false };
	}
}

/**
 * A reason is said in the middle of our own sentence, and arrives as anything
 * from a bare clause to a full sentence with a full stop. An ALL_CAPS code or
 * an identifier is left as it came: lowercasing one makes it a different
 * string.
 */
function inline(reason) {
	const said = String(reason || '').trim().replace(/\.$/, '');
	return /^[A-Z][a-z]/.test(said) ? said[0].toLowerCase() + said.slice(1) : said;
}

/** The line a fallback gets wherever it is shown, on the card or a month later. */
export function describeFallback(entry) {
	const reason = `This was meant to be a direct funding: paid that way, the transaction would have become the recipient's channel funding. That did not happen (${inline(
		entry.reason
	)})`;
	if (entry.error) return `${reason}. The ordinary payment also failed (${inline(entry.error)}).`;
	if (entry.pending) return `${reason}. An ordinary payment is being attempted.`;
	return `${reason}, so it went out as an ordinary payment.`;
}

/** One sentence for a sent outcome, said the way the daemon's status means it. */
export function describeFunding(outcome) {
	if (outcome.kind !== 'sent') return outcome.reason;
	if (outcome.settled) {
		return outcome.attested
			? 'Paid as direct funding: your coins are now the recipient\'s channel funding, and their node signed a receipt for it.'
			: 'Paid as direct funding: the funding transaction is out.';
	}
	if (outcome.failed) {
		return `The direct funding did not complete (${outcome.status.toLowerCase()}).${
			outcome.caveat ? ` ${outcome.caveat}` : ''
		} Your coin was not spent elsewhere; check the transaction before paying again.`;
	}
	return `The funding is signed and on its way (${outcome.status.toLowerCase().replace('_', ' ')}).${
		outcome.caveat ? ` ${outcome.caveat}` : ''
	}`;
}
