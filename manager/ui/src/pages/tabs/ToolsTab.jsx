import { useEffect, useState } from 'react';
import { useToast } from '../../components/Toast.jsx';
import { Badge, Button, Card, CopyText, Field } from '../../components/ui.jsx';
import { shortId } from '../../lib/format.js';

/**
 * Node-key signing, in both directions. Signing proves a message came from
 * whoever controls this node; verification recovers which node key signed a
 * message. The signature format is the LND-compatible one, so what is signed
 * here checks out under lncli verifymessage and vice versa.
 */
export default function ToolsTab({ api }) {
	return (
		<div className="grid cols-2">
			<SignCard api={api} />
			<VerifyCard api={api} />
		</div>
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
