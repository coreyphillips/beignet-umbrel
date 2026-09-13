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
 *
 * A rejection means the daemon's own answer, though. A request the browser
 * lost (a backgrounded mobile tab, a dropped connection) is no answer at all:
 * the daemon keeps offering after the page stops listening, so a plain send
 * then races a funding the recipient can still accept (umbrel #140).
 */

const PRE_WITNESS = new Set(['CREATED', 'OFFERED']);
const SETTLED = new Set(['MEMPOOL_SEEN', 'CONFIRMED']);

// Codes that do not come from the daemon's answer to this call: the manager
// standing in for a daemon it could not reach or that is not running, the
// client giving up on the wait, and a key clash that says nothing about the
// funding. A thrown error with no code at all (a fetch that lost its
// connection, a body that was not the daemon's JSON) is not an answer either.
const NOT_AN_ANSWER = new Set(['PROXY_ERROR', 'NOT_RUNNING', 'WALLET_UNRESPONSIVE', 'IDEMPOTENCY_CONFLICT']);

/** Whether an error is the daemon refusing the funding, rather than no answer. */
export function isRefusal(error) {
	const code = error && error.code;
	return typeof code === 'string' && code !== '' && !NOT_AN_ANSWER.has(code);
}

/**
 * Returns { kind: 'fallback', reason } when a plain send is safe,
 * { kind: 'unknown', reason } when no answer arrived and nothing may follow
 * yet, or { kind: 'sent', ... } describing the funding as the daemon reported
 * it.
 */
export function fundingOutcome(answer) {
	if (answer instanceof Error) {
		if (!isRefusal(answer)) {
			return { kind: 'unknown', reason: answer.message || 'no answer from the wallet' };
		}
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

// Asking again is safe because the daemon is idempotent on the request id: a
// second POST joins the exchange in flight or replays what it recorded, and
// never spends a second coin.
const UNKNOWN_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
// The daemon's exchange runs for a 120 s offer window and then a 45 s receipt
// window. Past that, asking has had every chance to come back with a real
// answer, so a page still in view stops and says the outcome is unknown.
export const UNKNOWN_RETRY_BUDGET_MS = 180_000;

/** An X-Idempotency-Key for one send, kept across its retries. */
export function idempotencyKey() {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function untilVisible(doc) {
	return new Promise((resolve) => {
		const onChange = () => {
			if (doc.hidden) return;
			doc.removeEventListener('visibilitychange', onChange);
			resolve();
		};
		doc.addEventListener('visibilitychange', onChange);
	});
}

/**
 * POST /direct-funding/send until the daemon answers, and return the outcome.
 *
 * `post` makes the call, the same body and key every time. Without an answer
 * it asks again with backoff while the page is in view; a hidden page waits
 * until it is shown again (a mobile browser would only drop the request once
 * more) and always asks at least once on return, however long it was away.
 * `onUnknown` hears each missing answer, so the card can say it is waiting.
 * An outcome still unknown when the budget runs out comes back as such: it
 * never turns into a fallback.
 */
export async function sendDirectFunding(
	post,
	{
		onUnknown = () => {},
		budgetMs = UNKNOWN_RETRY_BUDGET_MS,
		delaysMs = UNKNOWN_RETRY_DELAYS_MS,
		doc = globalThis.document,
		now = Date.now
	} = {}
) {
	const started = now();
	for (let attempt = 0; ; attempt++) {
		let answer;
		try {
			answer = await post();
		} catch (e) {
			answer = e instanceof Error ? e : new Error(String(e));
		}
		const outcome = fundingOutcome(answer);
		if (outcome.kind !== 'unknown') return outcome;
		onUnknown(outcome);
		if (doc && doc.hidden) {
			await untilVisible(doc);
			continue;
		}
		if (now() - started >= budgetMs) return outcome;
		await new Promise((r) => setTimeout(r, delaysMs[Math.min(attempt, delaysMs.length - 1)]));
	}
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

/** The note for a direct funding whose answer never arrived. */
export function describeUnknown({ reason, waiting }) {
	const said = `The wallet's answer to the direct funding did not arrive (${inline(
		reason
	)}), so whether the recipient took it is not known yet.`;
	if (waiting) {
		return `${said} Nothing will be paid to the address unless the wallet answers that it was refused. Asking again.`;
	}
	return `${said} Nothing was paid to the address. Check Activity before paying again: paying this same request again picks up the first attempt if the wallet has one, and never spends a second coin.`;
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
