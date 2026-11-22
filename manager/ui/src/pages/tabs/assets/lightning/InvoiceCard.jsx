import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import AssetAvatar from '../../../../components/AssetAvatar.jsx';
import { AssetAmount } from '../../../../components/AssetAmount.jsx';
import { useToast } from '../../../../components/Toast.jsx';
import { Button, Card, Countdown, Empty, Field, QR, QRZoom } from '../../../../components/ui.jsx';
import { useAssetsApi } from '../../../../hooks/useAssets.js';
import { usePoll } from '../../../../hooks/usePoll.js';
import { fmtAsset, isZero } from '../../../../lib/asset-amount.js';
import { invoiceDeadline, invoiceShortfall, invoiceStanding, lightningRefusal, peerAway, quotePriced } from '../../../../lib/asset-lightning.js';
import { copy, fmtSats } from '../../../../lib/format.js';
import { useLightningQuote } from './useLightningQuote.js';

const HEAD = 14;
const TAIL = 6;
// While an invoice waits, the list of invoices is asked beside the activity
// rows, so whichever hears of the payment first shows it.
const WATCH_MS = 4000;

/** The invoice as text: its two ends, a way to copy all of it, and all of it on request. */
function InvoiceText({ bolt11, what }) {
	const toast = useToast();
	return (
		<div className="tap-address" data-testid="asset-invoice-text">
			<div className="tap-address-line mono" title={bolt11}>
				<span>{bolt11.slice(0, HEAD)}</span>
				<span className="tap-address-gap">…</span>
				<span className="tap-address-tail">{bolt11.slice(-TAIL)}</span>
			</div>
			<div className="center-actions tap-address-actions">
				<Button
					variant="primary"
					className="sm"
					data-testid="asset-invoice-copy"
					onClick={async () => toast((await copy(bolt11)) ? 'Invoice copied' : 'Copy failed', 'info')}
				>
					Copy invoice
				</Button>
				<QRZoom value={bolt11} caps title={`Lightning invoice for ${what}`} />
			</div>
			<details className="asset-details">
				<summary>Show full invoice</summary>
				<div className="static-value mono tap-address-full" data-testid="asset-invoice-full">
					{bolt11}
				</div>
			</details>
		</div>
	);
}

/**
 * Receiving an asset over Lightning: an invoice, beside the on-chain address.
 *
 * It is for the asset and the amount already chosen on the page. An invoice
 * for an asset is an ordinary Lightning invoice, priced in bitcoin by the
 * channel peer when it is made: the payer pays from any wallet, and the peer
 * hands this wallet the asset at that price. The price holds for a short
 * while, which is why the card counts down, and why the price is asked for
 * once more as the invoice is made: the payer gets all of the time there is.
 *
 * What the wallet cannot receive is said before the button works. Once the
 * invoice is paid the code gives way to a receipt, and one that ran out
 * unpaid stops being shown as something to scan.
 *
 * The invoice lives with the tab (`state.invoice`, `patch`), so looking at
 * Holdings and coming back finds it still there.
 */
