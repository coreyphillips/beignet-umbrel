import { useRef, useState } from 'react';
import AssetAmountField from '../../../components/AssetAmountField.jsx';
import AssetAvatar from '../../../components/AssetAvatar.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { Button, Card, FeeField, Help, Segmented } from '../../../components/ui.jsx';
import { useAssetQuote, useAssetsApi } from '../../../hooks/useAssets.js';
import { fmtAsset, fmtUnits, isZero, parseAmountInput, readsAsBitcoin, smallestAmount, unitOf } from '../../../lib/asset-amount.js';
import { onHandShortage, sentence, submitOnce } from '../../../lib/assets.js';
import { idempotencyKey } from '../../../lib/assets-api.js';
import { FEE_CAP_MULTIPLE } from '../../../lib/fees.js';
import { fmtSats } from '../../../lib/format.js';
import { FeePresets, NoBumpNote, ProofLateNote, RowTimeline } from './shared.jsx';

/** One asset being described, as the form holds it. */
export const EMPTY_SEEDLING = {
	target: 'new', // 'new', or the group key of an asset to mint more of
	kind: 'normal',
	name: '',
	decimals: 0,
	text: '',
	units: null,
	reissuable: false,
	metaType: 'text',
	meta: ''
};

/** The Create view as it starts, and as a finished mint leaves it. */
export const EMPTY_CREATE = { form: EMPTY_SEEDLING, batch: [], feeRate: '', minted: null, restored: 0 };

const NAME_BYTES = 64;
const bytesOf = (text) => new TextEncoder().encode(String(text || '')).length;

/** The asset a form is adding to, when it is minting more of one. */
export function reissueTarget(form, holdings) {
	if (!form || form.target === 'new') return null;
	return (holdings || []).find((a) => a.groupKey === form.target && a.canReissue) || null;
}

/** A form as the asset it describes: what a preview, a batch row and the request are all read from. */
export function describeSeedling(form, holdings) {
	const parent = reissueTarget(form, holdings);
	const type = parent ? parent.type : form.kind;
	const collectible = type === 'collectible';
	return {
		name: parent ? parent.name : String(form.name || '').trim(),
		type,
		decimalDisplay: collectible ? null : parent ? parent.decimalDisplay ?? 0 : form.decimals,
		amount: collectible ? '1' : form.units,
		reissue: !!parent,
		groupKey: parent ? parent.groupKey : null,
		reissuable: parent ? true : !collectible && !!form.reissuable,
		meta: String(form.meta || '').trim() ? { type: form.metaType === 'json' ? 'json' : 'text', data: form.meta } : null
	};
}

/**
 * What is wrong with a form, said the way the page says it.
 *
 * Returns { name, amount, meta, info, ok }: a refusal for each field (null
 * when it is fine), and `info` for the one thing worth knowing that is not a
 * mistake, a name this wallet already holds.
 */
export function checkSeedling(form, { batch = [], holdings = [] } = {}) {
	const seed = describeSeedling(form, holdings);
	const out = { name: null, amount: null, meta: null, info: null, ok: false };
	if (!seed.reissue) {
		if (!seed.name) out.name = 'Give the asset a name.';
		else if (bytesOf(seed.name) > NAME_BYTES) out.name = `Names can be up to ${NAME_BYTES} bytes.`;
		else if (readsAsBitcoin(seed.name)) out.name = 'An asset cannot be called sats or BTC here, because its amounts would read as bitcoin.';
		else if (batch.some((b) => describeSeedling(b, holdings).name === seed.name)) {
			out.name = `This transaction already has an asset called ${seed.name}.`;
		} else if (holdings.some((a) => a.name === seed.name)) {
			out.info = `You already hold an asset called ${seed.name}. This would be a different asset with the same name.`;
		}
	} else if (batch.some((b) => b.target === form.target)) {
		out.name = `This transaction already mints more ${seed.name}.`;
	}
	if (seed.type !== 'collectible' && (!seed.amount || isZero(seed.amount))) out.amount = 'Say how many to create.';
	if (seed.meta && seed.meta.type === 'json') {
		try {
			JSON.parse(seed.meta.data);
		} catch (e) {
			out.meta = `This is not valid JSON: ${String(e.message || 'it could not be read').replace(/[.\s]+$/, '')}.`;
		}
	}
	out.ok = !out.name && !out.amount && !out.meta;
	return out;
}

