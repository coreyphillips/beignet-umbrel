import { useEffect, useMemo, useRef, useState } from 'react';
import AssetAvatar from '../../../components/AssetAvatar.jsx';
import { AssetAmount } from '../../../components/AssetAmount.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { Button, Card, FeeField, Field } from '../../../components/ui.jsx';
import { useAssetPreview } from '../../../hooks/useAssetPreview.js';
import { useAssetsApi } from '../../../hooks/useAssets.js';
import { REFUSAL_HOLD_MS, useSettledRefusal } from '../../../hooks/useSettledRefusal.js';
import { fmtAsset, fmtUnits, isZero } from '../../../lib/asset-amount.js';
import { isRefusal, proofServerWait, sendRefusal, sentence, submitOnce, tapPrefix } from '../../../lib/assets.js';
import { idempotencyKey } from '../../../lib/assets-api.js';
import { FEE_CAP_MULTIPLE } from '../../../lib/fees.js';
import { fmtSats, shortId } from '../../../lib/format.js';
import { parsePayment } from '../../../lib/payment-uri.js';
import PayInvoice from './lightning/PayInvoice.jsx';
import { FeePresets, NoBumpNote, ProofLateNote, RowTimeline } from './shared.jsx';

/** The form as it starts, and as a finished send leaves it. */
export const EMPTY_SEND = { input: '', feeRate: '', sent: null };

// Paying a Lightning invoice with an asset (lightning/PayInvoice.jsx). Only a
// wallet with asset channels is offered it (the `lightning` prop); for every
// other wallet the box takes addresses and says so about invoices.
const PAYS_INVOICES = true;

const NOT_READ = { address: null, decoded: null, error: null, reading: false };

/** What the wallet said about an address it could not read, as a sentence. */
function decodeRefusal(error, network) {
	if (error.code === 'WRONG_NETWORK') return sentence(error.message || `That address is for another network, and this wallet is on ${network}`);
	if (error.code === 'BAD_ADDRESS') return sentence(error.message || 'The wallet could not read that address');
	// Anything else the wallet refuses with, it says in words of its own
	// (an address version it cannot pay, a proof server it does not know).
	if (isRefusal(error) && error.message) return sentence(error.message);
	return `The wallet could not read that address: ${sentence(error.message || 'no answer')}`;
}

/**
 * A Lightning invoice in the box. A wallet with asset channels pays it with
 * an asset (`pay` is what that needs); any other is told where things stand.
 */
function Invoice({ rec, lightning, held, pay }) {
	if (rec?.onchainOnly) {
		return (
			<div className="error-note" role="alert" data-testid="asset-send-refusal" data-code="ONCHAIN_ONLY">
				That is a Lightning invoice, and this wallet is on-chain only, so it cannot pay it. Lightning can be switched
				on in the wallet&apos;s Edit dialog.
			</div>
		);
	}
	// A node that does not offer asset channels pays nothing over them: the
	// invoice is read, and held with the wallet's own reason.
	if (PAYS_INVOICES && lightning && held) {
		return (
			<div className="error-note" role="alert" data-testid="asset-pay-held" data-code={held.code}>
				That is a Lightning invoice, and this wallet cannot pay it with an asset now. {held.text}
			</div>
		);
	}
	if (PAYS_INVOICES && lightning) return <PayInvoice {...pay} />;
	return (
		<div className="info-note" role="status" data-testid="asset-send-invoice" data-lightning={lightning ? 'yes' : 'no'}>
			That is a Lightning invoice. An asset pays one from an asset channel, and this wallet cannot open those. To pay
			it in bitcoin, use the Send tab.
		</div>
	);
}

/**
 * Sending an asset on-chain.
 *
 * One box. A Taproot Assets address already says which asset and how much,
 * so pasting one is the whole form: the wallet reads it, the page shows what
 * it asks for, and the only choice left is the fee rate. Anything else
 * pasted here is named for what it is and pointed at where it can be paid.
 *
 * Before the button works the wallet has built the exact transaction
 * (prepare), so the fee on screen is the fee that will be paid, and Send
 * broadcasts that same transaction (commit).
 */
