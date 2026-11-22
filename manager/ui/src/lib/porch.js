/** The Porch rows the edit form starts from: a saved token is shown as saved, never as text. */
export function porchRows(rec) {
	return (rec?.porch?.relays || []).map((relay) => ({ url: relay.url, hasToken: !!relay.hasToken, token: '', removeToken: false }));
}

/**
 * The porch block of a wallet update. A token is sent only when one was
 * typed (set or replace) or removed on purpose (null); left out, the saved
 * one is kept. Turning Porch off sends nothing else, so a half-typed relay
 * never blocks it.
 */
export function porchBody(enabled, via, rows) {
	if (!enabled) return { enabled: false };
	const relays = rows
		.filter((row) => row.url.trim())
		.map((row) => {
			if (row.token.trim()) return { url: row.url.trim(), token: row.token.trim() };
			if (row.removeToken) return { url: row.url.trim(), token: null };
			return { url: row.url.trim() };
		});
	return { enabled: true, via, relays };
}

export function porchChanged(rec, enabled, via, rows) {
	const was = rec?.porch || {};
	if (enabled !== !!was.enabled) return true;
	if (!enabled) return false;
	if (via !== (was.via || 'default')) return true;
	const before = (was.relays || []).map((relay) => relay.url).join(' ');
	return before !== rows.map((row) => row.url.trim()).join(' ') || rows.some((row) => row.token.trim() || row.removeToken);
}

const STATES = {
	ready: 'Ready',
	connecting: 'Connecting',
	unreachable: 'Unreachable',
	refused: 'Refused',
	'no-links': 'No links',
	stopped: 'Stopped'
};

export function relayStateLabel(state) {
	return STATES[state] || state || 'Unknown';
}

/** What a relay's state asks of the owner, when it asks anything. */
export function relayAdvice(relay) {
	if (relay?.state === 'refused') return 'The relay turned this wallet down. Check its registration token, or whether the relay allows more links.';
	if (relay?.state === 'unreachable') return 'The relay could not be reached. Check the URL and that the relay is running; the wallet keeps trying.';
	return null;
}
