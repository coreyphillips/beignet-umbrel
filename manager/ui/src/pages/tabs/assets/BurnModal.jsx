import { useMemo, useRef, useState } from 'react';
import AssetAmountField from '../../../components/AssetAmountField.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { Button, FeeField, Field, Modal } from '../../../components/ui.jsx';
import { useAssetPreview } from '../../../hooks/useAssetPreview.js';
import { useAssetsApi } from '../../../hooks/useAssets.js';
import { cmpUnits, decimalsOf, fmtAsset, isZero, unitsToInput } from '../../../lib/asset-amount.js';
import { fullName, onHandShortage, sentence } from '../../../lib/assets.js';
import { idempotencyKey } from '../../../lib/assets-api.js';
import { FEE_CAP_MULTIPLE } from '../../../lib/fees.js';
import { fmtSats } from '../../../lib/format.js';
import { FeePresets, NoBumpNote } from './shared.jsx';

/**
 * Burning: destroying units of an asset for good.
 *
 * It is the one thing on the Assets tab that cannot be put right afterwards,
 * so it is asked for twice. The amount is typed, the wallet builds the exact
 * transaction and says what it costs, and then the asset's name has to be
 * typed before the button will work. The amount goes to the wallet a second
 * time with the commit, and the wallet refuses if the two disagree.
 *
 * Only what is on-chain can be burned. Units in a Lightning channel are not
 * this dialog's to destroy, and it says how many there are so the Max button
 * is not mistaken for "everything".
 */
export default function BurnModal({ api, asset, fees, origin, onClose, onBurned }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const decimals = decimalsOf(asset);
	const collectible = asset.type === 'collectible';
	const onchain = asset.balance.onchain;
	const [text, setText] = useState(collectible ? '1' : '');
	const [units, setUnits] = useState(collectible ? '1' : null);
	const [feeRate, setFeeRate] = useState('');
	const [typed, setTyped] = useState('');
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState(null);
	// One press, one burn.
	const burning = useRef(false);

	const rate = parseInt(feeRate, 10) || fees?.fast || null;
	const isMax = !!units && cmpUnits(units, onchain) === 0;
	const tooMuch = !!units && cmpUnits(units, onchain) > 0;
	const ready = !!units && !isZero(units) && !tooMuch && !!rate;
	const params = useMemo(() => ({ key: asset.key, assetId: asset.assetId, amount: units, feeRate: rate }), [asset.key, asset.assetId, units, rate]);
	const { preview, error, pending, consume, refresh } = useAssetPreview({
		prepare: (p, key) => assets.prepareBurn(p, key),
		cancel: (id) => assets.cancelBurn(id),
		params,
		scope: `${asset.key}:${units}`,
		enabled: ready
	});

	const name = fullName(asset);
	const named = typed.trim() === name.trim();
	const what = units ? fmtAsset(units, asset) : name;
	const canBurn = ready && !!preview && !pending && named && !busy;

	const burn = async () => {
		if (burning.current) return;
		burning.current = true;
		setBusy(true);
		setFailure(null);
		try {
			await assets.commitBurn({ previewId: preview.previewId, confirmAmount: units }, idempotencyKey());
			consume();
			toast('Burn broadcast', 'success');
			onBurned();
		} catch (e) {
			if (e.code === 'PREVIEW_EXPIRED') {
				setFailure('The prepared transaction expired before it was sent, so it was prepared again. Check the fee and press Burn once more.');
				refresh();
			} else {
				setFailure(sentence(e.message || 'The burn could not be sent'));
			}
		} finally {
			burning.current = false;
			setBusy(false);
		}
	};

	return (
		<Modal title={`Burn ${name}`} origin={origin} onClose={onClose}>
			<div data-testid="asset-burn">
				<div className="error-note" role="alert">
					Burning destroys these units for good. It cannot be undone.
				</div>
				{collectible ? (
					<div className="field">
						<span className="field-label">Amount to burn</span>
						<div className="static-value">1 (collectible)</div>
					</div>
				) : (
					<AssetAmountField
						label="Amount to burn"
						asset={asset}
						value={text}
						onChange={(t, u) => {
							setText(t);
							setUnits(u);
						}}
						max={onchain}
						isMax={isMax}
						onMax={() => {
							setText(unitsToInput(onchain, decimals));
							setUnits(onchain);
						}}
						testId="asset-burn-amount"
						hint={isMax ? 'This burns everything you hold on-chain.' : undefined}
					/>
				)}
				{tooMuch && (
					<div className="error-note" role="alert">
						That is more than the {fmtAsset(onchain, asset)} this wallet holds on-chain.
					</div>
				)}
				{!isZero(asset.balance.channelLocal) && (
					<div className="field-note">
						{fmtAsset(asset.balance.channelLocal, asset)} in Lightning channels cannot be burned from here.
					</div>
				)}
				<FeeField
					label="Fee rate (sat/vB)"
					value={feeRate}
					onChange={setFeeRate}
					rate={rate}
					max={Math.max(10, (fees?.fast || 10) * FEE_CAP_MULTIPLE)}
				/>
				<FeePresets fees={fees} onPick={setFeeRate} />
				<NoBumpNote what="burn" />
				<div role="status" aria-live="polite" data-testid="asset-burn-preview">
					{ready && pending && !preview && <div className="wallet-meta">Preparing the transaction…</div>}
					{preview && (
						<div className="wallet-meta" style={{ marginBottom: 12 }}>
							Miner fee: {fmtSats(preview.fee.sats)} at {preview.fee.feeRate} sat/vB over {preview.fee.vbytes} vB. This
							is what the transaction pays, not an estimate of it.
						</div>
					)}
				</div>
				{error && ready && (
					<div className="error-note" role="alert" data-code={error.code}>
						{error.code === 'INSUFFICIENT_BTC' && error.details
							? onHandShortage(error.details, 'Burning') ||
								`Burning needs ${fmtSats(error.details.needed)} in bitcoin for the miner fee, and this wallet has ${fmtSats(error.details.spendable)} on-chain. Deposit bitcoin on the Receive tab first.`
							: sentence(error.message || 'The wallet could not prepare this burn')}
					</div>
				)}
				<Field label={`Type ${name} to confirm`}>
					<input
						value={typed}
						autoComplete="off"
						spellCheck={false}
						data-testid="asset-burn-name"
						onChange={(e) => setTyped(e.target.value)}
					/>
				</Field>
				{failure && (
					<div className="error-note" role="alert">
						{failure}
					</div>
				)}
				<div className="center-actions">
					<Button variant="danger" busy={busy} disabled={!canBurn} data-testid="asset-burn-confirm" onClick={burn}>
						Burn {what}
					</Button>
					<Button onClick={onClose}>Cancel</Button>
				</div>
			</div>
		</Modal>
	);
}
