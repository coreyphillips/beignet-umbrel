import { useMemo, useRef, useState } from 'react';
import AssetAmountField from '../../../../components/AssetAmountField.jsx';
import AssetPicker, { NO_ASSET } from '../../../../components/AssetPicker.jsx';
import { useToast } from '../../../../components/Toast.jsx';
import { Button, Empty, FeeField, Field, Modal, Skeleton } from '../../../../components/ui.jsx';
import { useAssetBalances, useAssetQuote, useAssetsApi } from '../../../../hooks/useAssets.js';
import { usePoll } from '../../../../hooks/usePoll.js';
import { cmpUnits, decimalsOf, fmtAsset, isZero, unitsToInput } from '../../../../lib/asset-amount.js';
import { channelAssets, lightningRefusal, parsePeer } from '../../../../lib/asset-lightning.js';
import { submitOnce } from '../../../../lib/assets.js';
import { idempotencyKey } from '../../../../lib/assets-api.js';
import { FEE_CAP_MULTIPLE } from '../../../../lib/fees.js';
import { fmtSats, shortId } from '../../../../lib/format.js';
import { nodeNames } from '../../../../lib/node-names.js';
import { FeePresets, useFees } from '../shared.jsx';

const OTHER_PEER = '__other__';

/**
 * Opening a channel funded with an asset.
 *
 * Four things are asked for: which asset, how much of it, the peer, and the
 * fee rate of the funding transaction. Before the button works the wallet
 * has said what opening costs in bitcoin, which is a second thing the
 * channel needs beside the asset: sats that sit in the channel with it, and
 * the mining fee.
 *
 * Any peer can be named. Whether it takes asset channels is its own answer
 * to give, so a peer that does not is found out when the wallet asks it, and
 * the refusal says nothing was opened or spent.
 *
 * `assetKey` is the asset to start on, for arriving from an asset's page.
 */
