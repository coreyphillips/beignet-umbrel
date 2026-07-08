import { useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, Field, Badge } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';

export default function SendTab({ api, info, bump }) {
	const [mode, setMode] = useState('onchain');
	return (
		<div>
			<div className="pills">
				<button className={`pill ${mode === 'onchain' ? 'active' : ''}`} onClick={() => setMode('onchain')}>
					On-chain
				</button>
				<button className={`pill ${mode === 'lightning' ? 'active' : ''}`} onClick={() => setMode('lightning')}>
					Lightning
				</button>
				<button className={`pill ${mode === 'keysend' ? 'active' : ''}`} onClick={() => setMode('keysend')}>
					Keysend
				</button>
			</div>
			{mode === 'onchain' && <OnChain api={api} info={info} bump={bump} />}
			{mode === 'lightning' && <Lightning api={api} bump={bump} />}
			{mode === 'keysend' && <Keysend api={api} bump={bump} />}
		</div>
	);
}

function OnChain({ api, info, bump }) {
	const toast = useToast();
	const [address, setAddress] = useState('');
	const [amount, setAmount] = useState('');
	const [feeRate, setFeeRate] = useState('');
	const [busy, setBusy] = useState(false);
	const [txid, setTxid] = useState('');
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);

	const send = async () => {
		setBusy(true);
		setTxid('');
		try {
			const body = { address: address.trim(), amountSats: parseInt(amount, 10) };
			if (feeRate) body.satsPerVbyte = parseInt(feeRate, 10);
			const r = await api.post('/send', body);
			setTxid(r.txid);
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
				Available: {fmtSats(info?.onchainBalanceSats)}
			</div>
			<Field label="Recipient address">
				<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="bc1…" />
			</Field>
			<div className="row">
				<Field label="Amount (sats)">
					<input value={amount} onChange={(e) => setAmount(e.target.value)} />
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
			<Button variant="primary" busy={busy} onClick={send} disabled={!address || !amount}>
				Send
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