export default function SendView({ api, state, patch, holdings, rows, network, fees, rec, proofServer, lightning, lightningHeld, bump, go }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const { input, feeRate } = state;
	const [focused, setFocused] = useState(false);
	const [read, setRead] = useState(NOT_READ);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState(null);
	const inputRef = useRef(null);
	// One press, one request: a second press that lands before the page has
	// drawn the first as busy is dropped here, not at the wallet.
	const sending = useRef(false);

	const parsed = useMemo(() => parsePayment(input, { network }), [input, network]);
	const mayRefuse = useSettledRefusal(input, focused);
	const address = parsed.kind === 'tap' ? parsed.address : null;

	// The wallet reads the address a beat after it settles, and only the
	// newest reading may answer.
	useEffect(() => {
		if (!address) {
			setRead(NOT_READ);
			return () => {};
		}
		let alive = true;
		setRead((r) => (r.address === address ? r : { address, decoded: null, error: null, reading: true }));
		const timer = setTimeout(async () => {
			try {
				const decoded = await assets.decodeAddress(address);
				if (alive) setRead({ address, decoded, error: null, reading: false });
			} catch (error) {
				if (alive) setRead({ address, decoded: null, error, reading: false });
			}
		}, REFUSAL_HOLD_MS);
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [address, assets]);

	const decoded = read.address === address ? read.decoded : null;
	const held = decoded
		? (holdings || []).find((a) => a.key === (decoded.groupKey || decoded.assetId) || a.assetId === decoded.assetId) || decoded.asset || null
		: null;
	const local = decoded ? sendRefusal({ decoded, holdings: holdings || (decoded.asset ? [decoded.asset] : []) }) : null;

	const rate = parseInt(feeRate, 10) || fees?.fast || null;
	const params = useMemo(() => ({ address, feeRate: rate }), [address, rate]);
	const { preview, error, pending, consume, refresh } = useAssetPreview({
		prepare: (p, key) => assets.prepareSend(p, key),
		cancel: (id) => assets.cancelSend(id),
		params,
		scope: address,
		enabled: !!decoded && !local && !!rate
	});
	const refusal = local || (decoded && error ? sendRefusal({ decoded, holdings: holdings || (decoded.asset ? [decoded.asset] : []), error }) : null);
	const what = decoded && held ? fmtAsset(decoded.amount, held) : '';
	// This wallet's own proof server is away. Said from the start, since most
	// addresses name the same server, and dropped once an address names another.
	const waits = proofServerWait(proofServer, 'send', decoded?.courier?.host);
	const canSend = !!preview && !pending && !refusal && !busy;

	const send = async () => {
		if (sending.current) return;
		sending.current = true;
		setBusy(true);
		setFailure(null);
		const key = idempotencyKey();
		try {
			const answer = await submitOnce(
				(k) => assets.commitSend(preview.previewId, k),
				key,
				async (k) => (await assets.activity({ limit: 20, kind: 'send' })).rows.find((r) => r.clientRef === k) || null
			);
			consume();
			toast('Send broadcast', 'success');
			patch({ input: '', sent: { rowId: answer.row.id, row: answer.row } });
			bump();
		} catch (e) {
			if (e.code === 'PREVIEW_EXPIRED') {
				setFailure('The prepared transaction expired before it was sent, so it was prepared again. Check the fee and press Send once more.');
				refresh();
			} else if (e.unknown) {
				setFailure('No answer came back from the wallet, so it is not known whether this was sent. Look under Holdings, In progress, before trying again.');
			} else {
				setFailure(sentence(e.message || 'The send could not be broadcast'));
			}
		} finally {
			sending.current = false;
			setBusy(false);
		}
	};

	const sentRow = state.sent ? (rows || []).find((r) => r.id === state.sent.rowId) || state.sent.row : null;
	const label = PAYS_INVOICES && lightning ? 'Taproot Assets address or Lightning invoice' : 'Taproot Assets address';
	const placeholder = PAYS_INVOICES && lightning ? `${tapPrefix(network)}… or lnbc…` : `${tapPrefix(network)}…`;

	return (
		<div className="card-flow asset-flow" data-testid="asset-send">
			<Card title="Send an asset">
				<Field label={label}>
					<textarea
						ref={inputRef}
						rows={3}
						className="mono"
						value={input}
						placeholder={placeholder}
						spellCheck={false}
						autoComplete="off"
						data-testid="asset-send-input"
						onChange={(e) => {
							setFailure(null);
							patch({ input: e.target.value });
						}}
						onFocus={() => setFocused(true)}
						onBlur={() => setFocused(false)}
					/>
				</Field>
				{input.trim() === '' && (
					<div className="field-note" data-testid="asset-send-hint">
						Paste the address the recipient made for you. It names the asset and the amount, so there is nothing else to
						fill in.
						{PAYS_INVOICES && lightning && ' A Lightning invoice can be pasted here too, to pay it with an asset from a channel.'}
					</div>
				)}

				{waits && (
					<div className="info-note" role="status" data-testid="asset-send-waits">
						{waits}
					</div>
				)}

				{parsed.kind === 'invalid' && mayRefuse && (
					<div className="error-note" role="alert" data-testid="asset-send-refusal" data-code={parsed.code}>
						{parsed.message}
					</div>
				)}
				{parsed.kind === 'tap' && parsed.warnings.length > 0 && (
					<div className="info-note" role="status">
						{parsed.warnings.map((w) => w.message).join(' ')}
					</div>
				)}
				{parsed.kind === 'onchain' && (
					<div className="info-note note-with-action" role="status" data-testid="asset-send-bitcoin">
						<span>
							That is a bitcoin address. Assets go to a Taproot Assets address, which starts with {tapPrefix(network)}. To
							send bitcoin, use the Send tab.
						</span>
						{go && (
							<button type="button" className="btn sm" onClick={() => go('send')}>
								Open Send tab
							</button>
						)}
					</div>
				)}
				{parsed.kind === 'bolt11' && (
					<Invoice
						rec={rec}
						lightning={lightning}
						held={lightningHeld}
						pay={{ api, invoice: parsed.invoice, amountSats: parsed.amountSats, holdings, state, patch, bump, go }}
					/>
				)}
				{parsed.kind === 'bolt12' && (
					<div className="info-note" role="status">
						That is a BOLT12 offer. Paying with an asset works with BOLT11 invoices for now.
					</div>
				)}
				{(parsed.kind === 'lnurl' || parsed.kind === 'pubky') && (
					<div className="info-note" role="status">
						That is {parsed.kind === 'pubky' ? 'a pubky' : 'an LNURL or a Lightning address'}, which pays in bitcoin. Use the
						Send tab for it.
					</div>
				)}

				<div role="status" aria-live="polite" data-testid="asset-send-preview" data-state={read.reading ? 'reading' : decoded ? 'read' : 'empty'}>
					{address && read.reading && <div className="wallet-meta">Reading the address…</div>}
					{decoded && (
						<div className="asset-preview">
							<div className="asset-preview-head">
								<AssetAvatar asset={held || decoded} size="lg" />
								<div className="asset-preview-amount">
									{held ? <AssetAmount value={decoded.amount} asset={held} /> : `${fmtUnits(decoded.amount, 0)} units`}
								</div>
							</div>
							<table className="kv">
								<tbody>
									<tr>
										<td>Asset</td>
										<td>
											{held ? `${held.name} · ` : 'Not held here · '}
											<span className="mono">{shortId(decoded.assetId)}</span>
										</td>
									</tr>
									<tr>
										<td>Amount</td>
										<td>{held ? `${fmtAsset(decoded.amount, held)} · set by the address` : `${fmtUnits(decoded.amount, 0)} units · set by the address`}</td>
									</tr>
									<tr>
										<td>Proof delivered through</td>
										<td>
											<code>{decoded.courier?.host || 'the proof server in the address'}</code>
										</td>
									</tr>
									{held && (
										<tr>
											<td>You hold</td>
											<td>{fmtAsset(held.balance?.onchain ?? '0', held)} on-chain</td>
										</tr>
									)}
								</tbody>
							</table>
							<div className="field-hint">The address fixes the asset and the amount, so neither can be changed here.</div>
						</div>
					)}
				</div>

				{address && read.error && (
					<div className="error-note" role="alert" data-testid="asset-send-refusal" data-code={read.error.code || 'UNREADABLE'}>
						{decodeRefusal(read.error, network)}
					</div>
				)}
				{refusal && (
					<div className="error-note" role="alert" data-testid="asset-send-refusal" data-code={refusal.code}>
						{refusal.text}
					</div>
				)}

				{decoded && !local && (
					<>
						<FeeField
							label="Fee rate (sat/vB)"
							value={feeRate}
							onChange={(v) => patch({ feeRate: v })}
							rate={rate}
							max={Math.max(10, (fees?.fast || 10) * FEE_CAP_MULTIPLE)}
						/>
						<FeePresets fees={fees} onPick={(v) => patch({ feeRate: v })} />
						<NoBumpNote what="send" />
						{pending && !preview && !error && <div className="wallet-meta">Preparing the transaction…</div>}
						{preview && (
							<div className="asset-send-lines" data-testid="asset-send-cost">
								{!waits && preview.courier && preview.courier.reachable === false && (
									<div className="info-note" role="status" data-code="COURIER_DOWN">
										The proof server in this address (<code>{preview.courier.host}</code>) is not answering. The send can
										still be broadcast, and the proof is delivered once it can be reached.
									</div>
								)}
								<div className="wallet-meta">
									Miner fee: {fmtSats(preview.fee.sats)} at {preview.fee.feeRate} sat/vB over {preview.fee.vbytes} vB.
									This is what the transaction pays, not an estimate of it.
								</div>
								{preview.btc.anchorSats > 0 && (
									<div className="wallet-meta">
										Travels with the asset: {fmtSats(preview.btc.anchorSats)}, locked in the recipient&apos;s output.
									</div>
								)}
								{held && !isZero(preview.change) && (
									<div className="wallet-meta">
										Change: {fmtAsset(preview.change, held)} comes back to this wallet in the same transaction.
									</div>
								)}
							</div>
						)}
						{failure && (
							<div className="error-note" role="alert">
								{failure}
							</div>
						)}
						<Button variant="primary" busy={busy} disabled={!canSend} data-testid="asset-send-submit" onClick={send}>
							{what ? `Send ${what}` : 'Send'}
						</Button>
					</>
				)}
			</Card>

			{sentRow && (
				<Card title="Sent">
					<div data-testid="asset-send-status" data-state={sentRow.state}>
						<RowTimeline row={sentRow} network={network} host={sentRow.courier} />
					</div>
					{/* A proof the server has not taken: what it means, and the file to hand over instead. */}
					<ProofLateNote row={sentRow} host={sentRow.courier} />
					<div className="field-hint" style={{ marginTop: 12 }}>
						The recipient sees it once it has confirmed and their wallet has the proof. You can leave this page: the
						progress is under Holdings whenever you come back.
					</div>
					<div className="center-actions">
						<Button
							data-testid="asset-send-another"
							onClick={() => {
								patch({ sent: null });
								inputRef.current?.focus();
							}}
						>
							Send another
						</Button>
					</div>
				</Card>
			)}
		</div>
	);
}