export default function OpenAssetChannelModal({ id, api, assetKey, origin, onClose, onDone }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const { holdings, btc } = useAssetBalances(api, 0);
	const fees = useFees(api);
	const fundable = useMemo(() => channelAssets(holdings), [holdings]);

	const [picker, setPicker] = useState(() => ({ ...NO_ASSET, key: assetKey || null }));
	const [text, setText] = useState('');
	const [units, setUnits] = useState(null);
	const [peerSel, setPeerSel] = useState('');
	const [peerText, setPeerText] = useState('');
	const [feeRate, setFeeRate] = useState('');
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState(null);
	const opening = useRef(false);

	// One asset to choose from is not a choice: it is chosen. An asset that
	// was asked for and has nothing on-chain is not on the list, so it is not
	// held on to either.
	const chosen = fundable.some((a) => a.key === picker.key) ? picker.key : null;
	const key = chosen || (fundable.length === 1 ? fundable[0].key : null);
	const asset = fundable.find((a) => a.key === key) || null;
	const decimals = decimalsOf(asset);
	const onchain = asset?.balance?.onchain || '0';
	const isMax = !!units && cmpUnits(units, onchain) === 0;
	const tooMuch = !!units && cmpUnits(units, onchain) > 0;
	const amountOk = !!asset && !!units && !isZero(units) && !tooMuch;

	// Peers this wallet is connected to now, named from its map of the
	// network. A channel can be opened to any of them without an address.
	const { data: connected } = usePoll(
		async () => {
			const list = ((await api.get('/peers').catch(() => null)) || []).filter((p) => p.state === 'connected' || p.state === 'ready');
			const names = await nodeNames.lookup(api, id, list.map((p) => p.pubkey)).catch(() => ({}));
			return list.map((p) => ({ ...p, alias: p.alias || names[p.pubkey]?.alias || null }));
		},
		30000,
		[api, id]
	);
	const peers = connected || [];
	const typing = peers.length === 0 || peerSel === OTHER_PEER;
	const typed = parsePeer(peerText);
	const picked = peers.find((p) => p.pubkey === peerSel) || null;
	const peer = typing
		? typed.ok
			? typed.peer
			: null
		: picked
			? { pubkey: picked.pubkey, host: picked.host || null, port: picked.port || null, alias: picked.alias || null }
			: null;

	const rate = parseInt(feeRate, 10) || fees?.fast || null;
	const { quote, error: quoteError, pending } = useAssetQuote(
		(p) => assets.channelQuote(p),
		{ key: asset?.key, amount: units, feeRate: rate },
		amountOk && !!rate
	);
	const short = !!quote && quote.sufficient === false;
	const quoteRefusal = quoteError ? lightningRefusal(quoteError, { asset }) : null;
	const canOpen = amountOk && !!peer && !!quote && !pending && !short && !quoteError && !busy;
	const what = asset && units && !isZero(units) ? fmtAsset(units, asset) : '';

	const open = async () => {
		if (opening.current || !canOpen) return;
		opening.current = true;
		setBusy(true);
		setFailure(null);
		try {
			const answer = await submitOnce(
				(k) => assets.openChannel({ peer, key: asset.key, amount: units, feeRate: rate }, k),
				idempotencyKey()
			);
			toast(`Opening a ${asset.name} channel. It can be used once its funding transaction confirms.`, 'success');
			onDone(answer);
		} catch (e) {
			setFailure(lightningRefusal(e, { asset }));
		} finally {
			opening.current = false;
			setBusy(false);
		}
	};

	return (
		<Modal
			title="Open asset channel"
			help="A Lightning channel funded with an asset. Payments through it are made in the asset, and the peer exchanges it for bitcoin at a price it quotes each time."
			onClose={onClose}
			origin={origin}
		>
			<div data-testid="asset-channel-open-dialog">
				{holdings === null ? (
					<Skeleton height={120} />
				) : fundable.length === 0 ? (
					<>
						<Empty>
							This wallet holds no asset on-chain to put in a channel. Create one, or receive one, on the Assets tab
							first.
						</Empty>
						<div className="center-actions">
							<Button onClick={onClose}>Close</Button>
						</div>
					</>
				) : (
					<>
						<AssetPicker
							label="Asset"
							assets={fundable}
							value={{ ...picker, key }}
							onChange={(next) => {
								setPicker(next);
								setText('');
								setUnits(null);
								setFailure(null);
							}}
							testId="asset-channel-picker"
						/>

						{asset && (
							<AssetAmountField
								label="Amount to put in"
								asset={asset}
								value={text}
								onChange={(t, u) => {
									setText(t);
									setUnits(u);
									setFailure(null);
								}}
								max={onchain}
								isMax={isMax}
								onMax={() => {
									setText(unitsToInput(onchain, decimals));
									setUnits(onchain);
								}}
								testId="asset-channel-amount"
								refusal={tooMuch ? `That is more than the ${fmtAsset(onchain, asset)} this wallet holds on-chain.` : undefined}
								hint="It all starts on your side: you can pay with it as soon as the channel is open, and receive only once some has gone out, or the peer has put in some of its own."
							/>
						)}

						{peers.length > 0 && (
							<Field label="Peer">
								<select
									value={peerSel}
									data-testid="asset-channel-peer"
									onChange={(e) => {
										setPeerSel(e.target.value);
										setFailure(null);
									}}
								>
									<option value="" disabled>
										Choose a peer
									</option>
									{peers.map((p) => (
										<option key={p.pubkey} value={p.pubkey}>
											{p.alias ? `${p.alias} · ${shortId(p.pubkey)}` : shortId(p.pubkey, 10)}
										</option>
									))}
									<option value={OTHER_PEER}>Another peer…</option>
								</select>
							</Field>
						)}
						{typing && (
							<Field label={peers.length > 0 ? 'Peer to connect to' : 'Peer'}>
								<input
									className="mono"
									value={peerText}
									placeholder="02abc…@host:9735"
									autoComplete="off"
									spellCheck={false}
									data-testid="asset-channel-peer-input"
									onChange={(e) => {
										setPeerText(e.target.value.replace(/\s+/g, ''));
										setFailure(null);
									}}
								/>
								{typed.reason ? (
									<span className="field-hint refusal" role="alert" data-testid="asset-channel-peer-refusal">
										{typed.reason}
									</span>
								) : (
									<span className="field-hint">The node&apos;s public key, then @ and where it listens.</span>
								)}
							</Field>
						)}
						<div className="field-note" data-testid="asset-channel-peer-note">
							The peer has to take asset channels. If it does not, the wallet says so and nothing is opened.
						</div>

						<FeeField
							label="Funding fee rate (sat/vB)"
							value={feeRate}
							onChange={setFeeRate}
							rate={rate}
							max={Math.max(10, (fees?.fast || 10) * FEE_CAP_MULTIPLE)}
							hint="The rate the funding transaction is broadcast at. It starts at the fast rate, so the channel does not sit unconfirmed."
						/>
						<FeePresets fees={fees} onPick={setFeeRate} />

						<div className="asset-channel-cost" role="status" aria-live="polite">
							{amountOk && quote ? (
								<>
									<table className="kv mint-cost" data-testid="asset-channel-cost">
										<tbody>
											<tr>
												<td>Goes into the channel</td>
												<td>
													{what}
													<span className="kv-sub">and {fmtSats(quote.channelSats)} of bitcoin with it</span>
												</td>
											</tr>
											<tr>
												<td>Miner fee</td>
												<td>
													{fmtSats(quote.feeSats)}
													<span className="kv-sub">at {rate} sat/vB</span>
												</td>
											</tr>
											<tr>
												<td>Total in bitcoin</td>
												<td>
													<strong>{fmtSats(quote.totalSats)}</strong>
												</td>
											</tr>
											<tr>
												<td>On-chain available</td>
												<td>{fmtSats(quote.spendableSats ?? btc?.spendableSats)}</td>
											</tr>
										</tbody>
									</table>
									<div className="field-hint">
										The bitcoin in the channel stays yours and comes back when the channel is closed. The miner fee is
										spent.
									</div>
								</>
							) : amountOk && !quoteError ? (
								<div className="wallet-meta" data-testid="asset-channel-cost-pending">
									Working out the cost…
								</div>
							) : null}
						</div>

						{short && (
							<div className="error-note" role="alert" data-testid="asset-channel-refusal" data-code="INSUFFICIENT_BTC">
								Opening needs {fmtSats(quote.totalSats)} on-chain and this wallet has {fmtSats(quote.spendableSats)}.
								Deposit bitcoin on the Receive tab first.
							</div>
						)}
						{quoteRefusal && !failure && (
							<div className="error-note" role="alert" data-testid="asset-channel-refusal" data-code={quoteRefusal.code}>
								{quoteRefusal.text}
							</div>
						)}
						{failure && (
							<div className="error-note" role="alert" data-testid="asset-channel-refusal" data-code={failure.code}>
								{failure.text}
							</div>
						)}

						<div className="center-actions">
							<Button variant="primary" busy={busy} disabled={!canOpen} data-testid="asset-channel-submit" onClick={open}>
								{what ? `Open channel with ${what}` : 'Open channel'}
							</Button>
							<Button onClick={onClose}>{failure ? 'Close' : 'Cancel'}</Button>
						</div>
					</>
				)}
			</div>
		</Modal>
	);
}
