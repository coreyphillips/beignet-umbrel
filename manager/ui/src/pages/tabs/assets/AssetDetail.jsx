import { useContext, useState } from 'react';
import AssetAvatar from '../../../components/AssetAvatar.jsx';
import { AnimatedAssetAmount, AssetAmount } from '../../../components/AssetAmount.jsx';
import { Badge, Button, Card, CopyText, DetailRow, Empty, ErrorNote, ExplorerLink, Skeleton } from '../../../components/ui.jsx';
import { useAssetDetail } from '../../../hooks/useAssets.js';
import { decimalsOf, fmtUnits, isZero, toUnits } from '../../../lib/asset-amount.js';
import { describeSupply, describeType, fullName } from '../../../lib/assets.js';
import { kindWord, proofUnpublished } from '../../../lib/asset-progress.js';
import { txUrl } from '../../../lib/explorer.js';
import { fmtDate, fmtSats, shortId } from '../../../lib/format.js';
import BurnModal from './BurnModal.jsx';
import { AssetTransferDetail, ExplorerNetwork, ProofLateNote, RowAssets, RowStatus, plainClick, useRowDetail } from './shared.jsx';

/** Where the units are: on-chain, in channels on this side, in channels on the far side. */
function WhereItIs({ asset, lightning }) {
	const d = decimalsOf(asset);
	const b = asset.balance;
	const onchain = toUnits(b.onchain) ?? 0n;
	const local = toUnits(b.channelLocal) ?? 0n;
	const inbound = toUnits(b.lightningReceivable) ?? 0n;
	const hasChannels = lightning && (local > 0n || inbound > 0n);
	const whole = onchain + local + inbound;
	// Widths are for the eye only, so a float is fine here: the figures beside
	// the bar are the exact ones.
	const share = (v) => (whole > 0n ? `${Number((v * 10000n) / whole) / 100}%` : '0%');
	return (
		<Card title="Where it is">
			{hasChannels && (
				<>
					<div className="liq asset-where" role="img" aria-label="How this asset is split between on-chain and Lightning">
						<div className="where-onchain" style={{ width: share(onchain) }} />
						<div className="out" style={{ width: share(local) }} />
						<div className="in" style={{ width: share(inbound) }} />
					</div>
					<div className="where-legend">
						<span>
							<i className="swatch onchain" aria-hidden="true" /> on-chain
						</span>
						<span>
							<i className="swatch out" aria-hidden="true" /> yours in channels
						</span>
						<span>
							<i className="swatch in" aria-hidden="true" /> room to receive
						</span>
					</div>
				</>
			)}
			<div className="where-stats">
				<div className="where-stat">
					<span className="stat-label">On-chain</span>
					<AssetAmount value={b.onchain} asset={asset} />
				</div>
				{lightning && (
					<>
						<div className="where-stat">
							<span className="stat-label">Can send over Lightning</span>
							<AssetAmount value={b.lightningSendable} asset={asset} />
						</div>
						<div className="where-stat">
							<span className="stat-label">Can receive over Lightning</span>
							<AssetAmount value={b.lightningReceivable} asset={asset} />
						</div>
					</>
				)}
			</div>
			<div className="wallet-meta" data-testid="asset-locked">
				{fmtSats(asset.lockedSats)} {asset.lockedSats === 1 ? 'is' : 'are'} locked with this asset, in {asset.anchors} output
				{asset.anchors === 1 ? '' : 's'}.
				{!isZero(b.pendingIn) && ` ${fmtUnits(b.pendingIn, d)} more is arriving.`}
				{!isZero(b.pendingOut) && ` ${fmtUnits(b.pendingOut, d)} is on its way out.`}
			</div>
		</Card>
	);
}

function Metadata({ meta }) {
	if (!meta || !meta.text) return <span className="faint">No metadata</span>;
	if (meta.type === 'json') {
		let pretty = meta.text;
		try {
			pretty = JSON.stringify(JSON.parse(meta.text), null, 2);
		} catch (_) {
			/* shown as it was published */
		}
		return <pre className="static-value asset-meta">{pretty}</pre>;
	}
	if (meta.type === 'opaque') return <span className="faint">{meta.bytes} bytes that are not text</span>;
	return <div className="static-value asset-meta">{meta.text}</div>;
}