/** Whether anything has been typed into a form yet. */
export function isBlank(form) {
	return form.target === 'new' && !String(form.name || '').trim() && !form.text && !String(form.meta || '').trim();
}

/** A form as the wallet's mint route wants it. */
function toRequest(form, holdings) {
	const seed = describeSeedling(form, holdings);
	return {
		name: seed.name,
		type: seed.type,
		amount: seed.amount,
		decimalDisplay: seed.decimalDisplay,
		meta: seed.meta,
		group: seed.reissue ? { mode: 'existing', groupKey: seed.groupKey } : { mode: seed.reissuable ? 'new' : 'none' }
	};
}

/** When a new asset can be used, by network: [the count, how long that is]. */
function readyText(network, need) {
	if (need <= 1) return ['after 1 confirmation', network === 'regtest' ? 'the next block you mine' : null];
	if (network === 'testnet') return [`after ${need} confirmations`, 'on testnet that can take much longer than an hour'];
	return [`after ${need} confirmations`, 'about an hour'];
}

function Preview({ seed }) {
	const named = seed.name || 'Your asset';
	const collectible = seed.type === 'collectible';
	const amount = seed.amount && !isZero(seed.amount) ? seed.amount : null;
	return (
		<div className="asset-preview" data-testid="mint-preview">
			<div className="asset-preview-head">
				<AssetAvatar asset={collectible ? { type: 'collectible' } : null} size="lg" />
				<div>
					<div className="asset-name">{named}</div>
					<div className="asset-preview-amount">
						{collectible ? 'One of a kind' : amount ? fmtAsset(amount, seed) : `0 ${unitOf(seed)}`}
					</div>
				</div>
			</div>
			<table className="kv">
				<tbody>
					{!collectible && (
						<>
							<tr>
								<td>Smallest amount</td>
								<td>
									{smallestAmount(seed.decimalDisplay)} {seed.name ? unitOf(seed) : 'unit'}
								</td>
							</tr>
							<tr>
								<td>On the network</td>
								<td>{amount ? `${fmtUnits(amount, 0)} unit${amount === '1' ? '' : 's'}` : '-'}</td>
							</tr>
						</>
					)}
					<tr>
						<td>Supply</td>
						<td>{seed.reissue ? `added to ${seed.name}` : seed.reissuable ? 'more can be minted later' : 'fixed'}</td>
					</tr>
				</tbody>
			</table>
			<div className="field-hint">
				Its pattern is drawn from the asset ID, which exists once the transaction is built.
			</div>
		</div>
	);
}

/**
 * Creating an asset.
 *
 * The form on the left describes one asset; the column on the right shows
 * what that description comes to, what else is in the transaction, what the
 * transaction costs, and the button. Several assets can share one
 * transaction: "Add another" sets the described one aside and clears the form
 * for the next.
 *
 * What is being described lives with the tab and is mirrored to this
 * browser tab's storage, so a half-described asset survives a reload. Nothing
 * is sent to the wallet until the button is pressed, and then it is one
 * request: the wallet builds, funds and broadcasts the transaction, and
 * answers with a row whose progress is shown here and under Holdings.
 */
