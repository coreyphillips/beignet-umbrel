import { useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import AssetAmountField from '../../../components/AssetAmountField.jsx';
import AssetPicker, { NO_ASSET, pickedAsset } from '../../../components/AssetPicker.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { Badge, Button, Card, Empty, QR, QRZoom } from '../../../components/ui.jsx';
import { useAssetsApi } from '../../../hooks/useAssets.js';
import { usePoll } from '../../../hooks/usePoll.js';
import { decimalsOf, fmtAsset, isZero, smallestAmount } from '../../../lib/asset-amount.js';
import { invoiceShortfall } from '../../../lib/asset-lightning.js';
import { proofServerWait, sentence } from '../../../lib/assets.js';
import { railOf, unwatched } from '../../../lib/asset-progress.js';
import { copy, fmtDate } from '../../../lib/format.js';
import InvoiceCard from './lightning/InvoiceCard.jsx';
import { ImportProofFile, AssetTransferDetail, ProofLateNote, RowAssets, RowStatus, RowTimeline, WatchNote, useRowDetail } from './shared.jsx';

/** The form as it starts, and as "Create another address" leaves it. */
export const EMPTY_RECEIVE = { picker: NO_ASSET, text: '', units: null, created: null };

const HEAD = 14;
const TAIL = 6;

/**
 * The address as a person checks one: the start, which says what it is, and
 * the last six characters, which are what two people read out to each other.
 * The middle is two hundred characters nobody compares.
 */
function TapAddress({ address, what, host }) {
	const toast = useToast();
	const tail = address.slice(-TAIL);
	return (
		<div className="tap-address" data-testid="asset-receive-address">
			<div className="tap-address-line mono" title={address}>
				<span>{address.slice(0, HEAD)}</span>
				<span className="tap-address-gap">…</span>
				<span className="tap-address-tail">{tail}</span>
			</div>
			<div className="center-actions tap-address-actions">
				<Button
					variant="primary"
					className="sm"
					data-testid="asset-address-copy"
					onClick={async () => toast((await copy(address)) ? 'Address copied' : 'Copy failed', 'info')}
				>
					Copy address
				</Button>
				<QRZoom value={address} caps title={`Taproot Assets address for ${what}`} />
			</div>
			<details className="asset-details">
				<summary>Show full address</summary>
				<div className="static-value mono tap-address-full" data-testid="asset-address-full">
					{address}
				</div>
			</details>
			<div className="wallet-meta">
				For {what} · proofs through <code>{host}</code>
			</div>
			<div className="field-hint">
				Send this to the payer. To check it arrived whole, compare the last six characters: <strong>{tail}</strong>.
			</div>
			<div className="field-hint" data-testid="asset-address-once">
				Use this address once. A second payment to it would not be credited.
			</div>
		</div>
	);
}

/**
 * Receiving an asset on-chain.
 *
 * A Taproot Assets address is for one asset and one amount, so both are asked
 * for before there is anything to show. Once made, the address sits beside a
 * timeline that moves by itself as the payment confirms and its proof
 * arrives, and when the asset is in hand the code gives way to a receipt: an
 * address that has been paid should not be left looking like one that is
 * still waiting.
 *
 * The form lives with the tab (`state`, `patch`), so going to look at
 * Holdings and coming back finds the address still there.
 */
export default function ReceiveView({ api, state, patch, holdings, rows, network, host, proofServer, lightning, lightningHeld, bump, onRetryProof, onCheckAddress }) {
	const assets = useAssetsApi(api);
	const detail = useRowDetail();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const [retrying, setRetrying] = useState(false);

	const list = holdings || [];
	const asset = pickedAsset(state.picker, list);
	const collectible = asset?.type === 'collectible';
	const units = collectible ? '1' : state.units;
	const canCreate = !!asset && !!units && !isZero(units) && !busy;

	const created = state.created;
	const row = created ? (rows || []).find((r) => r.id === created.rowId) || created.row : null;
	const createdFor = created ? fmtAsset(created.amount, created.asset) : '';
	const done = row?.state === 'complete';
	const where = row?.courier || host;

	const create = async () => {
		setBusy(true);
		setError(null);
		try {
			const answer = await assets.createAddress({ key: asset.key, amount: units });
			patch({
				created: {
					encoded: answer.address.encoded,
					addressId: answer.address.id,
					rowId: answer.row.id,
					row: answer.row,
					amount: answer.address.amount,
					asset: { key: asset.key, assetId: asset.assetId, groupKey: asset.groupKey, name: asset.name, type: asset.type, decimalDisplay: asset.decimalDisplay }
				}
			});
			bump();
		} catch (e) {
			setError(sentence(e.message || 'The address could not be made'));
		} finally {
			setBusy(false);
		}
	};

	const retry = async (target) => {
		setRetrying(true);
		try {
			await onRetryProof(target);
		} finally {
			setRetrying(false);
		}
	};

	const [checking, setChecking] = useState(null);
	const check = onCheckAddress
		? async (target) => {
				setChecking(target.id);
				try {
					await onCheckAddress(target);
				} finally {
					setChecking(null);
				}
			}
		: null;

	const receives = (rows || []).filter((r) => r.kind === 'receive' || r.kind === 'ln-receive');
	// What each paid invoice asked for: its row says what arrived, and the
	// two can differ by up to a unit for each part a payment arrived in.
	// Asked for again when another one is paid.
	const paidInvoices = lightning ? receives.filter((r) => r.kind === 'ln-receive' && r.state === 'complete').length : 0;
	const { data: invoiceList } = usePoll(() => (paidInvoices > 0 ? assets.invoices().catch(() => null) : Promise.resolve(null)), 0, [assets, paidInvoices]);
	const shortOf = (r) =>
		r && r.kind === 'ln-receive' && r.state === 'complete' && r.paymentHash
			? invoiceShortfall((invoiceList?.invoices || []).find((i) => i.paymentHash === r.paymentHash) || null, r.assets?.[0])
			: null;
	const waits = proofServerWait(proofServer, 'receive');
	const open = detail.open ? receives.find((r) => r.id === detail.open.id) : null;

	return (
		<div data-testid="asset-receive">
			<Card className="asset-pick-card">
				<AssetPicker
					label="Asset to receive"
					assets={list}
					value={state.picker}
					onChange={(picker) => patch({ picker })}
					allowOther
					lookup={(id) => assets.lookup(id)}
					host={host}
				/>
			</Card>

			<div className="card-flow asset-flow">
				<Card
					title="On-chain address"
					help="A Taproot Assets address is made for one asset and one amount. The sender pays exactly that; to receive a different amount, make another address."
				>
					{waits && (
						<div className="info-note" role="status" data-testid="asset-receive-waits">
							{waits}
						</div>
					)}
					{!asset ? (
						<Empty>Choose the asset above first.</Empty>
					) : (
						<>
							{collectible ? (
								<div className="field">
									<span className="field-label">Amount to receive</span>
									<div className="static-value">1 (collectible)</div>
								</div>
							) : (
								<AssetAmountField
									label="Amount to receive"
									asset={asset}
									value={state.text}
									onChange={(text, next) => patch({ text, units: next })}
									testId="asset-receive-amount"
									hint={
										decimalsOf(asset) > 0
											? `Up to ${decimalsOf(asset)} decimal places. The smallest amount is ${smallestAmount(decimalsOf(asset))}.`
											: 'Whole units only: this asset has no decimal places.'
									}
								/>
							)}
							{error && (
								<div className="error-note" role="alert">
									{error}
								</div>
							)}
							<Button
								variant={created && !done ? 'ghost' : 'primary'}
								busy={busy}
								disabled={!canCreate}
								data-testid="asset-address-create"
								onClick={create}
							>
								{created && !done ? 'Replace with a new address' : 'Create address'}
							</Button>
						</>
					)}

					<AnimatePresence mode="wait">
						{created && !done && (
							<m.div
								key={created.encoded}
								className="asset-address-block"
								initial={{ opacity: 0, scale: 0.94, y: 8 }}
								animate={{ opacity: 1, scale: 1, y: 0 }}
								exit={{ opacity: 0, scale: 0.96 }}
							>
								<div className="asset-qr" data-testid="asset-receive-qr">
									<QR value={created.encoded} size={232} caps fluid title={`Taproot Assets address for ${createdFor}`} />
								</div>
								<TapAddress address={created.encoded} what={createdFor} host={where} />
							</m.div>
						)}
						{created && done && (
							<m.div
								key={`done-${created.encoded}`}
								className="paid-receipt"
								role="status"
								data-testid="asset-received"
								initial={{ opacity: 0, scale: 0.9 }}
								animate={{ opacity: 1, scale: 1 }}
							>
								<div className="paid-check" aria-hidden="true">
									✓
								</div>
								<div className="paid-title">Received</div>
								<div className="wallet-meta">
									{createdFor} received on-chain. About 1,000 sats came with it and stay locked with the asset.
								</div>
								<div className="center-actions" style={{ justifyContent: 'center', marginTop: 12 }}>
									<Button data-testid="asset-receive-again" onClick={() => patch({ created: null, text: '', units: null })}>
										Create another address
									</Button>
								</div>
							</m.div>
						)}
					</AnimatePresence>
				</Card>

				{created && row && (
					<Card title="Status">
						<div data-testid="asset-receive-status" data-state={row.state}>
							<RowTimeline row={row} network={network} host={where} />
						</div>
						<ProofLateNote row={row} host={where} onRetry={() => retry(row)} busy={retrying} />
						<WatchNote row={row} onCheck={check && (() => check(row))} busy={checking === row.id} />
						{!done && !unwatched(row) && (
							<div className="field-hint" style={{ marginTop: 12 }}>
								You can leave this page. The wallet keeps watching, and the asset appears under Holdings when it is
								ready.
							</div>
						)}
					</Card>
				)}

				{/* The Lightning invoice, beside the on-chain address, for a wallet
				    with asset channels (the `lightning` prop). It takes the same
				    picked asset and amount. */}
				{lightning && <InvoiceCard api={api} asset={asset} units={units} state={state} patch={patch} rows={rows} bump={bump} held={lightningHeld} />}

				<Card title="Recent receives" className="grid-full">
					{receives.length === 0 ? (
						<Empty>No asset receives yet.</Empty>
					) : (
						<div className="table-wrap">
							<table className="asset-table" data-testid="asset-receives">
								<thead>
									<tr>
										<th>Asset</th>
										<th>Rail</th>
										<th>Status</th>
										<th>When</th>
									</tr>
								</thead>
								<tbody>
									{receives.slice(0, 12).map((r) => (
										<tr
											key={r.id}
											className="row-clickable"
											tabIndex={0}
											data-testid="asset-receive-row"
											data-state={r.state}
											onClick={(e) => detail.show(r, e)}
											onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), detail.show(r))}
										>
											<td>
												<RowAssets row={r} />
												{shortOf(r) && (
													<div className="wallet-meta asset-receive-short" data-testid="asset-receive-short">
														{shortOf(r).text}
													</div>
												)}
											</td>
											<td>
												<Badge tone={railOf(r) === 'lightning' ? 'blue' : 'muted'}>{railOf(r)}</Badge>
											</td>
											<td>
												<RowStatus row={r} network={network} />
											</td>
											<td>{fmtDate(r.at?.created)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
					{/* A proof can also arrive by hand: see ProofFiles in shared.jsx. */}
					<div className="field-hint note-with-action asset-handover" data-testid="asset-proof-handover">
						<span>
							A sender can give you the proof file of a payment to this wallet. Import it here: the wallet verifies it
							before it takes anything from it, and no proof server is needed.
						</span>
						<div className="note-actions">
							<ImportProofFile />
						</div>
					</div>
				</Card>
			</div>

			{open && (
				<AssetTransferDetail row={open} network={network} host={open.courier || host} origin={detail.open.origin} onClose={detail.close}>
					{shortOf(open) && (
						<div className="info-note" role="status" data-testid="asset-invoice-short">
							The invoice {shortOf(open).text}. A payer&apos;s price can leave a payment up to a unit short of what an
							invoice names for each part it arrives in, and the invoice is paid all the same.
						</div>
					)}
					<ProofLateNote row={open} host={open.courier || host} onRetry={() => retry(open)} busy={retrying} />
					<WatchNote row={open} onCheck={check && (() => check(open))} busy={checking === open.id} />
				</AssetTransferDetail>
			)}
		</div>
	);
}
