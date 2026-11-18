import { useEffect, useMemo, useRef, useState } from 'react';
import AssetAvatar from '../../../../components/AssetAvatar.jsx';
import { AssetAmount } from '../../../../components/AssetAmount.jsx';
import AssetPicker, { NO_ASSET } from '../../../../components/AssetPicker.jsx';
import { useToast } from '../../../../components/Toast.jsx';
import { Button, CopyText, Countdown, Field } from '../../../../components/ui.jsx';
import { useAssetsApi } from '../../../../hooks/useAssets.js';
import { usePoll } from '../../../../hooks/usePoll.js';
import { fmtAsset } from '../../../../lib/asset-amount.js';
import { CHANNEL_BITCOIN_SHORT_TEXT, carriesNothing, lightningRefusal, payFailure, payLabel, payableAssets, peerAway, peerName, quoteChange, quoteExpired, quotePriced } from '../../../../lib/asset-lightning.js';
import { noticeOf } from '../../../../lib/asset-progress.js';
import { submitOnce } from '../../../../lib/assets.js';
import { idempotencyKey } from '../../../../lib/assets-api.js';
import { fmtSats, shortId } from '../../../../lib/format.js';
import { useLightningQuote } from './useLightningQuote.js';

// After the price changes the button names a new amount. It is held still
// for a moment first, so the second half of a double press cannot land on a
// figure the reader has not seen.
export const CHANGE_HOLD_MS = 1000;

const NO_PAY = { bolt11: null, key: null, satsText: '', receipt: null };
const DONE = new Set(['COMPLETED', 'COMPLETE', 'SUCCEEDED', 'SETTLED']);

/** A lightning bolt in a ring, where an asset's face would be: this is the invoice, not an asset. */
function BoltMark() {
	return (
		<span className="ln-mark" aria-hidden="true">
			<svg viewBox="0 0 24 24" width="26" height="26" focusable="false">
				<path d="M13.2 2.5 5.5 13.4h5.2l-1 8.1 7.8-11h-5.3l1-8z" fill="currentColor" />
			</svg>
		</span>
	);
}

/**
 * Paying a Lightning invoice with an asset.
 *
 * The invoice asks for bitcoin. The wallet pays it out of an asset channel,
 * and the channel peer makes the exchange at a price it quotes, so the page
 * shows three things in order: what the invoice asks for, which asset to pay
 * it with, and how much of that asset the peer wants for it right now.
 *
 * The button names the amount, and the payment is sent with that amount as
 * its ceiling. If the price has moved by the time the wallet pays, nothing
 * is paid: the new price is shown and the reader is asked again. A price
 * that runs out on screen is not paid at either; the button asks for a new
 * one instead.
 *
 * What was chosen and what was paid live with the tab (`state.pay`), so a
 * paid invoice still in the box shows its receipt after a look at Holdings,
 * and is not offered for paying a second time.
 */
