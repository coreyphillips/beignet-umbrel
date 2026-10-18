/* Words for the daemon's codes. The raw code stays available (in a title,
   in a detail view) for anyone who needs to quote it; the list reads the word. */

const CHANNEL = {
	NORMAL: ['Active', 'green'],
	SPLICING: ['Splicing', 'yellow'],
	SENT_OPEN: ['Opening', 'yellow'],
	AWAITING_CHANNEL_READY: ['Confirming', 'yellow'],
	AWAITING_FUNDING_CONFIRMED: ['Confirming', 'yellow'],
	AWAITING_REESTABLISH: ['Reconnecting', 'yellow'],
	SHUTTING_DOWN: ['Closing', 'yellow'],
	NEGOTIATING_CLOSING: ['Closing', 'yellow'],
	FORCE_CLOSED: ['Force closed', 'red'],
	CLOSED: ['Closed', 'muted']
};

const PAYMENT = {
	COMPLETED: ['Completed', 'green'],
	SUCCEEDED: ['Completed', 'green'],
	SUCCESS: ['Completed', 'green'],
	PENDING: ['Pending', 'yellow'],
	IN_FLIGHT: ['In flight', 'yellow'],
	INFLIGHT: ['In flight', 'yellow'],
	FAILED: ['Failed', 'red']
};

const INVOICE = {
	PAID: ['Paid', 'green'],
	COMPLETED: ['Paid', 'green'],
	SETTLED: ['Paid', 'green'],
	EXPIRED: ['Expired', 'muted'],
	CANCELLED: ['Cancelled', 'muted'],
	CANCELED: ['Cancelled', 'muted'],
	PENDING: ['Open', 'muted'],
	OPEN: ['Open', 'muted'],
	UNPAID: ['Open', 'muted']
};

const WALLET = {
	running: ['Running', 'green'],
	stopped: ['Stopped', 'muted'],
	starting: ['Starting', 'yellow'],
	stopping: ['Stopping', 'yellow'],
	restarting: ['Restarting', 'yellow'],
	'waiting-electrum': ['Waiting for Electrum', 'yellow'],
	'restore-required': ['Restore needed', 'yellow'],
	crashed: ['Crashed', 'red'],
	failed: ['Failed', 'red']
};

/** "SOME_RAW_STATE" or "some-raw-state" read as "Some raw state". */
export function humanize(code) {
	if (code === null || code === undefined) return '';
	const s = String(code).replace(/[_-]+/g, ' ').trim().toLowerCase();
	return s ? s[0].toUpperCase() + s.slice(1) : '';
}

function pick(table, code, fallbackTone) {
	const raw = code === null || code === undefined ? '' : String(code);
	const hit = table[raw] || table[raw.toUpperCase()] || table[raw.toLowerCase()];
	if (hit) return { label: hit[0], tone: hit[1], raw };
	return { label: humanize(raw) || 'Unknown', tone: fallbackTone, raw };
}

export function channelStateLabel(state) {
	return pick(CHANNEL, state, 'muted');
}

export function paymentStatusLabel(status) {
	return pick(PAYMENT, status, 'muted');
}

export function invoiceStatusLabel(status) {
	return pick(INVOICE, status || 'open', 'muted');
}

export function walletStatusLabel(status) {
	return pick(WALLET, status, 'yellow');
}
