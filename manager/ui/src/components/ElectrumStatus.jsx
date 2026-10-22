import { Button } from './ui.jsx';

/**
 * What the dashboard says about an Electrum server it has probed
 * (manager: electrum-probe.js). One rule for the preset badges, the Test
 * button and the wrong-chain refusal, so the three agree.
 */

const CHAIN_NAMES = { mainnet: 'mainnet', testnet: 'testnet', testnet4: 'testnet4', signet: 'signet', regtest: 'regtest' };

/** A fingerprint as openssl prints it, so it can be compared by eye. */
export function colonFingerprint(hex) {
	if (!hex) return '';
	return String(hex)
		.toUpperCase()
		.match(/../g)
		.join(':');
}

/** Whether the server was asked over TLS: a preset carries `tls`, a test result its `electrum`. */
function askedWithTls(result) {
	return result.tls === true || !!(result.electrum && result.electrum.tls);
}

/**
 * The key a refusal is filed under: the server and network it was for. A
 * refusal shown under the fields must be for what the fields say now, or a
 * late answer about one server could wave through another with "Save
 * anyway". The dialogs compute it when they ask and again when they render.
 */
export function chainKey(electrum, network = null) {
	const e = electrum && electrum.host !== undefined ? { host: String(electrum.host || '').trim(), port: parseInt(electrum.port, 10), tls: !!electrum.tls } : null;
	return JSON.stringify([e, network || null]);
}

/**
 * A probe result as one short status: `{ state, tone, text }`. `network` is
 * what the server is meant to serve; a server known to be on another chain
 * is called out as such rather than shown as fine.
 */
export function describeProbe(result, network = null, { loading = false } = {}) {
	if (!result) {
		return loading ? { state: 'checking', tone: 'muted', text: 'checking' } : { state: 'unknown', tone: 'muted', text: '' };
	}
	if (!result.reachable) return { state: 'unreachable', tone: 'muted', text: 'not found' };
	if (result.error === 'tls-rejected') return { state: 'tls-rejected', tone: 'red', text: 'certificate refused' };
	if (result.error === 'tls-mismatch') {
		return { state: 'tls-mismatch', tone: 'yellow', text: askedWithTls(result) ? 'not a TLS server' : 'TLS only' };
	}
	if (result.error === 'bad-reply') return { state: 'unreachable', tone: 'muted', text: 'not an Electrum server' };
	const known = result.chain && result.chain !== 'unknown';
	if (result.error === 'timeout' && !result.software && !known) {
		return { state: 'unreachable', tone: 'muted', text: 'no answer' };
	}
	if (network && known && result.chain !== network) {
		return { state: 'wrong-chain', tone: 'yellow', text: `${CHAIN_NAMES[result.chain] || result.chain}, not ${network}` };
	}
	const chain = known ? CHAIN_NAMES[result.chain] || result.chain : 'chain unknown';
	const height = typeof result.height === 'number' ? result.height.toLocaleString('en-US') : null;
	return { state: 'reachable', tone: 'green', text: height ? `${chain} · ${height}` : chain };
}

/**
 * The Test button's answer, in sentences: who answered, on which chain and
 * how far along, what the certificate looked like, and whether the chain is
 * the one asked for. `result` is the manager's /api/electrum/test answer.
 */
export function describeTest(result) {
	const where = `${result.electrum ? result.electrum.host : ''}${result.electrum ? `:${result.electrum.port}` : ''}`;
	if (!result.reachable) {
		return { state: 'unreachable', text: `Nothing answered at ${where}. Check the address and that the server is running.` };
	}
	if (result.error === 'tls-rejected') {
		const fp = result.certificate && result.certificate.fingerprint ? colonFingerprint(result.certificate.fingerprint) : null;
		return {
			state: 'tls-rejected',
			text: `Connected, but the certificate is not one the wallet would trust${
				fp ? `. Its fingerprint is ${fp}; pin it below only if whoever runs the server confirms it.` : '.'
			}`
		};
	}
	if (result.error === 'tls-mismatch') {
		return {
			state: 'tls-mismatch',
			text: askedWithTls(result)
				? `Connected to ${where}, but it did not complete a TLS handshake. It is probably a plaintext server: untick TLS and test again.`
				: `${where} did not answer plaintext; it is probably a TLS server. Tick TLS and test again.`
		};
	}
	if (result.error === 'bad-reply') {
		return { state: 'unreachable', text: `Something answered at ${where}, but it does not speak Electrum.` };
	}
	const known = result.chain && result.chain !== 'unknown';
	if (result.error === 'timeout' && !result.software && !known) {
		return {
			state: 'unreachable',
			text: `Connected to ${where}, but it gave no Electrum answer in time.${askedWithTls(result) ? ' If the server is plaintext, untick TLS and test again.' : ''}`
		};
	}
	const parts = [];
	parts.push(result.software ? `${result.software} answered` : 'An Electrum server answered');
	if (known) parts.push(`on ${CHAIN_NAMES[result.chain] || result.chain}`);
	if (typeof result.height === 'number') parts.push(`at height ${result.height.toLocaleString('en-US')}`);
	let text = `${parts.join(' ')}.`;
	if (result.certificate) {
		// What the certificate is depends on how it was asked: with
		// verification on, an accepted certificate is a public one or a
		// pinned one; with it off, anything is accepted, and one no authority
		// signed for this host (self-signed, expired, another name, reached
		// by IP) is reported as that, with the fingerprint there to pin.
		const fp = result.certificate.fingerprint ? ` (${colonFingerprint(result.certificate.fingerprint)})` : '';
		const verifying = !!(result.electrum && result.electrum.tlsVerify === true);
		if (result.certificate.authorized) text += ` The certificate is signed by a public authority${fp}.`;
		else if (verifying && result.certificate.accepted) text += ` The certificate matches a pinned fingerprint${fp}.`;
		else if (result.certificate.accepted) {
			text += ` No public authority signed the certificate for this host${fp}; with verification on, pin it to hold the wallet to it.`;
		}
	}
	if (result.chainMatches === false) {
		return { state: 'wrong-chain', text: `${text} That is ${result.chain}, not ${result.network}.` };
	}
	return { state: 'reachable', text };
}

/** The one-line status under a preset's name. */
export function ServerStatus({ result, network, loading = false, ...rest }) {
	const d = describeProbe(result, network, { loading });
	if (!d.text) return null;
	return (
		<span className="preset-status" data-state={d.state} data-tone={d.tone} {...rest}>
			<span className="dot" />
			{d.text}
		</span>
	);
}

/**
 * The manager refused a server because it serves another chain than the
 * wallet is on. The refusal names the two chains; the button repeats the
 * request with the override the manager honours.
 */
export function ChainMismatchNote({ error, onProceed, busy = false }) {
	if (!error || error.code !== 'ELECTRUM_WRONG_CHAIN') return null;
	return (
		<div className="error-note" role="alert" data-testid="electrum-wrong-chain">
			<div>{error.message}</div>
			<div style={{ marginTop: 8 }}>
				<Button className="sm" data-testid="electrum-save-anyway" busy={busy} onClick={onProceed}>
					Save anyway
				</Button>
			</div>
		</div>
	);
}