export default function InvoiceCard({ api, asset, units, state, patch, rows, bump, held }) {
	const assets = useAssetsApi(api);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState(null);
	const [ranOut, setRanOut] = useState(null);
	const making = useRef(false);

	const collectible = asset?.type === 'collectible';
	const amount = !collectible && units && !isZero(units) ? units : null;
	// Nothing on the far side of any channel: said from what the wallet
	// already holds, without asking the peer for a price it cannot use.
	const nothingNow = !!asset && !collectible && isZero(asset.balance?.lightningReceivable);
	// Nothing can be received now. Where that is because a channel's peer is
	// away, the wallet is asked all the same: it names the peer, or says the
	// amount is too much for the channel even with the peer there.
	const { data: ownChannels } = usePoll(() => (nothingNow ? assets.channels().catch(() => null) : Promise.resolve(null)), nothingNow ? 8000 : 0, [assets, nothingNow, asset?.key]);
	const peerGone = nothingNow && !!ownChannels && (ownChannels.channels || []).some((c) => c.asset?.key === asset.key && String(c.state).toUpperCase() === 'NORMAL' && peerAway(c));
	const noInbound = nothingNow && !peerGone;
	const scope = asset && amount && !noInbound ? `${asset.key}|${amount}` : null;
	// `held` is why the wallet's node takes nothing new over asset channels
	// (lightningHeld): no price is asked for, and the card says why.
	const price = useLightningQuote(() => assets.invoiceQuote({ key: asset.key, amount }), state.invoice || held ? null : scope);
	const quote = price.quote;
	// A refusal was about one asset and one amount. Changing either asks afresh.
	useEffect(() => {
		setFailure(null);
	}, [scope]);
	const refusal =
		failure ||
		(price.error ? lightningRefusal(price.error, { asset }) : null) ||
		(noInbound && amount ? lightningRefusal({ code: 'INSUFFICIENT_INBOUND', details: { maxReceivable: '0' } }, { asset }) : null);

	const made = state.invoice || null;
	const row = made ? (rows || []).find((r) => r.id === made.rowId) || made.row || null : null;
	const { data: listing } = usePoll(
		() => (made && row?.state !== 'complete' ? assets.invoices().catch(() => null) : Promise.resolve(null)),
		made && row?.state !== 'complete' ? WATCH_MS : 0,
		[assets, made?.paymentHash, row?.state]
	);
	const listed = made ? (listing?.invoices || []).find((i) => i.paymentHash === made.paymentHash) || null : null;
	const deadline = made ? invoiceDeadline(made) : null;
	const standing = made
		? invoiceStanding({ invoice: made, row, listed, now: ranOut === made.paymentHash && deadline ? deadline : Date.now() })
		: null;
	const what = made ? fmtAsset(made.assetAmount, made.asset) : '';
	// What arrived, which a payer's price can leave a unit under what was
	// asked for: the paid row says it, and so does the list of invoices.
	const got = made ? (row?.state === 'complete' ? row.assets?.[0]?.amount : listed?.receivedAmount) ?? null : null;
	const short = made ? invoiceShortfall({ assetAmount: made.assetAmount, receivedAmount: got }, made.asset) : null;

	const create = async () => {
		if (making.current || !asset || !amount) return;
		making.current = true;
		setBusy(true);
		setFailure(null);
		try {
			// Asked for again now, not taken from the price on screen, which may
			// have been sitting there a while: the payer's time starts here.
			const fresh = await assets.invoiceQuote({ key: asset.key, amount });
			const answer = await assets.createInvoice({
				key: asset.key,
				amount,
				description: (state.invoiceNote || '').trim() || undefined,
				quoteId: fresh.quoteId
			});
			patch({
				invoice: {
					bolt11: answer.bolt11,
					paymentHash: answer.paymentHash,
					assetAmount: answer.assetAmount ?? amount,
					amountSats: answer.amountSats ?? fresh.amountSats,
					rateText: answer.rateText || fresh.rateText || '',
					priced: (answer.priced ?? fresh.priced) !== false,
					peerAlias: fresh.peerAlias || null,
					expiresAt: answer.expiresAt ?? fresh.expiresAt ?? null,
					invoiceExpiresAt: answer.invoiceExpiresAt ?? null,
					createdAt: Date.now(),
					rowId: answer.row?.id || null,
					row: answer.row || null,
					asset: { key: asset.key, assetId: asset.assetId, groupKey: asset.groupKey, name: asset.name, type: asset.type, decimalDisplay: asset.decimalDisplay }
				}
			});
			setRanOut(null);
			if (bump) bump();
		} catch (e) {
			setFailure(lightningRefusal(e, { asset }));
			// The price on screen is no better than the one just refused.
			if (e?.code === 'QUOTE_EXPIRED') price.renew();
		} finally {
			making.current = false;
			setBusy(false);
		}
	};

	const again = () => {
		setFailure(null);
		setRanOut(null);
		patch({ invoice: null });
	};

	return (
		<Card
			title="Lightning invoice"
			help="An ordinary Lightning invoice, priced in bitcoin by your channel peer when it is made. The payer pays it from any Lightning wallet and you receive the asset. The price holds for a short while, so make the invoice when the payer is ready."
		>
			<div data-testid="asset-invoice-card" data-state={made ? standing : held ? 'held' : quote ? 'priced' : refusal ? 'refused' : 'empty'}>
				{!made && held && (
					<div className="error-note" role="alert" data-testid="asset-invoice-held" data-code={held.code}>
						{held.text}
					</div>
				)}
				{!made && !held && (
					<>
						{!asset ? (
							<Empty>Choose the asset above first.</Empty>
						) : collectible ? (
							<Empty>A collectible is received on-chain. A channel cannot carry one.</Empty>
						) : !amount ? (
							<div className="field-note" data-testid="asset-invoice-hint">
								The invoice is for the same asset and amount as the address. Type the amount first.
							</div>
						) : (
							<>
								<div
									className="asset-preview"
									role="status"
									aria-live="polite"
									data-testid="asset-invoice-quote"
									data-state={price.pending ? 'asking' : quote ? 'priced' : 'empty'}
									data-priced={quote ? (quotePriced(quote) ? 'yes' : 'no') : undefined}
								>
									<div className="asset-preview-head">
										<AssetAvatar asset={asset} size="lg" />
										<div className="asset-preview-amount">
											<AssetAmount value={amount} asset={asset} />
										</div>
									</div>
									{price.pending && <div className="wallet-meta">Asking your channel peer…</div>}
									{quote && (
										<table className="kv">
											<tbody>
												{quotePriced(quote) ? (
													<>
														<tr>
															<td>Worth now</td>
															<td>about {fmtSats(quote.amountSats)}</td>
														</tr>
														<tr>
															<td>Price</td>
															<td>
																{quote.rateText}
																{quote.peerAlias && <span className="kv-sub">from {quote.peerAlias}</span>}
															</td>
														</tr>
													</>
												) : (
													<tr>
														<td>Who can pay it</td>
														<td>
															Your channel peer
															{quote.peerAlias && <span className="kv-sub">{quote.peerAlias}</span>}
														</td>
													</tr>
												)}
												<tr>
													<td>Can receive now</td>
													<td>up to {fmtAsset(quote.maxReceivable, asset)}</td>
												</tr>
											</tbody>
										</table>
									)}
								</div>
								{refusal && (
									<div className="error-note" role="alert" data-testid="asset-invoice-refusal" data-code={refusal.code}>
										{refusal.text}
									</div>
								)}
								<Field label="Note for the payer (optional)">
									<input
										value={state.invoiceNote || ''}
										maxLength={120}
										placeholder="What it is for"
										data-testid="asset-invoice-note"
										onChange={(e) => patch({ invoiceNote: e.target.value })}
									/>
								</Field>
								<Button variant="primary" busy={busy} disabled={!quote || busy} data-testid="asset-invoice-create" onClick={create}>
									Create invoice
								</Button>
								{quote && (
									<div className="field-hint invoice-hint">
										{quotePriced(quote)
											? 'The price is asked for again as the invoice is made, so the payer gets all of the time it holds for.'
											: 'This peer sets no bitcoin price, so the invoice is for the asset alone and only this peer can pay it. It is asked again as the invoice is made, so it gets all of the time the invoice holds for.'}
									</div>
								)}
							</>
						)}
					</>
				)}

				<AnimatePresence mode="wait">
					{made && standing === 'waiting' && (
						<m.div
							key={made.paymentHash}
							className="asset-address-block asset-invoice"
							initial={{ opacity: 0, scale: 0.94, y: 8 }}
							animate={{ opacity: 1, scale: 1, y: 0 }}
							exit={{ opacity: 0, scale: 0.96 }}
						>
							<div className="asset-qr" data-testid="asset-invoice-qr">
								<QR value={made.bolt11} size={232} caps fluid title={`Lightning invoice for ${what}`} />
							</div>
							<InvoiceText bolt11={made.bolt11} what={what} />
							<div className="invoice-facts" data-testid="asset-invoice-facts">
								<div className="invoice-for">
									For <strong>{what}</strong>
								</div>
								{made.priced === false ? (
									<div className="wallet-meta" data-testid="asset-invoice-unpriced">
										Only your channel peer{made.peerAlias ? `, ${made.peerAlias},` : ''} can pay this invoice. It is for the
										asset alone, with no bitcoin price.
									</div>
								) : (
									<>
										<div className="wallet-meta">The payer is asked for {fmtSats(made.amountSats)}</div>
										{made.rateText && (
											<div className="wallet-meta">
												{made.rateText}
												{made.peerAlias ? ` · price from ${made.peerAlias}` : ''}
											</div>
										)}
									</>
								)}
								{deadline && (
									<div className="invoice-clock">
										<span className="wallet-meta">Time left to pay</span>
										<Countdown
											until={deadline}
											total={Math.max(1, (deadline - made.createdAt) / 1000)}
											label="Time left to pay"
											onExpire={() => setRanOut(made.paymentHash)}
										/>
									</div>
								)}
							</div>
							<div className="field-hint" data-testid="asset-invoice-who">
								{made.priced === false
									? `You receive ${made.asset.name} straight from your channel peer, who agreed to this invoice for a set time, which is why it cannot be paid once the time runs out.`
									: `Any Lightning wallet can pay this. You receive ${made.asset.name}: your channel peer makes the exchange at this price, which is why the invoice cannot be paid once the time runs out.`}
							</div>
							<div className="center-actions" style={{ justifyContent: 'center' }}>
								<Button className="sm" data-testid="asset-invoice-replace" onClick={again}>
									Make a different invoice
								</Button>
							</div>
						</m.div>
					)}
					{made && standing === 'paid' && (
						<m.div
							key={`paid-${made.paymentHash}`}
							className="paid-receipt"
							role="status"
							data-testid="asset-invoice-paid"
							initial={{ opacity: 0, scale: 0.9 }}
							animate={{ opacity: 1, scale: 1 }}
						>
							<div className="paid-check" aria-hidden="true">
								✓
							</div>
							<div className="paid-title">Received</div>
							<div className="wallet-meta">
								{short ? fmtAsset(short.received, made.asset) : what} received over Lightning. It is on your side of the
								channel now, and can be sent over Lightning straight away.
							</div>
							{short && (
								<div className="wallet-meta" data-testid="asset-invoice-short">
									The invoice {short.text}. A payer&apos;s price can come to a unit less than an invoice names, and the
									invoice is paid all the same.
								</div>
							)}
							<div className="center-actions" style={{ justifyContent: 'center', marginTop: 12 }}>
								<Button data-testid="asset-invoice-again" onClick={again}>
									Create another invoice
								</Button>
							</div>
						</m.div>
					)}
					{made && (standing === 'expired' || standing === 'failed' || standing === 'lost') && (
						<m.div
							key={`over-${made.paymentHash}`}
							className="asset-invoice-over"
							initial={{ opacity: 0 }}
							animate={{ opacity: 1 }}
						>
							<div className="info-note" role="status" data-testid="asset-invoice-expired" data-state={standing}>
								{standing === 'lost'
									? `The invoice for ${what} was paid, but the peer took the payment back on the chain before the wallet could claim it, so nothing was received. Make a new one if the payer is to pay again.`
									: standing === 'failed'
										? `The invoice for ${what} failed, and nothing was received. Make a new one when the payer is ready.`
										: `The invoice for ${what} was not paid before its price ran out, so it can no longer be paid. Nothing was received. Make a new one when the payer is ready.`}
							</div>
							<Button variant="primary" data-testid="asset-invoice-new" onClick={again}>
								Make a new invoice
							</Button>
						</m.div>
					)}
				</AnimatePresence>
			</div>
		</Card>
	);
}