export default function CreateView({ api, state, patch, holdings, rows, status, network, fees, bump, setView, onDiscard, onRetryProof }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const [touched, setTouched] = useState(false);
	const [busy, setBusy] = useState(false);
	const [failure, setFailure] = useState(null);
	// One press, one mint: a second press that lands before the page has drawn
	// the first as busy would be a second request under a second key, and the
	// wallet would be right to mint it.
	const minting = useRef(false);

	const list = holdings || [];
	const { form, batch, feeRate } = state;
	const setForm = (changes) => patch({ form: { ...form, ...changes } });
	const reissuable = list.filter((a) => a.canReissue && a.groupKey);
	const parent = reissueTarget(form, list);
	const seed = describeSeedling(form, list);
	const collectible = seed.type === 'collectible';
	const check = checkSeedling(form, { batch, holdings: list });
	const blank = isBlank(form);

	// What the button would mint: everything set aside, and the form if it
	// holds anything.
	const pending = blank && batch.length > 0 ? batch : [...batch, form];
	const count = pending.length;
	const formCounts = !(blank && batch.length > 0);
	const allGood = !formCounts || check.ok;

	const limits = status?.limits;
	const rate = parseInt(feeRate, 10) || fees?.fast || null;
	const feeCeiling = Math.min(Math.max(10, (fees?.fast || 10) * FEE_CAP_MULTIPLE), limits?.maxFeeRate || Infinity);
	const { quote, error: quoteError, pending: quoting } = useAssetQuote((p) => assets.mintQuote(p), { count, feeRate: rate }, !!rate);
	const short = quote && !quote.sufficient;
	const need = status?.chain?.minConfirmations || (network === 'regtest' ? 1 : 6);
	// The button stays live while the form is merely unfinished: pressing it
	// says what is missing, which a greyed button cannot.
	const priced = !!quote && !short && !quoting;
	const canSubmit = allGood && priced && !busy;

	const addAnother = () => {
		setTouched(true);
		if (!check.ok) return;
		patch({ batch: [...batch, form], form: EMPTY_SEEDLING });
		setTouched(false);
	};

	const submit = async () => {
		setTouched(true);
		if (!canSubmit || minting.current) return;
		minting.current = true;
		setBusy(true);
		setFailure(null);
		const key = idempotencyKey();
		try {
			const answer = await submitOnce(
				(k) => assets.mint({ seedlings: pending.map((f) => toRequest(f, list)), feeRate: rate, maxFeeSats: quote.feeSats }, k),
				key,
				async (k) => (await assets.activity({ limit: 20, kind: 'mint' })).rows.find((r) => r.clientRef === k) || null
			);
			toast(count === 1 ? `${describeSeedling(pending[0], list).name} is being created` : `${count} assets are being created`, 'success');
			patch({ form: EMPTY_SEEDLING, batch: [], minted: { rowId: answer.row.id, row: answer.row }, restored: 0 });
			setTouched(false);
			bump();
		} catch (e) {
			if (e.unknown) {
				setFailure('No answer came back from the wallet, so it is not known whether this was minted. Look under Holdings, In progress, before trying again.');
			} else if (e.code === 'FEE_TOO_HIGH') {
				setFailure('The fee moved above the figure shown while this was being sent, so nothing was minted. The cost below is current: press the button again to accept it.');
			} else if (e.code === 'INSUFFICIENT_BTC' && e.details) {
				setFailure(
					onHandShortage(e.details, 'Minting') ||
						`This needs ${fmtSats(e.details.needed)} on-chain and the wallet has ${fmtSats(e.details.spendable).replace(/ sats$/, '')}. Deposit bitcoin on the Receive tab first.`
				);
			} else {
				setFailure(sentence(e.message || 'The asset could not be created'));
			}
		} finally {
			minting.current = false;
			setBusy(false);
		}
	};

	const mintedRow = state.minted ? (rows || []).find((r) => r.id === state.minted.rowId) || state.minted.row || null : null;
	if (mintedRow) {
		const names = (mintedRow.assets || []).map((a) => a.name);
		return (
			<div className="card-flow asset-flow" data-testid="asset-create">
				<Card title={mintedRow.state === 'complete' ? 'Created' : 'Creating'}>
					<div className="mint-done-head">
						<div className="mint-done-faces">
							{(mintedRow.assets || []).slice(0, 4).map((a) => (
								<AssetAvatar key={a.assetId || a.name} asset={a} size={names.length > 2 ? 'md' : 'lg'} ready={mintedRow.state === 'complete'} />
							))}
						</div>
						<div>
							<div className="asset-name">{names.length === 1 ? names[0] : `${names.length} assets`}</div>
							{names.length === 1 && mintedRow.assets[0].type !== 'collectible' && (
								<div className="asset-preview-amount">{fmtAsset(mintedRow.assets[0].amount, mintedRow.assets[0])}</div>
							)}
							{names.length > 1 && <div className="wallet-meta">{names.join(', ')}</div>}
						</div>
					</div>
					<div data-testid="mint-timeline" data-state={mintedRow.state}>
						<RowTimeline row={mintedRow} network={network} />
					</div>
					<ProofLateNote
						row={mintedRow}
						host={status?.proofServer?.host}
						onRetry={onRetryProof ? () => onRetryProof(mintedRow) : undefined}
					/>
					{mintedRow.state !== 'complete' && !mintedRow.failed && (
						<div className="field-hint" style={{ marginTop: 12 }}>
							Broadcast. You can leave this page: minting carries on in the wallet, and this progress is under Holdings
							whenever you come back.
						</div>
					)}
					{mintedRow.failed && (
						<div className="error-note" role="alert">
							{sentence(mintedRow.failure?.message || 'The mint stopped before it finished')}
						</div>
					)}
					<div className="center-actions">
						<Button variant="primary" data-testid="mint-view-holdings" onClick={() => setView('holdings')}>
							View holdings
						</Button>
						<Button data-testid="mint-again" onClick={() => patch({ minted: null })}>
							Create another
						</Button>
					</div>
				</Card>
			</div>
		);
	}

	const submitLabel = count > 1 ? `Create ${count} assets` : `Create ${describeSeedling(pending[0], list).name || 'asset'}`;

	return (
		<div data-testid="asset-create">
			{state.restored > 0 && (
				<div className="info-note note-with-action" role="status" data-testid="mint-draft-note">
					<span>
						Picked up where you left off: {state.restored} asset{state.restored === 1 ? '' : 's'} waiting to be minted.
					</span>
					<button type="button" className="btn sm" data-testid="mint-draft-discard" onClick={onDiscard}>
						Discard
					</button>
				</div>
			)}
			<Card
				title="Create an asset"
				help="Minting writes the asset into one bitcoin transaction. It costs a miner fee, and about 1,000 sats stay locked in the output that holds the asset."
			>
				<div className="mint-layout">
					<div className="mint-fields">
						{reissuable.length > 0 && (
							<label className="field">
								<span className="field-label">What to create</span>
								<select
									value={form.target}
									data-testid="mint-target"
									onChange={(e) => setForm({ target: e.target.value, text: '', units: null })}
								>
									<option value="new">A new asset</option>
									{reissuable.map((a) => (
										<option key={a.groupKey} value={a.groupKey}>
											More of {a.name}
										</option>
									))}
								</select>
							</label>
						)}

						{parent ? (
							<>
								<div className="field">
									<span className="field-label">Name</span>
									<div className="static-value">{parent.name}</div>
									<span className="field-hint">From the asset you are adding to.</span>
								</div>
								{!collectible && (
									<div className="field">
										<span className="field-label">Decimal places</span>
										<div className="static-value">{seed.decimalDisplay}</div>
										<span className="field-hint">From the asset you are adding to.</span>
									</div>
								)}
							</>
						) : (
							<>
								<div className="field">
									<span className="field-label">Kind</span>
									<Segmented
										id="asset-kind"
										options={[
											['normal', 'Asset'],
											['collectible', 'Collectible']
										]}
										value={form.kind}
										onChange={(kind) => setForm({ kind })}
									/>
									<span className="field-hint" data-testid="mint-kind-hint">
										{collectible
											? 'One of a kind. There is exactly one and it cannot be divided.'
											: 'Many identical units, like a currency or points.'}
									</span>
								</div>

								<label className="field">
									<span className="field-label">Name</span>
									<input
										value={form.name}
										placeholder="BUSD"
										autoComplete="off"
										spellCheck={false}
										data-testid="mint-name"
										onChange={(e) => setForm({ name: e.target.value })}
										onBlur={() => setTouched(true)}
									/>
									{check.name && (touched || form.name) ? (
										<span className="field-hint refusal" role="alert" data-testid="mint-name-refusal">
											{check.name}
										</span>
									) : (
										<span className="field-hint">Shown beside every amount, so short reads best.</span>
									)}
								</label>
								{check.info && (
									<div className="info-note" role="status" data-testid="mint-name-info">
										{check.info}
									</div>
								)}

								{!collectible && (
									<label className="field">
										<span className="field-label">
											Decimal places
											<Help>
												Assets are counted in whole units on the network. Decimal places only change how amounts are
												shown: with 2, an amount of 100000 units displays as 1,000.00. This cannot be changed after
												minting.
											</Help>
										</span>
										<select
											value={form.decimals}
											data-testid="mint-decimals"
											onChange={(e) => {
												const decimals = parseInt(e.target.value, 10) || 0;
												// The figure typed stays the figure meant: 1000 is still 1,000 of them.
												const again = parseAmountInput(form.text, decimals);
												setForm(again.error ? { decimals, text: '', units: null } : { decimals, text: again.text, units: again.units });
											}}
										>
											{[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
												<option key={n} value={n}>
													{n}
												</option>
											))}
										</select>
									</label>
								)}
							</>
						)}

						{collectible ? (
							<div className="field">
								<span className="field-label">How many to create</span>
								<div className="static-value">1 (collectible)</div>
							</div>
						) : (
							<AssetAmountField
								label="How many to create"
								asset={seed}
								value={form.text}
								onChange={(text, units) => setForm({ text, units })}
								showUnits
								testId="mint-amount"
								refusal={touched && check.amount ? check.amount : undefined}
							/>
						)}

						{!parent && !collectible && (
							<>
								<label className="checkbox field">
									<input
										type="checkbox"
										checked={!!form.reissuable}
										data-testid="mint-reissuable"
										onChange={(e) => setForm({ reissuable: e.target.checked })}
									/>
									Allow minting more later
									<Help>
										Creates a group key for this asset. With it you can mint more units later and they count as the same
										asset. Without it the supply is fixed for good.
									</Help>
								</label>
								{!form.reissuable && <div className="field-note">Fixed supply: no more can ever be created.</div>}
							</>
						)}

						<details className="field asset-details" open={!!form.meta || undefined}>
							<summary>Description and metadata</summary>
							<div className="field" style={{ marginTop: 10 }}>
								<Segmented
									id="asset-meta"
									options={[
										['text', 'Text'],
										['json', 'JSON']
									]}
									value={form.metaType}
									onChange={(metaType) => setForm({ metaType })}
								/>
							</div>
							<label className="field">
								<span className="visually-hidden">Metadata</span>
								<textarea
									rows={4}
									className={form.metaType === 'json' ? 'mono' : undefined}
									value={form.meta}
									spellCheck={form.metaType !== 'json'}
									placeholder={form.metaType === 'json' ? '{ "issuer": "…" }' : 'What this asset is, in a sentence or two.'}
									data-testid="mint-meta"
									onChange={(e) => setForm({ meta: e.target.value })}
								/>
								<span className="field-hint">
									{bytesOf(form.meta).toLocaleString('en-US')} bytes · Published with the asset and public for good. Put
									nothing private here.
								</span>
								{check.meta && (
									<span className="field-hint refusal" role="alert" data-testid="mint-meta-refusal">
										{check.meta}
									</span>
								)}
							</label>
						</details>

						<FeeField label="Fee rate (sat/vB)" value={feeRate} onChange={(v) => patch({ feeRate: v })} rate={rate} max={feeCeiling} />
						<FeePresets fees={fees} onPick={(v) => patch({ feeRate: v })} max={feeCeiling} />
						<NoBumpNote what="mint" />
					</div>

					<div className="mint-side">
						<Preview seed={seed} />

						<div className="mint-batch" data-testid="mint-batch">
							{batch.length > 0 && (
								<>
									<div className="stat-label">This transaction</div>
									<ul className="mint-batch-list">
										{batch.map((b, i) => {
											const s = describeSeedling(b, list);
											return (
												<li key={`${s.name}-${i}`} data-testid="mint-batch-item">
													<AssetAvatar asset={s.type === 'collectible' ? { type: 'collectible' } : null} size="xs" />
													<span className="mint-batch-name">{s.type === 'collectible' ? s.name : fmtAsset(s.amount, s)}</span>
													<button
														type="button"
														className="btn sm"
														aria-label={`Remove ${s.name}`}
														onClick={() => patch({ batch: batch.filter((_, j) => j !== i) })}
													>
														Remove
													</button>
												</li>
											);
										})}
									</ul>
								</>
							)}
							<Button className="sm" data-testid="mint-add-another" disabled={blank} onClick={addAnother}>
								Add another asset to this transaction
							</Button>
							<div className="field-hint">Several assets can share one transaction and one miner fee.</div>
						</div>

						<div aria-live="polite">
							{quote ? (
								<table className="kv mint-cost" data-testid="mint-cost">
									<tbody>
										<tr>
											<td>Miner fee</td>
											<td>
												{fmtSats(quote.feeSats)}
												<span className="kv-sub">
													at {rate} sat/vB over {quote.vsize} vB
												</span>
											</td>
										</tr>
										<tr>
											<td>
												Locked with the asset
												<Help>
													Every asset sits in a bitcoin output. These sats stay with it and show as locked with assets on
													the Overview.
												</Help>
											</td>
											<td>{fmtSats(quote.anchorSats)}</td>
										</tr>
										<tr>
											<td>Total in bitcoin</td>
											<td>
												<strong>{fmtSats(quote.totalSats)}</strong>
											</td>
										</tr>
										<tr>
											<td>On-chain available</td>
											<td>{fmtSats(quote.spendableSats)}</td>
										</tr>
										<tr>
											<td>Ready</td>
											<td>
												{readyText(network, need)[0]}
												{readyText(network, need)[1] && <span className="kv-sub">{readyText(network, need)[1]}</span>}
											</td>
										</tr>
									</tbody>
								</table>
							) : (
								<div className="wallet-meta" data-testid="mint-cost-pending">
									{quoteError ? sentence(quoteError.message || 'The wallet could not price this') : 'Working out the cost…'}
								</div>
							)}
							{quote && <div className="field-hint">This is what the transaction pays, not an estimate of it.</div>}
						</div>
						{short && (
							<div className="error-note" role="alert" data-testid="mint-refusal" data-code="INSUFFICIENT_SATS">
								{onHandShortage({ needed: quote.totalSats, onHandSats: quote.onHandSats, spendable: quote.spendableSats }, 'Minting') ??
									(Number(quote.spendableSats) >= Number(quote.totalSats) ? (
										<>
											The wallet has {fmtSats(quote.spendableSats)} on-chain and could not fund this transaction with it
											just now. Try again in a moment.
										</>
									) : (
										<>
											This needs {fmtSats(quote.totalSats)} on-chain and the wallet has{' '}
											{Number(quote.spendableSats).toLocaleString('en-US')}. Deposit bitcoin on the Receive tab first.
										</>
									))}
							</div>
						)}
						{failure && (
							<div className="error-note" role="alert" data-testid="mint-failure">
								{failure}
							</div>
						)}
						<Button variant="primary" busy={busy} disabled={!priced} data-testid="mint-submit" onClick={submit}>
							{submitLabel}
						</Button>
					</div>
				</div>
			</Card>
		</div>
	);
}
