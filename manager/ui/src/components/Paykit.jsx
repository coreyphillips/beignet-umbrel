import { useEffect, useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Badge, Button, Card, CopyText, ErrorNote, Field, Help, Modal, QR, SeedWords } from './ui.jsx';
import { copy, fmtDate } from '../lib/format.js';
import { pubkyOf } from '../lib/payment-uri.js';

// What each published identifier is, in words.
const IDENTIFIER_NAMES = {
	'btc-lightning-bolt12': 'Lightning offer',
	'btc-lightning-bolt11': 'Lightning invoice',
	'btc-bitcoin-p2wpkh': 'Bitcoin address',
	'btc-bitcoin-p2tr': 'Bitcoin address (taproot)',
	'btc-bitcoin-bip21': 'Direct funding request'
};
const nameOf = (identifier) => IDENTIFIER_NAMES[identifier] || identifier;

/**
 * Paykit: this wallet's payment details published under its pubky, so any
 * beignet wallet (or other Paykit wallet) can pay it from the pubky alone,
 * and a lookup of anyone else's.
 */
export default function PaykitCard({ id, rec, running }) {
	const toast = useToast();
	const [status, setStatus] = useState(null);
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	const [showPhrase, setShowPhrase] = useState(false);

	useEffect(() => {
		let alive = true;
		const read = () =>
			manager
				.paykitStatus(id)
				.then((s) => alive && setStatus(s))
				.catch((e) => alive && setError(e));
		read();
		const t = setInterval(read, 30000);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [id]);

	const publish = async () => {
		setBusy(true);
		setError(null);
		try {
			setStatus(await manager.paykitPublish(id));
			toast('Payment details published', 'success');
		} catch (e) {
			setError(e);
			manager.paykitStatus(id).then(setStatus, () => {});
		} finally {
			setBusy(false);
		}
	};

	const setAuto = async (on) => {
		try {
			setStatus(await manager.paykitSetAutoRefresh(id, on));
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	const df = status?.directFunding;
	const pubkyUri = status?.pubky ? `pubky${status.pubky}` : null;

	return (
		<Card
			title="Paykit"
			help="Publishes how to pay this wallet under its pubky, a public identity derived from the wallet's seed. Anyone with the pubky can then pay it: another beignet wallet just pastes it into the Send tab. What is published is public and readable by anyone, and it is only as trustworthy as the Pubky homeserver holding it, so a payer's wallet checks it like any pasted request. There's no way to take published details down from here yet; publishing again replaces them."
		>
			{status?.pubky ? (
				<>
					<div className="paykit-identity" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
						<QR value={pubkyUri} size={132} />
						<div style={{ minWidth: 0, flex: 1 }}>
							<div className="field-label">This wallet's pubky</div>
							<CopyText value={pubkyUri} />
							<div className="wallet-meta" style={{ marginTop: 6 }}>
								{status.publishedAt ? `Published ${fmtDate(status.publishedAt)}` : 'Nothing published yet.'}
							</div>
						</div>
					</div>
					{status.published.length > 0 && (
						<table style={{ marginTop: 12 }} data-testid="paykit-published">
							<tbody>
								{status.published.map((e) => (
									<tr key={e.identifier}>
										<td className="wallet-meta">{nameOf(e.identifier)}</td>
										<td>
											<CopyText value={e.value} truncate />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					{df && !df.ready && rec?.lfbw?.enabled && (
						<div className="wallet-meta" style={{ marginTop: 8 }}>
							{df.engine
								? "Direct funding is added once this wallet's link to its primary is set up."
								: 'Direct funding needs a newer engine than this app bundles, so it is not published yet.'}
						</div>
					)}
					{df?.ready && df.expiresAt && (
						<div className="wallet-meta" style={{ marginTop: 8 }}>
							The direct funding request is good until {fmtDate(df.expiresAt)}, and is replaced once it is paid.
						</div>
					)}
					<ErrorNote error={error || (status.lastError ? { message: status.lastError.message } : null)} />
					<div className="center-actions">
						<Button variant="primary" busy={busy} onClick={publish} disabled={!running} data-testid="paykit-publish">
							{status.publishedAt ? 'Update payment details' : 'Set payment details'}
						</Button>
						<Button onClick={() => setShowPhrase(true)}>Use in Pubky Ring</Button>
					</div>
					{!running && <div className="wallet-meta">Start the wallet to publish: the details come from it.</div>}
					{status.publishedAt && (
						<label className="checkbox field" style={{ marginTop: 8 }}>
							<input
								type="checkbox"
								data-testid="paykit-auto"
								checked={!!status.autoRefresh}
								onChange={(e) => setAuto(e.target.checked)}
							/>
							Keep these up to date
							<Help>
								Checks every fifteen minutes while the wallet runs, and within seconds of a direct
								funding landing, and publishes again when something has changed: the address was paid,
								the offer is gone, or the direct funding request was used or is a day from expiring. A
								direct funding request works once, so without this it stops working after the first
								payment.
							</Help>
						</label>
					)}
				</>
			) : (
				<ErrorNote error={error || (status && !status.pubky ? { message: 'This wallet has no seed to derive a pubky from.' } : null)} />
			)}
			<PubkyLookup id={id} />
			{showPhrase && <PubkyPhraseModal id={id} onClose={() => setShowPhrase(false)} />}
		</Card>
	);
}

/** Any pubky's published payment details, every identifier, with copy buttons. */
function PubkyLookup({ id }) {
	const [text, setText] = useState('');
	const [result, setResult] = useState(null);
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	const pubky = pubkyOf(text);

	const look = async () => {
		setBusy(true);
		setError(null);
		setResult(null);
		try {
			setResult(await manager.paykitLookup(id, pubky));
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div style={{ marginTop: 16 }}>
			<Field label="Look up a pubky">
				<input value={text} onChange={(e) => setText(e.target.value)} placeholder="pubky… or pk:…" />
			</Field>
			{text.trim() && !pubky && <div className="wallet-meta">That is not a pubky.</div>}
			<div className="center-actions">
				<Button busy={busy} onClick={look} disabled={!pubky}>
					Look up
				</Button>
			</div>
			<ErrorNote error={error} />
			{result && result.endpoints.length === 0 && (
				<div className="wallet-meta">That pubky has no payment details published.</div>
			)}
			{result && result.endpoints.length > 0 && (
				<table data-testid="paykit-lookup">
					<tbody>
						{result.endpoints.map((e) => (
							<tr key={`${e.appId}:${e.identifier}`}>
								<td className="wallet-meta">
									{nameOf(e.identifier)}
									{e.appId !== 'beignet' && <Badge>{e.appId}</Badge>}
								</td>
								<td>
									<CopyText value={e.value} truncate />
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</div>
	);
}

/**
 * The phrase behind this wallet's pubky, for Pubky Ring. Not the wallet's
 * seed: it spends nothing, but whoever holds it controls the identity and
 * what is published under it.
 */
function PubkyPhraseModal({ id, onClose }) {
	const toast = useToast();
	const [phrase, setPhrase] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const reveal = async () => {
		setBusy(true);
		setError(null);
		try {
			setPhrase((await manager.paykitPhrase(id)).phrase);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal title="Use this pubky in Pubky Ring" onClose={onClose}>
			<div className="info-note">
				Import these words into Pubky Ring to hold the same pubky there. They are not this wallet's recovery
				phrase and cannot spend its coins, but whoever has them controls the pubky and can change what it
				publishes, so keep them as private as a seed. They come from the wallet's seed, so restoring the
				wallet brings them back.
			</div>
			{phrase && <SeedWords mnemonic={phrase} />}
			<ErrorNote error={error} />
			<div className="center-actions">
				{phrase ? (
					<>
						<Button
							onClick={async () => {
								const ok = await copy(phrase);
								toast(ok ? 'Phrase copied' : 'Copy failed', ok ? 'info' : 'error');
							}}
						>
							Copy phrase
						</Button>
						<Button variant="primary" onClick={onClose}>
							Done
						</Button>
					</>
				) : (
					<>
						<Button variant="primary" busy={busy} onClick={reveal} data-testid="reveal-pubky-phrase">
							Show phrase
						</Button>
						<Button onClick={onClose}>Cancel</Button>
					</>
				)}
			</div>
		</Modal>
	);
}
