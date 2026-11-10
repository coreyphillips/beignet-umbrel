import { useEffect, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { Badge, Button, Card, CopyText, Field } from '../../components/ui.jsx';
import { LnurlAuth, LnurlPay, LnurlWithdraw, useLnurlResolve } from '../../components/Lnurl.jsx';
import PaykitCard from '../../components/Paykit.jsx';
import { usePoll } from '../../hooks/usePoll.js';
import { shortId } from '../../lib/format.js';
import { parsePayment } from '../../lib/payment-uri.js';
import { channelSendableSats } from '../../lib/sendable.js';

/**
 * The wallet's tools:
 *
 * - Node-key signing, in both directions. Signing proves a message came from
 *   whoever controls this node; verification recovers which node key signed a
 *   message. The signature format is the LND-compatible one, so what is signed
 *   here checks out under lncli verifymessage and vice versa.
 * - LNURL: pay a link or a Lightning address, withdraw from a link, or log in
 *   to a site, whichever the pasted link turns out to be.
 * - Paykit: publish this wallet's payment details under its pubky, and look
 *   up anyone else's.
 */
export default function ToolsTab({ id, api, rec, bump, lastReceive }) {
	return (
		<div className="grid cols-2">
			<SignCard api={api} />
			<VerifyCard api={api} />
			<LnurlCard id={id} api={api} rec={rec} bump={bump} lastReceive={lastReceive} />
			<PaykitCard id={id} rec={rec} running={!!(rec?.healthy ?? rec?.status === 'running')} />
		</div>
	);
}

const usable = (c) => c.htlcUsable ?? c.state === 'NORMAL';

/**
 * One box for every kind of LNURL. What the link is for decides the panel
 * under it: a payment, a withdrawal, or a login.
 */
function LnurlCard({ id, api, rec, bump, lastReceive }) {
	const [text, setText] = useState('');
	const parsed = parsePayment(text, { network: rec?.network });
	const carried = parsed.kind === 'onchain' && parsed.lightning?.kind === 'lnurl' ? parsed.lightning : null;
	const lnurl = parsed.kind === 'lnurl' ? parsed : carried;
	const { link, error, resolving } = useLnurlResolve(id, lnurl?.input || null);
	const { data: channels } = usePoll(
		() => (rec?.onchainOnly ? Promise.resolve([]) : api.get('/channels').catch(() => null)),
		15000,
		[id]
	);
	const outbound = (channels || []).filter(usable).reduce((sum, c) => sum + channelSendableSats(c), 0);
	const needsLightning = link && (link.tag === 'pay' || link.tag === 'withdraw') && rec?.onchainOnly;
	const notLnurl = text.trim() && !lnurl && parsed.kind !== 'empty';

	return (
		<Card
			title="LNURL"
			help="Paste an LNURL or a Lightning address (name@domain). A pay link or address is paid from this wallet's channels; a withdraw link pays into this wallet; a login link signs you in with a key this wallet keeps for that one site. The Umbrel talks to the service itself, over Tor when this wallet's network mode is Tor, and checks the invoice it gets back matches what is shown here before anything is paid."
		>
			<Field label="LNURL or Lightning address">
				<textarea
					rows={3}
					value={text}
					onChange={(e) => setText(e.target.value)}
					placeholder="lnurl1… or name@domain.com"
				/>
			</Field>
			{notLnurl && (
				<div className="error-note" role="alert">
					{parsed.kind === 'invalid'
						? parsed.message
						: 'That is not an LNURL or a Lightning address. Invoices and addresses are paid from the Send tab.'}
				</div>
			)}
			{resolving && <div className="wallet-meta">Reading the link…</div>}
			{error && (
				<div className="error-note" role="alert">
					{error}
				</div>
			)}
			{needsLightning && (
				<div className="error-note" role="alert">
					This wallet is on-chain only, so it cannot {link.tag === 'pay' ? 'pay' : 'receive'} over Lightning.
					Lightning can be switched on in the wallet's Edit dialog.
				</div>
			)}
			{link && !needsLightning && link.tag === 'pay' && (
				<LnurlPay key={link.session} id={id} api={api} link={link} input={lnurl.input} outbound={outbound} bump={bump} />
			)}
			{link && !needsLightning && link.tag === 'withdraw' && (
				<LnurlWithdraw key={link.session} id={id} api={api} rec={rec} link={link} lastReceive={lastReceive} onDone={bump} />
			)}
			{link && link.tag === 'login' && <LnurlAuth key={link.session} id={id} link={link} />}
		</Card>
	);
}

function SignCard({ api }) {
	const toast = useToast();
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState(false);
	// { message, signature, pubkey }: the message is kept with its signature so
	// editing the field cannot leave a signature on screen over words it does
	// not sign.
	const [signed, setSigned] = useState(null);

	const sign = async () => {
		setBusy(true);
		try {
			const r = await api.post('/message/sign', { message });
			setSigned({ message, signature: r.signature, pubkey: r.pubkey });
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title="Sign a message">
			<Field
				label="Message"
				hint="Signing proves this exact text came from whoever controls this node. Sign only what you mean to stand behind: the signature works for anyone who has it, forever."
			>
				<textarea
					rows={4}
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="The text to sign"
				/>
			</Field>
			<Button variant="primary" busy={busy} onClick={sign} disabled={!message}>
				Sign with node key
			</Button>
			{signed && signed.message === message && (
				<div className="info-note" role="status" style={{ marginTop: 14 }}>
					<div className="field-label">Signature</div>
					<CopyText value={signed.signature} truncate />
					<div className="wallet-meta" style={{ marginTop: 8 }}>
						Signed by <CopyText value={signed.pubkey} label={shortId(signed.pubkey)} />, this
						node's identity key. Anyone can check it in the card beside this one, or with
						lncli verifymessage.
					</div>
				</div>
			)}
		</Card>
	);
}

function VerifyCard({ api }) {
	const toast = useToast();
	const [message, setMessage] = useState('');
	const [signature, setSignature] = useState('');
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(null);

	// A verdict is about one exact message and one exact signature. The moment
	// either changes, the verdict on screen stops being about what is in the
	// boxes, so it goes rather than stands over words it never judged.
	useEffect(() => {
		setResult(null);
	}, [message, signature]);

	const verify = async () => {
		setBusy(true);
		try {
			const r = await api.post('/message/verify', {
				message,
				signature: signature.trim()
			});
			setResult(r);
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title="Verify a message">
			<Field label="Message" hint="Exactly as it was signed. One changed character is a different message.">
				<textarea
					rows={4}
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					placeholder="The text that was signed"
				/>
			</Field>
			<Field label="Signature">
				<input
					value={signature}
					onChange={(e) => setSignature(e.target.value)}
					placeholder="d7yxk3…"
				/>
			</Field>
			<Button
				variant="primary"
				busy={busy}
				onClick={verify}
				disabled={!message || !signature.trim()}
			>
				Verify
			</Button>
			{result && !result.valid && (
				<div className="error-note" role="alert" style={{ marginTop: 14 }}>
					Not a valid signature over this message. Either the signature is damaged, or the
					message is not exactly the text that was signed.
				</div>
			)}
			{result?.valid && (
				<div className="info-note" role="status" style={{ marginTop: 14 }}>
					<Badge tone="green">valid</Badge>
					{result.knownNode ? (
						<Badge tone="blue">announced node</Badge>
					) : (
						<Badge tone="muted">not in the graph</Badge>
					)}
					<div style={{ marginTop: 8 }}>
						Signed by <CopyText value={result.pubkey} label={shortId(result.pubkey)} />.
					</div>
					{/* The half of verification no daemon can do. A signature recovers
					    WHOSE key signed; only the reader knows whose key was expected,
					    and "valid" from the wrong key is a valid signature by someone
					    else. */}
					<div className="wallet-meta" style={{ marginTop: 8 }}>
						Valid means signed by this key. Check that this is the node you expected: a
						signature from any other key reads as valid too, it is just someone else's.
						{result.knownNode
							? ' This key belongs to a node announced in the network graph.'
							: ' This key is not announced in the network graph, which is normal for private nodes.'}
					</div>
				</div>
			)}
		</Card>
	);
}
