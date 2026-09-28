/**
 * Payments this page started, so the live event for one is not announced a
 * second time.
 *
 * Every card that pays (the Send tab's Lightning and keysend cards, the Offers
 * tab) toasts the outcome from the daemon's answer, which carries the status
 * and the reason. The daemon also emits payment:sent or payment:failed for the
 * same payment on its event stream, and the wallet page toasted that too, so
 * every payment said "Payment sent" twice. The stream's toast is kept for the
 * payments nobody here announced (the Console tab, the CLI, another browser
 * tab), which is the one case it is the only word on the matter.
 *
 * The event can arrive before the HTTP answer does, so a payment in flight
 * claims every payment event until it returns; after that its hash does, for a
 * while, in case the event is the slower of the two.
 */

const KEEP_MS = 2 * 60 * 1000;

let nextToken = 0;
const inFlight = new Set();
/** paymentHash -> when its payment returned. */
const settled = new Map();

function prune(now) {
	for (const [hash, at] of settled) if (now - at > KEEP_MS) settled.delete(hash);
}

/** Called right before a payment is asked for; hand the token to endOwnPayment. */
export function beginOwnPayment() {
	const token = ++nextToken;
	inFlight.add(token);
	return token;
}

/** Called once the answer is in, or the request failed, with the hash when known. */
export function endOwnPayment(token, paymentHash, now = Date.now()) {
	inFlight.delete(token);
	prune(now);
	if (paymentHash) settled.set(paymentHash, now);
}

/** Whether a payment event's data belongs to a payment this page announced itself. */
export function isOwnPayment(data, now = Date.now()) {
	if (inFlight.size > 0) return true;
	prune(now);
	return !!data?.paymentHash && settled.has(data.paymentHash);
}

/** Tests only: forget everything. */
export function resetOwnPayments() {
	inFlight.clear();
	settled.clear();
}
