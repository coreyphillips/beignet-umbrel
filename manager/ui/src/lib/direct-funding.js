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