function provenance(asset) {
	if (asset.mintedHere) return 'Minted in this wallet';
	const depth = asset.proofs?.depth;
	const block = asset.genesis?.height ? ` in block ${Number(asset.genesis.height).toLocaleString('en-US')}` : '';
	const hops = depth > 0 ? `, through ${depth} transfer${depth === 1 ? '' : 's'}` : '';
	return `Received; proof checked back to its first transaction${block}${hops}`;
}

/**
 * One asset: what it is, how much of it there is and where, and everything
 * that has happened to it here.
 *
 * Reached from Holdings and addressed by ?asset=<key>, so it can be linked to
 * and survives a reload. An asset this wallet does not hold says so and
 * offers the way back, instead of an empty page.
 */
export default function AssetDetail({ api, assetKey, tick, rows, network, host, lightning, lightningHeld, fees, back, setView, go, bump, backHref, onRetryProof }) {
	const { asset, missing, error, loading } = useAssetDetail(api, assetKey, tick);
	const explorer = useContext(ExplorerNetwork) || network;
	const [burning, setBurning] = useState(null);
	const detail = useRowDetail();
	const history = (rows || []).filter((r) => (r.assets || []).some((a) => a.key === assetKey || a.assetId === assetKey));
	// Created here, and its proof not on the proof server yet.
	const unpublished = history.find(proofUnpublished) || null;
	const open = detail.open ? history.find((r) => r.id === detail.open.id) : null;

	const backLink = (
		<a
			className="back-link"
			href={backHref}
			data-testid="asset-back"
			onClick={plainClick((e) => {
				e.preventDefault();
				back();
			})}
		>
			← All assets
		</a>
	);

	if (missing) {
		return (
			<>
				{backLink}
				<div className="card" data-testid="asset-missing">
					<Empty>This wallet does not hold that asset.</Empty>
				</div>
			</>
		);
	}
	if (!asset) {
		return (
			<>
				{backLink}
				{error ? <ErrorNote error={error} /> : null}
				{loading || !error ? (
					<>
						<Skeleton height={132} style={{ marginBottom: 18 }} />
						<Skeleton height={120} />
					</>
				) : null}
			</>
		);
	}

	const collectible = asset.type === 'collectible';
	const b = asset.balance;
	const canBurn = !isZero(b.onchain);
	const inChannels = !isZero(b.channelLocal);

	return (
		<div data-testid="asset-detail" data-key={asset.key}>
			{backLink}
			<div className="asset-head whead">
				<AssetAvatar asset={asset} size="xl" />
				<div className="asset-head-main">
					<div className="wallet-title">
						<h2>{fullName(asset)}</h2>
						{collectible && <Badge tone="blue">collectible</Badge>}
						{asset.groupKey && <Badge tone="muted">can be re-issued</Badge>}
						{asset.mintedHere && <Badge tone="muted">minted here</Badge>}
						{lightning && !isZero(b.lightningSendable) && <Badge tone="green">lightning ready</Badge>}
					</div>
					<div className="asset-head-id">
						<CopyText value={asset.assetId} label={shortId(asset.assetId, 8)} />
					</div>
					{!collectible && (
						<div className="asset-head-balance" data-testid="asset-detail-balance">
							<AnimatedAssetAmount value={b.total} asset={asset} />
						</div>
					)}
					{!collectible && inChannels && (
						<div className="wallet-meta">
							{fmtUnits(b.onchain, decimalsOf(asset))} on-chain · {fmtUnits(b.channelLocal, decimalsOf(asset))} in channels
						</div>
					)}
					<div className="field-hint">
						The asset ID is its identity. Another asset can carry the same name; its pattern would look different.
					</div>
					<div className="center-actions">
						<Button variant="primary" data-testid="asset-action-send" onClick={() => setView('send')}>
							Send
						</Button>
						<Button data-testid="asset-action-receive" onClick={() => setView('receive', { key: asset.key })}>
							Receive
						</Button>
						{asset.canReissue && (
							<Button data-testid="asset-action-mint-more" onClick={() => setView('create', { reissue: asset.groupKey })}>
								Mint more
							</Button>
						)}
						{lightning && !collectible && go && (
							<Button
								data-testid="asset-action-open-channel"
								disabled={!!lightningHeld}
								title={lightningHeld ? lightningHeld.text : undefined}
								onClick={() => go('channels', { state: { openAsset: asset.key } })}
							>
								Open channel
							</Button>
						)}
						<Button
							variant="danger"
							disabled={!canBurn}
							title={canBurn ? undefined : 'There is nothing on-chain to burn'}
							data-testid="asset-action-burn"
							onClick={(e) => setBurning({ x: e.clientX, y: e.clientY })}
						>
							Burn
						</Button>
					</div>
				</div>
			</div>

			{!collectible && <WhereItIs asset={asset} lightning={lightning} />}

			<ProofLateNote row={unpublished} host={host} onRetry={onRetryProof ? () => onRetryProof(unpublished) : undefined} />

			<Card title="Identity">
				<div className="detail">
					<DetailRow label="Asset ID">
						<CopyText value={asset.assetId} />
					</DetailRow>
					<DetailRow label="Type">{describeType(asset)}</DetailRow>
					<DetailRow label="Group key">
						{asset.groupKey ? <CopyText value={asset.groupKey} /> : 'none: no more can ever be issued'}
					</DetailRow>
					<DetailRow label="Supply">{describeSupply(asset, asset.issuances)}</DetailRow>
					<DetailRow label="Genesis">
						{asset.genesis?.outpoint ? (
							<>
								<CopyText value={asset.genesis.outpoint} label={shortId(asset.genesis.outpoint, 10)} />
								<ExplorerLink url={txUrl(explorer, asset.genesis.outpoint.split(':')[0])}>View</ExplorerLink>
							</>
						) : (
							'-'
						)}
					</DetailRow>
					<DetailRow label="Created">{fmtDate(asset.genesis?.timestamp)}</DetailRow>
					<DetailRow label="Provenance">{provenance(asset)}</DetailRow>
					<DetailRow label="Metadata">
						<Metadata meta={asset.meta} />
					</DetailRow>
					<DetailRow label="Proofs">{asset.proofs?.count ?? 0} held</DetailRow>
				</div>
			</Card>

			{asset.groupKey && (asset.issuances || []).length > 0 && (
				<Card title="Issuances" help="Each time more of a re-issuable asset is minted, the new units get an asset ID of their own and share the group key. They all count as the same asset.">
					<div className="table-wrap">
						<table>
							<thead>
								<tr>
									<th>Issued</th>
									<th>Amount</th>
									<th>Asset ID</th>
									<th>Held here</th>
								</tr>
							</thead>
							<tbody>
								{asset.issuances.map((i) => (
									<tr key={i.assetId}>
										<td>{fmtDate(i.at)}</td>
										<td>
											<AssetAmount value={i.amount} asset={asset} unit={false} />
										</td>
										<td>
											<CopyText value={i.assetId} label={shortId(i.assetId)} />
										</td>
										<td>{i.heldHere ? 'yes' : 'no'}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</Card>
			)}

			<Card title="History">
				{history.length === 0 ? (
					<Empty>Nothing has happened to this asset here yet.</Empty>
				) : (
					<div className="table-wrap">
						<table className="asset-table" data-testid="asset-history">
							<thead>
								<tr>
									<th>Type</th>
									<th>Amount</th>
									<th>Status</th>
									<th>When</th>
								</tr>
							</thead>
							<tbody>
								{history.map((row) => (
									<tr
										key={row.id}
										className="row-clickable"
										tabIndex={0}
										data-testid="asset-history-row"
										onClick={(e) => detail.show(row, e)}
										onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), detail.show(row))}
									>
										<td>{kindWord(row)}</td>
										<td>
											<RowAssets row={row} avatar={false} />
										</td>
										<td>
											<RowStatus row={row} network={network} />
										</td>
										<td>{fmtDate(row.at?.created)}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</Card>

			{open && (
				<AssetTransferDetail row={open} network={network} host={host} origin={detail.open.origin} onClose={detail.close}>
					<ProofLateNote row={open} host={host} onRetry={onRetryProof ? () => onRetryProof(open) : undefined} />
				</AssetTransferDetail>
			)}
			{burning && (
				<BurnModal
					api={api}
					asset={asset}
					fees={fees}
					network={network}
					origin={burning}
					onClose={() => setBurning(null)}
					onBurned={() => {
						setBurning(null);
						bump();
					}}
				/>
			)}
		</div>
	);
}
