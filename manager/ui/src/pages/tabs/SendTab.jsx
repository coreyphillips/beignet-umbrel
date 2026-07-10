import { useEffect, useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, Field, Badge, Segmented } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { manager, walletApi } from '../../api.js';

export default function SendTab({ id, api, info, rec, tick, bump }) {
	const [mode, setMode] = useState('onchain');
	const { data: channels } = usePoll(() => api.get('/channels').catch(() => null), 15000, [id, tick]);
	const canLightning = channels
		? channels.some((c) => c.state === 'NORMAL')
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
					['lightning', 'Lightning', !canLightning, 'Open a channel first'],
					['keysend', 'Keysend', !canLightning, 'Open a channel first']
				]}
			/>
			{channels && !canLightning && (
				<div className="info-note" style={{ marginBottom: 14 }}>
					Lightning payments need an open channel. Open one in the Channels tab.
				</div>
			)}
			{mode === 'onchain' && <OnChain id={id} api={api} info={info} rec={rec} bump={bump} />}
			{mode === 'lightning' && <Lightning api={api} bump={bump} />}
			{mode === 'keysend' && <Keysend api={api} bump={bump} />}
		</div>
	);
}

// P2WPKH size approximation: ~10.5 vB overhead + ~68 vB per input + ~31 vB per output.
const vbytes = (nIn, nOut) => Math.ceil(10.5 + nIn * 68 + nOut * 31);

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
	const sweepInputs = utxos?.length || 1;
	const estFee = effRate ? vbytes(Math.max(1, Math.min(sweepInputs, 2)), 2) * effRate : null;
	const estMaxFee = effRate ? vbytes(sweepInputs, 1) * effRate : null;
	const amountNum = parseInt(amount, 10) || 0;
	const overBalance =
		!maxMode && amountNum > 0 && balance != null && estFee != null && amountNum + estFee > balance;
	const nearMax =
		!maxMode && !overBalance && amountNum > 0 && balance != null && estFee != null &&
		amountNum >= balance - estFee * 2;

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
			if (feeRate) base.satsPerVbyte = parseInt(feeRate, 10);
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
			<div className="row">
				<Field
					label="Amount (sats)"
					hint={
						maxMode
							? estMaxFee != null && balance != null
								? `~${fmtSats(Math.max(0, balance - estMaxFee))} after fees (exact amount computed by the wallet)`
								: 'Entire balance minus network fee'
							: undefined
					}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
						<input
							value={maxMode ? (balance != null ? String(balance) : '') : amount}
							disabled={maxMode}
							onChange={(e) => setAmount(e.target.value)}
						/>
						<button
							type="button"
							className={`btn sm ${maxMode ? 'primary' : ''}`}
							onClick={() => setMaxMode((v) => !v)}
						>
							Max
						</button>
					</div>
				</Field>
				<Field label="Fee rate (sat/vB, optional)">
					<input value={feeRate} onChange={(e) => setFeeRate(e.target.value)} placeholder="auto" />
				</Field>
			</div>
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
			{estFee != null && (
				<div className="wallet-meta" style={{ marginBottom: 12 }}>
					Estimated fee: ~{fmtSats(maxMode ? estMaxFee : estFee)} at {effRate} sat/vB (approximate)
				</div>
			)}
			{overBalance && (
				<div className="error-note" style={{ marginBottom: 12 }}>
					Amount plus the estimated fee exceeds your balance.{' '}
					<button type="button" className="btn sm" onClick={() => setMaxMode(true)}>
						Send max instead
					</button>
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
				disabled={!address || (!maxMode && amountNum <= 0) || overBalance || balance === 0 || fetchingAddr}
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

function Keysend({ api, bump }) {
	const toast = useToast();
	const [pubkey, setPubkey] = useState('');
	const [amount, setAmount] = useState('');
	const [busy, setBusy] = useState(false);

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
			<Field label="Amount (sats)">
				<input value={amount} onChange={(e) => setAmount(e.target.value)} />
			</Field>
			<Button variant="primary" busy={busy} onClick={send} disabled={!pubkey || !amount}>
				Send keysend
			</Button>
		</Card>
	);
}
