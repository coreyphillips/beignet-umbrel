import { useEffect, useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { AmountField, Button, Card, Field, FeeField, Badge, Segmented } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { FEE_CAP_MULTIPLE } from '../../lib/fees.js';
import { useQuote } from '../../hooks/useQuote.js';
import { manager, walletApi } from '../../api.js';

export default function SendTab({ id, api, info, rec, tick, bump }) {
	const [mode, setMode] = useState('onchain');
	const { data: channels } = usePoll(() => api.get('/channels').catch(() => null), 15000, [id, tick]);
	// beignet 0.6.0 pays during splices: the daemon marks each channel with
	// htlcUsable, true for NORMAL and for a channel mid-splice that carries
	// payments through its confirmation window. Older daemons lack the flag,
	// so NORMAL remains the fallback. splicingOnly covers the rare parked
	// splice (e.g. taproot), where "open a channel first" would still be the
	// wrong message.
	const usable = (c) => c.htlcUsable ?? c.state === 'NORMAL';
	const splicingOnly = channels
		? channels.length > 0 &&
		  !channels.some(usable) &&
		  channels.some((c) => c.state === 'SPLICING')
		: false;
	const canLightning = channels
		? channels.some(usable)
		: (info?.channelCount ?? 0) > 0;

	useEffect(() => {
		if (!canLightning && mode !== 'onchain') setMode('onchain');
	}, [canLightning, mode]);

	return (
		<div>
			<Segmented
				id="send-mode"
				value={mode}
				onChange={setMode}
				options={[
					['onchain', 'On-chain'],
					['lightning', 'Lightning', !canLightning, splicingOnly ? 'A splice is confirming' : 'Open a channel first'],
					['keysend', 'Keysend', !canLightning, splicingOnly ? 'A splice is confirming' : 'Open a channel first']
				]}
			/>
			{channels && !canLightning && (
				<div className="info-note" style={{ marginBottom: 14 }}>
					{splicingOnly
						? 'Your channel is mid-splice. Its funds are safe, and Lightning payments resume when the splice transaction confirms and locks.'
						: 'Lightning payments need an open channel. Open one in the Channels tab.'}
				</div>
			)}
			{mode === 'onchain' && <OnChain id={id} api={api} info={info} rec={rec} bump={bump} />}
			{mode === 'lightning' && <Lightning api={api} bump={bump} />}
			{mode === 'keysend' && <Keysend api={api} channels={channels} bump={bump} />}
		</div>
	);
}

function OnChain({ id, api, info, rec, bump }) {
	const toast = useToast();
	const [address, setAddress] = useState('');
	const [amount, setAmount] = useState('');
	const [feeRate, setFeeRate] = useState('');
	const [dest, setDest] = useState('custom');
	const [maxMode, setMaxMode] = useState(false);
	const [fetchingAddr, setFetchingAddr] = useState(false);
	const [busy, setBusy] = useState(false);
	const [txid, setTxid] = useState('');
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);
	const { data: wallets } = usePoll(() => manager.listWallets().catch(() => []), 15000, []);
	const { data: utxos } = usePoll(() => api.get('/utxos').catch(() => null), 30000, [id]);

	const others = (wallets || []).filter(
		(w) => w.id !== id && w.status === 'running' && w.network === rec?.network
	);
	const balance = info?.onchainBalanceSats;
	const effRate = parseInt(feeRate, 10) || fees?.normal || null;
	const typed = parseInt(amount, 10) || 0;

	// What this transaction really costs, from the wallet, which is the only place
	// that knows. The fee turns on which UTXOs coin selection picks, on their
	// script types and on whether change is needed, so it is asked for rather than
	// guessed at, and asked for again whenever the amount, the rate or the mode
	// changes. The destination is part of the question: paying a taproot address
	// costs more than paying a P2WPKH one.
	const { quote } = useQuote(
		api,
		{
			address: address.trim() || undefined,
			// A probe of 1 sat when nothing is typed yet: the ceiling of the amount
			// slider is the balance less the fee, so there has to be a fee before
			// there is a slider to type into. The wallet consolidates its UTXOs, so
			// the fee does not turn on the amount, and this re-quotes as it changes.
			amountSats: maxMode ? undefined : typed || 1,
			satsPerVbyte: effRate || undefined,
			max: maxMode
		},
		balance > 0 && effRate > 0
	);

	// A sweep spends everything and needs no change output, so it is smaller, pays
	// less, and sends more than any ordinary payment can. The wallet works out that
	// amount exactly; it is not balance minus a guess.
	const sweepAmount = maxMode ? (quote?.maxSendSats ?? null) : null;
	const feeSats = quote?.feeSats ?? null;
	const vsize = quote?.vsize ?? null;

	// The most an ordinary payment can send: everything the fee leaves behind.
	const ordinaryMax =
		balance != null && feeSats != null ? Math.max(0, balance - feeSats) : 0;

	// Pressing Max asks a new question, and the answer takes a moment to come back.
	// The range must not collapse to nothing while it does: a slider that drops to
	// zero mid-drag hands back a zero, which reads as "the user asked for nothing"
	// and knocks Max straight off again. Hold the last ceiling until the real one
	// arrives; it is a few hundred sats out for one frame, and never zero.
	const sliderMax = maxMode ? sweepAmount ?? ordinaryMax : ordinaryMax;

	// In max mode the amount is derived, never stored: storing it would freeze the
	// number taken at the moment Max was pressed, and it would then disagree with
	// the fee rate the payment actually goes out at.
	const shownAmount = maxMode
		? String(sweepAmount ?? ordinaryMax)
		: amount;
	const amountNum = maxMode ? sweepAmount || 0 : typed;

	// The one rule the form holds to: amount + fee never exceeds the balance. It is
	// enforced by refusing input that would break it rather than by accepting the
	// input and complaining afterwards, so the form is never in a state that cannot
	// be broadcast.
	//
	// The fee is the transaction's size times the rate, and the size is the quote's,
	// not an approximation of it. Sweeping has no amount to leave room for, only the
	// fee itself; otherwise the fee may grow into the gap between the amount and the
	// balance, and no further.
	const affordableRate =
		balance == null || !vsize
			? 0
			: maxMode
			? Math.floor(balance / vsize)
			: Math.floor(Math.max(0, balance - typed) / vsize);

	// Where the slider *ends*, which is a different question. A slider has to stop
	// somewhere, and a few times the fast estimate is a sane place for it, but that
	// is a convenience and not a rule: type 200 and the range grows to meet you,
	// rather than the form pretending 200 is not a fee rate. Affordability still
	// binds, because that one is arithmetic.
	const typedRate = parseInt(feeRate, 10) || 0;
	const feeMax = Math.max(
		1,
		Math.min(
			Math.max(fees?.fast ? fees.fast * FEE_CAP_MULTIPLE : 100, typedRate),
			affordableRate || Infinity
		)
	);

	// Reaching the top of the amount range means "everything", which is what Max is,
	// so arriving there presses it rather than leaving a number that Max would beat.
	// Coming back down leaves max mode, clamped to what an ordinary payment can send.
	const setAmountManually = (val) => {
		const next = parseInt(val, 10) || 0;
		if (maxMode) {
			// Still waiting on the sweep's own figure: nothing said now is a real
			// choice of amount, so it must not be taken as one.
			if (sweepAmount == null) return;
			if (next >= sweepAmount) return; // still at the top
			setMaxMode(false);
			setAmount(String(Math.min(next, ordinaryMax)));
			return;
		}
		if (ordinaryMax > 0 && next >= ordinaryMax) {
			setMaxMode(true);
			return;
		}
		setAmount(val);
	};

	// A fee the balance cannot cover alongside the amount is not accepted. Anything
	// it can cover is, however large, and the slider stretches to show it. An empty
	// field means "let the wallet pick" and always passes.
	const setFeeRateManually = (val) => {
		const next = parseInt(val, 10) || 0;
		if (affordableRate > 0 && next > affordableRate) return;
		setFeeRate(val);
	};

	// A balance that drops, or a fee that climbs, can still strand an amount that
	// was affordable when it was entered. Rather than leave the form unsendable,
	// fall back to sweeping, which is what the amount was reaching for.
	const stranded =
		!maxMode && typed > 0 && balance != null && feeSats != null && typed + feeSats > balance;
	useEffect(() => {
		if (stranded) setMaxMode(true);
	}, [stranded]);

	const nearMax =
		!maxMode && amountNum > 0 && balance != null && feeSats != null &&
		amountNum >= balance - feeSats * 2;

	const onDest = async (val) => {
		setDest(val);
		if (val === 'custom') {
			setAddress('');
			return;
		}
		setFetchingAddr(true);
		try {
			const r = await walletApi(val).post('/address/new', {});
			setAddress(r.address);
		} catch (e) {
			toast(`Could not get address: ${e.message}`, 'error');
			setDest('custom');
		} finally {
			setFetchingAddr(false);
		}
	};

	const send = async () => {
		setBusy(true);
		setTxid('');
		try {
			const base = { address: address.trim() };
			const rate = parseInt(feeRate, 10);
			if (rate > 0) base.satsPerVbyte = rate;
			const r = maxMode
				? await api.post('/send-max', base)
				: await api.post('/send', { ...base, amountSats: parseInt(amount, 10) });
			setTxid(r.txid);
			setMaxMode(false);
			setAmount('');
			if (dest !== 'custom') setDest('custom');
			toast('Sent', 'success');
			bump();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title="Send on-chain">
			<div className="wallet-meta" style={{ marginBottom: 12 }}>
				Available: {fmtSats(balance)}
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
			<Field label="Recipient address">
				<input
					value={address}
					onChange={(e) => {
						setAddress(e.target.value);
						if (dest !== 'custom') setDest('custom');
					}}
					placeholder={fetchingAddr ? 'Fetching address…' : 'bc1…'}
				/>
			</Field>
			<AmountField
				label="Amount (sats)"
				value={shownAmount}
				onChange={setAmountManually}
				max={maxMode ? sweepAmount || 0 : sliderMax}
				isMax={maxMode}
				onMax={() => setMaxMode((v) => !v)}
				hint={
					maxMode
						? 'Sweeps the whole balance. The wallet works out the exact amount when it broadcasts, so this follows the fee rate you pick.'
						: 'The slider stops at the most you can send at this fee rate, so it leaves room for the fee.'
				}
			/>
			<FeeField
				label="Fee rate (sat/vB)"
				value={feeRate}
				onChange={setFeeRateManually}
				rate={effRate}
				max={feeMax}
				hint={
					maxMode
						? 'With Max on, raising the fee takes sats off the amount above, so the total never exceeds your balance.'
						: 'Stops where the fee would eat into the amount above. Lower the amount to raise it further, or leave empty to let the wallet pick.'
				}
			/>
			{fees && (
				<div className="preset-row" style={{ marginBottom: 14 }}>
					{[
						['Fast', fees.fast],
						['Normal', fees.normal],
						['Slow', fees.slow]
					].map(([label, rate]) => (
						<button
							key={label}
							type="button"
							className="btn sm"
							// A preset above the headroom would break the same rule the
							// slider is held to, so it is offered but not selectable.
							disabled={rate > feeMax}
							title={rate > feeMax ? 'Lower the amount to afford this fee rate' : undefined}
							onClick={() => setFeeRateManually(String(rate))}
						>
							{label} · {rate} sat/vB
						</button>
					))}
				</div>
			)}
			{feeSats != null && (
				<div className="wallet-meta" style={{ marginBottom: 12 }}>
					Fee: {fmtSats(feeSats)} at {effRate} sat/vB over {vsize} vB. This is what the
					transaction pays, not an estimate of it.
				</div>
			)}
			{nearMax && (
				<div className="info-note" style={{ marginBottom: 12 }}>
					This is close to your full balance. Use Max to sweep everything without leaving dust behind.
				</div>
			)}
			<Button
				variant="primary"
				busy={busy}
				onClick={send}
				disabled={!address || amountNum <= 0 || balance === 0 || fetchingAddr}
			>
				{maxMode ? 'Send max' : 'Send'}
			</Button>
			{txid && (
				<div className="info-note" style={{ marginTop: 12 }}>
					Broadcast: <span className="mono">{txid}</span>
				</div>
			)}
		</Card>
	);
}

function Lightning({ api, bump }) {
	const toast = useToast();
	const [bolt11, setBolt11] = useState('');
	const [decoded, setDecoded] = useState(null);
	const [estimate, setEstimate] = useState(null);
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(null);

	const decode = async () => {
		setDecoded(null);
		setEstimate(null);
		setResult(null);
		try {
			const d = await api.post('/invoice/decode', { bolt11: bolt11.trim() });
			setDecoded(d);
			api
				.post('/payment/estimate', { bolt11: bolt11.trim() })
				.then(setEstimate)
				.catch(() => setEstimate(null));
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	const pay = async () => {
		setBusy(true);
		setResult(null);
		try {
			const r = await api.post('/invoice/pay-safe', { bolt11: bolt11.trim() });
			setResult(r);
			toast(r.status === 'COMPLETED' ? 'Payment sent' : `Payment ${r.status}`, r.status === 'COMPLETED' ? 'success' : 'error');
			bump();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title="Pay a Lightning invoice">
			<Field label="BOLT11 invoice">
				<textarea rows={3} value={bolt11} onChange={(e) => setBolt11(e.target.value)} placeholder="lnbc…" />
			</Field>
			<div className="center-actions">
				<Button onClick={decode} disabled={!bolt11}>
					Decode
				</Button>
				<Button variant="primary" busy={busy} onClick={pay} disabled={!decoded}>
					Pay
				</Button>
			</div>
			{decoded && (
				<table style={{ marginTop: 14 }}>
					<tbody>
						<tr>
							<td className="wallet-meta">Amount</td>
							<td>{decoded.amountSats ? fmtSats(decoded.amountSats) : 'any (zero-amount)'}</td>
						</tr>
						<tr>
							<td className="wallet-meta">Description</td>
							<td>{decoded.description || '-'}</td>
						</tr>
						<tr>
							<td className="wallet-meta">Payee</td>
							<td className="mono">{shortId(decoded.payeeNodeKey)}</td>
						</tr>
						{estimate && (
							<tr>
								<td className="wallet-meta">Estimate</td>
								<td>
									~{fmtSats(estimate.estimatedFeeSats)} fee · {estimate.successProbabilityPct}% success ·{' '}
									{estimate.hopCount} hops
								</td>
							</tr>
						)}
					</tbody>
				</table>
			)}
			{result && (
				<div className={result.status === 'COMPLETED' ? 'info-note' : 'error-note'} style={{ marginTop: 12 }}>
					Payment {result.status}
					{result.feeSats != null ? ` · fee ${fmtSats(result.feeSats)}` : ''}
					{result.failureDescription ? ` · ${result.failureDescription}` : ''}
				</div>
			)}
		</Card>
	);
}

function Keysend({ api, channels, bump }) {
	const toast = useToast();
	const [pubkey, setPubkey] = useState('');
	const [amount, setAmount] = useState('');
	const [busy, setBusy] = useState(false);

	// The most that can leave over Lightning is the local side of the usable
	// channels. Routing fees and each channel's reserve come out of that, so this
	// is a ceiling rather than a promise, and the slider is bounded by it only to
	// keep the amount in the right order of magnitude.
	const outbound = (channels || [])
		.filter((c) => c.state === 'NORMAL')
		.reduce((sum, c) => sum + (c.localBalanceSats || 0), 0);

	const send = async () => {
		setBusy(true);
		try {
			const r = await api.post('/keysend/safe', {
				pubkey: pubkey.trim(),
				amountSats: parseInt(amount, 10)
			});
			toast(r.status === 'COMPLETED' ? 'Keysend sent' : `Keysend ${r.status}`, r.status === 'COMPLETED' ? 'success' : 'error');
			bump();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title="Keysend (spontaneous payment)">
			<Field label="Destination node pubkey">
				<input value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="02…" />
			</Field>
			<AmountField
				label="Amount (sats)"
				value={amount}
				onChange={setAmount}
				max={outbound}
				onMax={() => setAmount(String(outbound))}
				isMax={outbound > 0 && parseInt(amount, 10) === outbound}
				hint="Bounded by your outbound channel balance. Routing fees and the channel reserve come out of it, so the very top of the range may not go through."
			/>
			<Button variant="primary" busy={busy} onClick={send} disabled={!pubkey || !amount}>
				Send keysend
			</Button>
		</Card>
	);
}
