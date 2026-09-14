import { useEffect, useMemo, useRef, useState } from 'react';
import { usePoll } from '../../../hooks/usePoll.js';
import { useToast } from '../../../components/Toast.jsx';
import { AmountField, Button, Card, FeeField, Field } from '../../../components/ui.jsx';
import { fmtSats } from '../../../lib/format.js';
import { FEE_CAP_MULTIPLE, perkwFromSatVb } from '../../../lib/fees.js';
import { parsePayment } from '../../../lib/payment-uri.js';
import { useSettledRefusal } from '../../../hooks/useSettledRefusal.js';
import {
	describeFallback,
	describeFunding,
	describeUnknown,
	fallbackRecord,
	idempotencyKey,
	persistFallback,
	sendDirectFunding
} from '../../../lib/direct-funding.js';
import { homeChannel } from '../../../lib/lfbw.js';
import { LiveFundingSteps } from '../../../components/FundingSteps.jsx';
import { manager, walletApi } from '../../../api.js';

// Typing an amount or dragging a slider re-prices on every keystroke and
// every pixel. Wait for the hand to settle before asking the daemon.
const QUOTE_DEBOUNCE_MS = 250;

/**
 * "Send to a bitcoin address" for a lightning-first wallet.
 *
 * The wallet holds its balance in the home channel, so paying an address is
 * a splice-out of that channel: the daemon prices it (which reserve the
 * peer set, the exact weight) and the amount the slider allows is the
 * daemon's ceiling, net of the fee. When the pasted request carries a
 * direct-funding envelope AND this wallet happens to hold a confirmed
 * on-chain coin that covers it (a deposit not yet moved into the channel),
 * the payment can be a direct funding instead: the coin becomes the
 * recipient's channel funding in one transaction. Otherwise the recipient,
 * a beignet wallet too, moves the plain payment into Lightning by itself
 * after one confirmation.
 */