export default function PayInvoice({ api, invoice, amountSats, holdings, state, patch, bump, go }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const payable = useMemo(() => payableAssets(holdings), [holdings]);
	// Nothing can be sent now. Whether a channel's peer being away is why,
	// the channel list says, and then that is what is said, with the peer
	// named, in the wallet's own words for it.
	const nothing = holdings !== null && holdings !== undefined && payable.length === 0;
	const { data: listed } = usePoll(() => (nothing ? assets.channels().catch(() => null) : Promise.resolve(null)), nothing ? 8000 : 0, [assets, nothing]);
	const gone = nothing && listed ? (listed.channels || []).find((c) => String(c.state).toUpperCase() === 'NORMAL' && peerAway(c)) || null : null;
	// Or a channel with its peer there holds units this side's bitcoin in it
	// can no longer carry: said as the host refuses such a payment.
	const short = nothing && listed && !gone ? (listed.channels || []).find((c) => String(c.state).toUpperCase() === 'NORMAL' && !peerAway(c) && carriesNothing(c)) || null : null;
	const saved = state?.pay && state.pay.bolt11 === invoice ? state.pay : NO_PAY;
	const setPay = (changes) => patch({ pay: { ...saved, bolt11: invoice, ...changes } });

	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState(null);
	// The host's code for a refusal of the payment itself, beside its sentence.
	const [failureCode, setFailureCode] = useState(null);
	const [change, setChange] = useState(null);
	const [held, setHeld] = useState(false);
	const [ranOut, setRanOut] = useState(null);
	const paying = useRef(false);
	const holdTimer = useRef(null);
	useEffect(() => () => clearTimeout(holdTimer.current), []);

	const receipt = saved.receipt;
	const key = saved.key || (payable.length === 1 ? payable[0].key : null);
	const asset = payable.find((a) => a.key === key) || null;
	const open = amountSats === null || amountSats === undefined;
	const sats = open ? parseInt(saved.satsText, 10) || 0 : amountSats;

	const scope = !receipt && asset && sats > 0 ? `${invoice}|${asset.key}|${sats}` : null;
	const price = useLightningQuote(
		() => assets.payQuote({ bolt11: invoice, key: asset.key, amountSats: open ? sats : undefined }),
		scope
	);
	const quote = price.quote;
	const expired = !!quote && (ranOut === quote.quoteId || quoteExpired(quote));
	const refusal = price.error ? lightningRefusal(price.error, { asset }) : null;

	// What was said about one price is not carried over to the next asset or amount.
	useEffect(() => {
		setFailure(null);
		setChange(null);
	}, [scope]);

	const renew = () => {
		setFailure(null);
		setChange(null);
		setRanOut(null);
		price.renew();
	};

	const pay = async () => {
		if (paying.current || !quote || !asset) return;
		paying.current = true;
		setBusy(true);
		setFailure(null);
		setChange(null);
		const shown = quote;
		try {
			const answer = await submitOnce(
				(k) => assets.pay({ bolt11: invoice, key: asset.key, quoteId: shown.quoteId, maxAssetAmount: shown.assetAmount }, k),
				idempotencyKey(),
				async (k) => (await assets.activity({ limit: 20, kind: 'ln-send' })).rows.find((r) => r.clientRef === k) || null
			);
			// A payment whose answer was lost and then found among the rows.
			const row = answer.recovered ? answer.row : null;
			const status = row ? (row.failed ? 'FAILED' : row.state === 'complete' ? 'COMPLETED' : 'PENDING') : String(answer.status || '').toUpperCase();
			// The wallet cannot vouch for how this one ended, and says so: it is
			// shown with that note, and neither as paid nor as failed.
			const notice = noticeOf(row || answer);
			if (status === 'FAILED' && !notice) {
				setFailureCode(null);
				setFailure(row ? payFailure({ failureDescription: row.failure?.message }) : payFailure(answer));
				// The price that payment was made at is spent: a new one for another try.
				setRanOut(null);
				price.renew();
				return;
			}
			const paid = row ? row.assets?.[0]?.amount : answer.assetAmount;
			setPay({
				key: asset.key,
				receipt: {
					assetAmount: paid ?? shown.assetAmount,
					amountSats: shown.amountSats,
					priced: quotePriced(shown),
					feeSats: (row ? row.feeSats : answer.feeSats) ?? null,
					paymentHash: (row ? row.paymentHash : answer.paymentHash) || null,
					settled: DONE.has(status) && !notice,
					notice,
					asset: { key: asset.key, assetId: asset.assetId, groupKey: asset.groupKey, name: asset.name, type: asset.type, decimalDisplay: asset.decimalDisplay }
				}
			});
			if (DONE.has(status) && !notice) toast(`Paid ${fmtAsset(paid ?? shown.assetAmount, asset)} over Lightning`, 'success');
			if (bump) bump();
		} catch (e) {
			const fresh = e?.code === 'QUOTE_CHANGED' ? e.details?.quote : null;
			if (fresh && fresh.quoteId) {
				// Nothing was paid. The new price takes the old one's place, and
				// the reader presses again, on a button that says the new amount.
				price.replace(fresh);
				setRanOut(null);
				setChange(quoteChange(shown, fresh, asset));
				setHeld(true);
				clearTimeout(holdTimer.current);
				holdTimer.current = setTimeout(() => setHeld(false), CHANGE_HOLD_MS);
			} else {
				const said = lightningRefusal(e, { asset });
				setFailure(said.text);
				setFailureCode(said.code || null);
				if (e?.code === 'QUOTE_CHANGED' || e?.code === 'QUOTE_EXPIRED') {
					setRanOut(null);
					price.renew();
				}
			}
		} finally {
			paying.current = false;
			setBusy(false);
		}
	};

	if (receipt) {
		const paidWhat = fmtAsset(receipt.assetAmount, receipt.asset);
		// An invoice a peer made for the asset alone has no bitcoin amount worth repeating.
		const forWhat = receipt.priced === false ? '' : `, for an invoice of ${fmtSats(receipt.amountSats)}`;
		return (
			<div
				className={`paid-receipt asset-pay-receipt${receipt.notice ? ' noted' : ''}`}
				role="status"
				data-testid="asset-pay-receipt"
				data-settled={receipt.settled ? 'yes' : 'no'}
				data-notice={receipt.notice ? receipt.notice.code : undefined}
			>
				<div className="paid-check" aria-hidden="true">
					{receipt.notice ? '?' : receipt.settled ? '✓' : '…'}
				</div>
				<div className="paid-title">
					{receipt.notice ? (receipt.notice.code === 'PAYMENT_UNACCOUNTED' ? 'Not known' : 'Not confirmed') : receipt.settled ? 'Paid' : 'On its way'}
				</div>
				<div className="wallet-meta">
					{receipt.notice
						? `${paidWhat} was sent over Lightning${forWhat}. The wallet cannot say how it ended.`
						: receipt.settled
							? `${paidWhat} paid over Lightning${forWhat}.`
							: `${paidWhat} is on its way over Lightning${forWhat}. Its outcome shows under Holdings.`}
				</div>
				{receipt.notice && (
					<div className="info-note" role="status" data-testid="asset-pay-notice" data-code={receipt.notice.code} style={{ textAlign: 'left' }}>
						{receipt.notice.message}
					</div>
				)}
				<table className="kv asset-pay-facts">
					<tbody>
						<tr>
							<td>{receipt.notice ? 'Asset sent' : 'Asset paid'}</td>
							<td>{paidWhat}</td>
						</tr>
						{receipt.feeSats !== null && (
							<tr>
								<td>Routing fee</td>
								<td>{fmtSats(receipt.feeSats)}</td>
							</tr>
						)}
						{receipt.paymentHash && (
							<tr>
								<td>Payment hash</td>
								<td>
									<CopyText value={receipt.paymentHash} label={shortId(receipt.paymentHash, 8)} />
								</td>
							</tr>
						)}
					</tbody>
				</table>
				<div className="center-actions" style={{ justifyContent: 'center', marginTop: 12 }}>
					<Button data-testid="asset-pay-another" onClick={() => patch({ input: '', pay: null })}>
						Pay another
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="asset-pay" data-testid="asset-pay">
			<div className="asset-preview asset-pay-invoice" data-testid="asset-pay-invoice">
				<div className="asset-preview-head">
					<BoltMark />
					<div>
						<div className="asset-preview-amount">{open ? 'Any amount' : fmtSats(amountSats)}</div>
						<div className="wallet-meta">
							{open ? 'This Lightning invoice does not name an amount' : 'is what this Lightning invoice asks for'} ·{' '}
							<span className="mono">{shortId(invoice, 10)}</span>
						</div>
					</div>
				</div>
			</div>

			{holdings === null || holdings === undefined ? (
				<div className="wallet-meta">Reading what this wallet holds…</div>
			) : gone ? (
				<div className="error-note" role="alert" data-testid="asset-pay-refusal" data-code="PEER_OFFLINE">
					{
						lightningRefusal({
							code: 'PEER_OFFLINE',
							message: `The peer of the asset channel this would be paid through, ${peerName(gone)}, is not connected, so nothing was priced and nothing was paid. Try again once it is back.`
						}).text
					}
				</div>
			) : short ? (
				<div className="error-note" role="alert" data-testid="asset-pay-refusal" data-code="CHANNEL_BITCOIN_SHORT">
					{lightningRefusal({ code: 'CHANNEL_BITCOIN_SHORT', message: CHANNEL_BITCOIN_SHORT_TEXT }).text}
				</div>
			) : payable.length === 0 ? (
				<div className="info-note note-with-action" role="status" data-testid="asset-pay-none">
					<span>
						No asset of this wallet can be sent over Lightning right now. An invoice is paid from a channel funded with
						an asset, and what is held on-chain cannot pay one. To pay this invoice in bitcoin, use the Send tab.
					</span>
					{go && (
						<button type="button" className="btn sm" onClick={() => go('channels')}>
							Open Channels
						</button>
					)}
				</div>
			) : (
				<>
					{open && (
						<Field label="Amount to pay (sats)" hint="This invoice leaves the amount to the payer.">
							<input
								className="amount-input"
								inputMode="numeric"
								autoComplete="off"
								value={saved.satsText}
								placeholder="0"
								data-testid="asset-pay-sats"
								onChange={(e) => setPay({ satsText: e.target.value.replace(/[^0-9]/g, '').slice(0, 12) })}
							/>
						</Field>
					)}
					<AssetPicker
						label="Pay with"
						assets={payable}
						value={{ ...NO_ASSET, key }}
						onChange={(next) => setPay({ key: next.key })}
						testId="asset-pay-picker"
					/>

					<div
						role="status"
						aria-live="polite"
						data-testid="asset-pay-quote"
						data-state={price.pending ? 'asking' : quote ? (expired ? 'expired' : 'priced') : 'empty'}
						data-priced={quote ? (quotePriced(quote) ? 'yes' : 'no') : undefined}
					>
						{!asset && <div className="field-note">Choose the asset to pay with.</div>}
						{asset && !(sats > 0) && <div className="field-note">Type how many sats to pay.</div>}
						{price.pending && <div className="wallet-meta">Asking your channel peer…</div>}
						{quote && asset && (
							<div className={`asset-preview pay-quote${expired ? ' stale' : ''}`}>
								<div className="asset-preview-head">
									<AssetAvatar asset={asset} size="lg" />
									<div>
										<div className="asset-preview-amount">
											<AssetAmount value={quote.assetAmount} asset={asset} />
										</div>
										<div className="wallet-meta">is what you pay</div>
									</div>
								</div>
								<table className="kv">
									<tbody>
										{quotePriced(quote) ? (
											<>
												<tr>
													<td>The invoice gets</td>
													<td>{fmtSats(quote.amountSats)}</td>
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
												<td>Paid to</td>
												<td>
													Your channel peer
													{quote.peerAlias && <span className="kv-sub">{quote.peerAlias}</span>}
												</td>
											</tr>
										)}
										{quote.sendable !== undefined && quote.sendable !== null && (
											<tr>
												<td>You can send</td>
												<td>{fmtAsset(quote.sendable, asset)} over Lightning</td>
											</tr>
										)}
										<tr>
											<td>{quotePriced(quote) ? 'Price held for' : 'Held for'}</td>
											<td>
												{expired ? (
													<span data-testid="asset-pay-expired">Expired</span>
												) : (
													<Countdown
														until={quote.expiresAt}
														total={Math.max(1, (Number(quote.expiresAt) - price.at) / 1000)}
														label={quotePriced(quote) ? 'Price held for' : 'Held for'}
														onExpire={() => {
															setRanOut(quote.quoteId);
															setChange(null);
														}}
													/>
												)}
											</td>
										</tr>
									</tbody>
								</table>
								{!quotePriced(quote) && (
									<div className="field-hint" data-testid="asset-pay-unpriced">
										Your channel peer made this invoice for the asset alone. The sats written on it are not a price.
									</div>
								)}
							</div>
						)}
					</div>

					{refusal && (
						<div className="error-note" role="alert" data-testid="asset-pay-refusal" data-code={refusal.code}>
							{refusal.text}
						</div>
					)}
					{change && (
						<div
							className={change.direction === 'more' ? 'error-note' : 'info-note'}
							role="alert"
							data-testid="asset-pay-changed"
							data-direction={change.direction}
						>
							{change.text}
						</div>
					)}
					{expired && !change && (
						<div className="info-note" role="status" data-testid="asset-pay-stale">
							{quotePriced(quote)
								? 'That price has run out, and nothing was paid. Ask for a new one to go on.'
								: 'The time your peer held this for has run out, and nothing was paid. Ask again to go on.'}
						</div>
					)}
					{failure && (
						<div className="error-note" role="alert" data-testid="asset-pay-failure" data-code={failureCode || undefined}>
							{failure}
						</div>
					)}

					{expired ? (
						<Button variant="primary" disabled={busy || price.pending} data-testid="asset-pay-renew" onClick={renew}>
							{quotePriced(quote) ? 'Get a new price' : 'Ask again'}
						</Button>
					) : (
						<Button variant="primary" busy={busy} disabled={!quote || price.pending || held || busy} data-testid="asset-pay-submit" onClick={pay}>
							{payLabel(quote, asset)}
						</Button>
					)}
				</>
			)}
		</div>
	);
}