export default function AddressSend({ id, api, rec, channels, bump, state, patch }) {
	const toast = useToast();
	const { input: value, amount, feeRate, maxMode } = state;
	const setAmount = (v) => patch({ amount: v });
	const setFeeRate = (v) => patch({ feeRate: v });
	const setMaxMode = (v) => patch({ maxMode: v });
	const onChange = (v) => patch({ input: v });
	const [dest, setDest] = useState('custom');
	const [fetchingAddr, setFetchingAddr] = useState(false);
	const [focused, setFocused] = useState(false);
	const [busy, setBusy] = useState(false);
	const [quote, setQuote] = useState(null);
	const [quoteError, setQuoteError] = useState(null);
	const [result, setResult] = useState(null);
	const [directFunding, setDirectFunding] = useState(true);
	// The request the latest direct funding paid, and which press that was.
	const [stepsFor, setStepsFor] = useState(null);
	const inputRef = useRef(null);
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);
	const { data: wallets } = usePoll(() => manager.listWallets().catch(() => []), 15000, []);
	const { data: utxos } = usePoll(() => api.get('/utxos').catch(() => null), 30000, [id]);

	const home = homeChannel(channels, rec?.lfbw?.primaryPubkey);
	const others = (wallets || []).filter(
		(w) => w.id !== id && w.status === 'running' && w.network === rec?.network
	);
	const parsed = useMemo(() => parsePayment(value, { network: rec?.network }), [value, rec?.network]);
	const mayRefuse = useSettledRefusal(value, focused);
	const effRate = parseInt(feeRate, 10) || fees?.normal || null;
	const feeratePerkw = effRate ? perkwFromSatVb(effRate) : null;

	// The box is made to hold the address the parser settled on, whatever
	// arrived, with the request's own figure filled in once.
	const rewritten = useRef(null);
	const [request, setRequest] = useState(null);
	useEffect(() => {
		const echo = rewritten.current;
		rewritten.current = null;
		if (echo !== null && echo === value) return;
		if (parsed.kind !== 'onchain') {
			if (parsed.kind === 'empty') setRequest(null);
			return;
		}
		if (value !== parsed.address) {
			rewritten.current = parsed.address;
			onChange(parsed.address);
		}
		if (!parsed.isRequest) {
			if (request && request.address !== parsed.address) setRequest(null);
			return;
		}
		setRequest({
			address: parsed.address,
			amountSats: parsed.amountSats,
			message: parsed.message || parsed.label,
			funding: parsed.funding
		});
		setMaxMode(false);
		setAmount(parsed.amountSats != null ? String(parsed.amountSats) : '');
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [parsed]);

	// The daemon prices the splice-out: which reserve the peer set, the exact
	// weight, and the most that can leave at this rate net of the fee.
	useEffect(() => {
		if (!home || !feeratePerkw) {
			setQuote(null);
			return undefined;
		}
		let alive = true;
		const t = setTimeout(() => {
			api
				.post('/channel/splice-quote', { channelId: home.channelId, direction: 'out', feeratePerkw })
				.then((q) => {
					if (!alive) return;
					setQuote(q);
					setQuoteError(null);
				})
				.catch((e) => {
					if (!alive) return;
					setQuoteError(e.message);
				});
		}, QUOTE_DEBOUNCE_MS);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [api, home?.channelId, feeratePerkw]);

	const ceiling = quote ? quote.maxAmountSats || 0 : 0;
	const feeSats = quote ? quote.feeSats ?? null : null;
	const typed = parseInt(amount, 10) || 0;
	const shownAmount = maxMode ? String(ceiling) : amount;
	const amountNum = maxMode ? ceiling : typed;
	const feeMax = Math.max(1, Math.max(fees?.fast ? fees.fast * FEE_CAP_MULTIPLE : 100, parseInt(feeRate, 10) || 0));

	const setAmountManually = (val) => {
		const next = parseInt(val, 10) || 0;
		if (maxMode) {
			if (next >= ceiling) return;
			setMaxMode(false);
			setAmount(String(Math.min(next, ceiling)));
			return;
		}
		if (ceiling > 0 && next >= ceiling) {
			setMaxMode(true);
			return;
		}
		setAmount(val);
	};

	// A direct funding spends one of OUR on-chain coins, so it is only on the
	// table while a confirmed deposit that covers the amount is still waiting
	// to move into the channel.
	const funding = request?.funding || null;
	const coveringCoin = useMemo(() => {
		if (!funding || amountNum <= 0) return null;
		return (utxos || []).find((u) => u.height > 0 && u.valueSats >= amountNum) || null;
	}, [funding, utxos, amountNum]);
	const payDirect = !!funding && !!coveringCoin && directFunding;

	const onDest = async (val) => {
		setDest(val);
		if (val === 'custom') {
			onChange('');
			return;
		}
		setFetchingAddr(true);
		try {
			const r = await walletApi(val).post('/address/new', {});
			onChange(r.address);
		} catch (e) {
			toast(`Could not get address: ${e.message}`, 'error');
			setDest('custom');
		} finally {
			setFetchingAddr(false);
		}
	};

	// A direct funding that degraded into an ordinary payment, recorded against
	// the transaction it became: the reason lives in the daemon's answer to this
	// call and nowhere else, and what goes out instead is a splice-out like any
	// other (umbrel #121). Never allowed to disturb the payment itself.
	const noteFallback = (record) =>
		persistFallback(record, (entry) => manager.recordDirectFundingFallback(id, entry));

	const send = async () => {
		setBusy(true);
		setResult(null);
		setStepsFor(payDirect && funding.requestId ? { requestId: funding.requestId, attempt: Date.now() } : null);
		let fallback = null;
		try {
			if (payDirect) {
				// The daemon rejects only before our witness leaves the device.
				// A rejection, or a status from before that point, is the one
				// place a plain send may follow; anything later is a payment
				// out of our hands, shown as it stands. A lost answer is
				// neither: it is asked for again, and nothing is paid while it
				// is unknown, because the splice-out here never touches the
				// coin the funding pinned and a late acceptance would always
				// be a second payment.
				const body = { request: funding.envelope, amountSats: amountNum, feeHeadroomSats: 1000 };
				const headers = { 'X-Idempotency-Key': idempotencyKey() };
				const outcome = await sendDirectFunding(() => api.post('/direct-funding/send', body, { headers }), {
					onUnknown: ({ reason }) => setResult({ kind: 'unknown', reason, waiting: true })
				});
				if (outcome.kind === 'unknown') {
					setResult({ kind: 'unknown', reason: outcome.reason, waiting: false });
					toast('No answer from the wallet about the direct funding; nothing was paid to the address.', 'error');
					return;
				}
				setResult(null);
				if (outcome.kind === 'sent') {
					setResult({ kind: 'funding', outcome });
					toast(outcome.failed ? describeFunding(outcome) : 'Sent as direct funding', outcome.failed ? 'error' : 'success');
					finish();
					return;
				}
				fallback = fallbackRecord(outcome.reason, {
					funding,
					address: parsed.address,
					amountSats: amountNum
				});
				// On screen before the splice-out, which negotiates with the peer
				// and can outlast the toast by a long way. Until it returns there
				// is no transaction to record the reason against.
				setResult({ kind: 'pending', fallback: { ...fallback, pending: true } });
				toast(`Direct funding not taken (${outcome.reason}); paying the address instead.`, 'info');
			}
			if (!home) throw new Error('No channel to send from yet.');
			const r = await api.post('/channel/splice-out', {
				channelId: home.channelId,
				amountSats: amountNum,
				feeratePerkw,
				address: parsed.address
			});
			if (r && r.ok === false) throw new Error(r.error || r.message || 'The splice was refused');
			const txid = r?.txid || r?.spliceTxid || null;
			const recorded = fallback ? await noteFallback({ ...fallback, txid }) : null;
			setResult({ kind: 'splice', txid, fallback: recorded });
			toast('Sent', 'success');
			finish();
		} catch (e) {
			// No payment to attach it to, so nothing in Activity will ever show
			// this one. It is still the answer to why the direct funding did not
			// happen, and the log keeps it.
			if (fallback) {
				const recorded = await noteFallback({ ...fallback, error: e.message });
				setResult({ kind: 'failed', fallback: recorded });
			}
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	const finish = () => {
		setMaxMode(false);
		setAmount('');
		setRequest(null);
		onChange('');
		if (dest !== 'custom') setDest('custom');
		bump();
	};

	const overCeiling = !maxMode && quote && amountNum > ceiling;

	return (
		<Card title="Send to a bitcoin address">
			<div className="wallet-meta" style={{ marginBottom: 12 }}>
				{home
					? quote
						? `Spendable: ${fmtSats(ceiling)} at ${effRate} sat/vB, from your Lightning balance.`
						: quoteError
						? `Could not price the transaction: ${quoteError}`
						: 'Pricing…'
					: 'Nothing to send from yet: your Lightning balance lives in the channel with your primary node, and there is none open.'}
			</div>
			{others.length > 0 && (
				<Field label="Send to">
					<select value={dest} onChange={(e) => onDest(e.target.value)}>
						<option value="custom">Custom address</option>
						{others.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name} ({w.network})
							</option>
						))}
					</select>
				</Field>
			)}
			<Field label="Recipient address or payment request">
				<input
					ref={inputRef}
					value={value}
					onChange={(e) => {
						onChange(e.target.value);
						if (dest !== 'custom') setDest('custom');
					}}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					placeholder={fetchingAddr ? 'Fetching address…' : 'bc1… or bitcoin:bc1…?amount=…'}
				/>
			</Field>
			{parsed.kind === 'invalid' && mayRefuse && (
				<div className="error-note" role="alert">
					{parsed.message}
				</div>
			)}
			{parsed.kind === 'onchain' && parsed.warnings.length > 0 && (
				<div className="info-note" role="status">
					{parsed.warnings.map((w) => w.message).join(' ')}
				</div>
			)}
			{(parsed.kind === 'bolt11' || parsed.kind === 'bolt12') && (
				<div className="info-note" role="status">
					That is a Lightning {parsed.kind === 'bolt12' ? 'offer' : 'invoice'}. Pay it from the Lightning
					rail above.
				</div>
			)}
			{request && parsed.kind === 'onchain' && (
				<div className="info-note" role="status">
					Read from a payment request
					{request.amountSats != null ? `, which asks for ${fmtSats(request.amountSats)}` : ''}.
					{funding
						? coveringCoin
							? ' It comes from a beignet wallet, and a confirmed deposit of yours can become their channel funding directly.'
							: ' It comes from a beignet wallet: paid from your Lightning balance, it lands as an ordinary transaction they move into Lightning after one confirmation.'
						: ''}
				</div>
			)}
			{funding && coveringCoin && (
				<label className="checkbox field">
					<input
						type="checkbox"
						checked={directFunding}
						onChange={(e) => setDirectFunding(e.target.checked)}
					/>
					Pay as direct funding (one transaction, your coin becomes their channel)
				</label>
			)}
			{request?.message && (
				<div className="field">
					<span className="field-label">Message</span>
					<div className="static-value">{request.message}</div>
				</div>
			)}
			<AmountField
				label="Amount (sats)"
				value={shownAmount}
				onChange={setAmountManually}
				max={ceiling}
				isMax={maxMode}
				onMax={() => setMaxMode(!maxMode)}
				hint={
					maxMode
						? 'Sends the most the channel can release at this fee rate.'
						: 'The slider stops at the most your channel can release at this fee rate, net of the fee and the channel reserve.'
				}
			/>
			{overCeiling && (
				<div className="error-note" role="alert">
					That is more than the channel can release right now ({fmtSats(ceiling)} at this fee rate).
				</div>
			)}
			<FeeField
				label="Fee rate (sat/vB)"
				value={feeRate}
				onChange={setFeeRate}
				rate={effRate}
				max={feeMax}
				hint="The splice transaction pays this. Leave empty to let the wallet pick."
			/>
			{fees && (
				<div className="preset-row" style={{ marginBottom: 14 }}>
					{[
						['Fast', fees.fast],
						['Normal', fees.normal],
						['Slow', fees.slow]
					].map(([label, rate]) => (
						<button key={label} type="button" className="btn sm" onClick={() => setFeeRate(String(rate))}>
							{label} · {rate} sat/vB
						</button>
					))}
				</div>
			)}
			{feeSats != null && !payDirect && (
				<div className="wallet-meta" style={{ marginBottom: 12 }}>
					Fee: {fmtSats(feeSats)} at {effRate} sat/vB ({feeratePerkw} sat/kw), priced by the wallet.
				</div>
			)}
			<Button
				variant="primary"
				busy={busy}
				onClick={send}
				disabled={parsed.kind !== 'onchain' || amountNum <= 0 || fetchingAddr || (!payDirect && (!home || !quote || overCeiling))}
			>
				{payDirect ? 'Pay as direct funding' : maxMode ? 'Send max' : 'Send'}
			</Button>
			{result?.kind === 'unknown' && (
				<div className={result.waiting ? 'info-note' : 'error-note'} style={{ marginTop: 12 }} role="status">
					{describeUnknown(result)}
				</div>
			)}
			{result?.fallback && (
				<div className="info-note" style={{ marginTop: 12 }} role="status">
					{describeFallback(result.fallback)}
					{result.fallback.persisted === false && (
						<div role="alert">
							The fallback reason could not be saved to Activity. Keep this note for your records.
						</div>
					)}
				</div>
			)}
			{result?.kind === 'splice' && (
				<div className="info-note" style={{ marginTop: 12 }}>
					Sent from your channel.{result.txid ? ' Transaction: ' : ''}
					{result.txid && <span className="mono">{result.txid}</span>}
				</div>
			)}
			{result?.kind === 'funding' && (
				<div className={result.outcome.failed ? 'error-note' : 'info-note'} style={{ marginTop: 12 }}>
					{describeFunding(result.outcome)}
					{result.outcome.txid && (
						<div>
							Transaction: <span className="mono">{result.outcome.txid}</span>
						</div>
					)}
				</div>
			)}
			{stepsFor && <LiveFundingSteps key={stepsFor.attempt} walletId={id} requestId={stepsFor.requestId} />}
		</Card>
	);
}
