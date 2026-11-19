import { useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import AssetAvatar from '../../../components/AssetAvatar.jsx';
import { AnimatedAssetAmount } from '../../../components/AssetAmount.jsx';
import { Button, Card, Empty, Stat, StatRow, staggerContainer, staggerItem } from '../../../components/ui.jsx';
import { describeSplit, fullName, isFailed, isPending } from '../../../lib/assets.js';
import { headline, kindWord, noticeOf, proofUnpublished, statusOf } from '../../../lib/asset-progress.js';
import { timeAgo } from '../../../lib/backup.js';
import { shortId } from '../../../lib/format.js';
import { AssetTransferDetail, LimitsList, ProofLateNote, RowNotice, RowTimeline, plainClick, useRowDetail } from './shared.jsx';

// Three faces for the empty state, so the first thing a new wallet shows of
// assets is what one looks like. They are nobody's: the seeds are made up.
const SAMPLE_FACES = [
	{ assetId: '5f1c9a3e7b2d4086a1c5e9f30b7d2a4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f2a41' },
	{ assetId: 'c2a94f6be0d1738529ab4cd6ef01325476a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2', type: 'collectible' },
	{ assetId: '0e7d3b9a5c1f2e4d6b8a0c9e7f5d3b1a2c4e6f8a0b1d3f5a7c9e1b3d5f7a9c0e' }
];

// A failure stays in the list for a day, so it is seen by whoever opens the
// tab next, and then it is history.
const FAILURE_SHOWN_MS = 24 * 60 * 60 * 1000;

/** What belongs under "In progress": everything moving, and what recently stopped. */
export function inProgress(rows, now = Date.now()) {
	return (rows || []).filter((row) => {
		if (isFailed(row)) return now - (row.at?.created || 0) < FAILURE_SHOWN_MS;
		// A payment the wallet has a note on stays in sight while it is not
		// over, and for a day after it is: the note is the news.
		if (noticeOf(row)) return isPending(row) || now - (row.at?.created || 0) < FAILURE_SHOWN_MS;
		// A mint whose proof the proof server has not taken is done, and
		// stays in sight until it has.
		if (proofUnpublished(row)) return true;
		// An address nobody has paid yet is not something happening.
		return isPending(row) && row.state !== 'waiting';
	});
}

/** The first screen of a wallet with no assets: what they are, and the two ways in. */
function EmptyHoldings({ network, host, lightning, setView }) {
	return (
		<div className="card asset-empty" data-testid="assets-empty">
			<div className="asset-empty-faces" aria-hidden="true">
				{SAMPLE_FACES.map((face, i) => (
					<AssetAvatar key={i} asset={face} size={i === 1 ? 'xl' : 'lg'} />
				))}
			</div>
			<h3 className="asset-empty-title">No assets yet</h3>
			<p className="asset-empty-body">
				Taproot Assets are tokens that live on bitcoin: a currency, points, a ticket, a one-of-a-kind collectible.
				Create your own, or receive one someone else issued.
			</p>
			<div className="choice-row">
				<button type="button" className="choice" data-testid="assets-empty-create" onClick={() => setView('create')}>
					<span className="choice-title">Create an asset</span>
					<span className="choice-body">
						Name it, choose how many exist, and mint it in one bitcoin transaction. It costs a miner fee, plus about
						1,000 sats that stay locked with the asset.
					</span>
				</button>
				<button type="button" className="choice" data-testid="assets-empty-receive" onClick={() => setView('receive')}>
					<span className="choice-title">Receive an asset</span>
					<span className="choice-body">
						Make an address for an asset someone is sending you. You need its asset ID.
					</span>
				</button>
			</div>
			<h4 className="asset-empty-sub">Good to know before you start</h4>
			<LimitsList network={network} host={host} lightning={lightning} />
		</div>
	);
}

function ProgressItem({ row, network, host, onDetails, onRetry, retrying }) {
	const failed = isFailed(row);
	return (
		<li className={`progress-item${failed ? ' failed' : ''}`} data-testid="asset-progress-item" data-kind={row.kind} data-state={row.state}>
			<div className="progress-head">
				<AssetAvatar asset={row.assets?.[0]} size="sm" />
				<span className="progress-title">{headline(row, { network })}</span>
				<Button className="sm" onClick={(e) => onDetails(row, e)}>
					Details
				</Button>
			</div>
			{failed ? (
				<div className="error-note" role="alert">
					{row.failure?.message
						? `${String(row.failure.message).replace(/[.\s]+$/, '')}.`
						: 'This stopped before it finished.'}{' '}
					{row.txid ? 'Details has the transaction.' : 'Nothing was spent.'}
				</div>
			) : (
				<RowTimeline row={row} network={network} host={host} compact />
			)}
			<RowNotice row={row} />
			<ProofLateNote row={row} host={host} onRetry={() => onRetry(row)} busy={retrying === row.id} />
		</li>
	);
}

/**
 * What the wallet holds.
 *
 * Four figures across the top, none of them a total: assets have no common
 * unit and this app does not price them, so adding them up would be adding
 * apples to tickets. Then whatever is in progress, then the assets, each a
 * link to its own page, with collectibles as tiles below.
 */
export default function HoldingsView({ id, status, holdings, btc, rows, network, host, lightning, openAsset, setView, onRetryProof }) {
	const detail = useRowDetail();
	const [retrying, setRetrying] = useState(null);
	const list = holdings || [];
	const active = inProgress(rows);
	const fungible = list.filter((a) => a.type !== 'collectible');
	const collectibles = list.filter((a) => a.type === 'collectible');

	if (list.length === 0 && active.length === 0) {
		return <EmptyHoldings network={network} host={host} lightning={lightning} setView={setView} />;
	}

	const retry = async (row) => {
		setRetrying(row.id);
		try {
			await onRetryProof(row);
		} finally {
			setRetrying(null);
		}
	};
	const moving = active.filter((r) => !isFailed(r) && !proofUnpublished(r));
	const backup = status?.backup;
	const backedUp = backup?.exportedAt && !backup.dirty ? timeAgo(backup.exportedAt) : null;
	const open = detail.open ? (rows || []).find((r) => r.id === detail.open.id) : null;
	const href = (a) => `/w/${id}/assets?asset=${a.key}`;

	return (
		<>
			<StatRow stagger style={{ marginBottom: 18 }}>
				<Stat
					key="held"
					label="Assets held"
					num={list.length}
					sub={collectibles.length > 0 ? `${collectibles.length} collectible${collectibles.length === 1 ? '' : 's'}` : 'none collectible'}
				/>
				<Stat
					key="progress"
					label="In progress"
					num={moving.length}
					sub={
						moving.length === 0
							? 'nothing waiting'
							: moving.length === 1
							? `${kindWord(moving[0]).toLowerCase()} · ${statusOf(moving[0], { network }).text}`
							: `newest: ${kindWord(moving[0]).toLowerCase()}`
					}
				/>
				<div key="locked" data-testid="assets-locked-sats">
					<Stat
						label="Locked with assets"
						num={btc?.anchorSats ?? status?.lockedSats ?? 0}
						suffix=" sats"
						sub={`in ${btc?.anchorCount ?? status?.anchorCount ?? 0} output${(btc?.anchorCount ?? status?.anchorCount) === 1 ? '' : 's'}`}
					/>
				</div>
				<Stat key="fees" label="Available for fees" num={btc?.spendableSats ?? 0} suffix=" sats" sub="on-chain" />
			</StatRow>

			{active.length > 0 && (
				<Card title="In progress" className="asset-progress-card">
					<ul className="progress-list" data-testid="asset-progress">
						{active.map((row) => (
							<ProgressItem
								key={row.id}
								row={row}
								network={network}
								host={host}
								onDetails={detail.show}
								onRetry={retry}
								retrying={retrying}
							/>
						))}
					</ul>
				</Card>
			)}

			<Card
				title="Holdings"
				help="Taproot Assets are tokens issued on bitcoin. Each is identified by its asset ID, not its name: anyone can create an asset with any name, so go by the ID, or by the pattern beside the name, which is drawn from it. Amounts are in the asset's own units, never in sats."
			>
				{list.length === 0 && <Empty>Nothing here yet. Your first asset appears once it is ready.</Empty>}
				{fungible.length > 0 && (
					<m.div className="asset-rows" variants={staggerContainer} initial="hidden" animate="show" data-testid="asset-rows">
						<AnimatePresence initial={false}>
							{fungible.map((a) => (
								<m.a
									key={a.key}
									layout
									variants={staggerItem}
									className="asset-row"
									href={href(a)}
									data-testid={`asset-row-${a.key.slice(0, 8)}`}
									data-key={a.key}
									onClick={plainClick((e) => {
										e.preventDefault();
										openAsset(a.key);
									})}
								>
									<AssetAvatar asset={a} />
									<span className="asset-row-main">
										<span className="asset-name">{fullName(a)}</span>
										<span className="asset-id">
											<span className="mono">{shortId(a.assetId)}</span>
											{a.groupKey ? ' · can be re-issued' : ''}
										</span>
									</span>
									<span className="asset-balance">
										<AnimatedAssetAmount value={a.balance.total} asset={a} />
										{describeSplit(a) && <span className="asset-balance-sub">{describeSplit(a)}</span>}
									</span>
								</m.a>
							))}
						</AnimatePresence>
					</m.div>
				)}
				{collectibles.length > 0 && (
					<>
						<h4 className="asset-section">Collectibles</h4>
						<div className="asset-grid" data-testid="asset-collectibles">
							{collectibles.map((a) => (
								<a
									key={a.key}
									className="asset-tile"
									href={href(a)}
									data-testid={`asset-tile-${a.key.slice(0, 8)}`}
									onClick={plainClick((e) => {
										e.preventDefault();
										openAsset(a.key);
									})}
								>
									<AssetAvatar asset={a} size="lg" />
									<span className="asset-name">{fullName(a)}</span>
									<span className="asset-id mono">{shortId(a.assetId)}</span>
								</a>
							))}
						</div>
					</>
				)}
				<div className="asset-card-foot">
					{backedUp && list.length > 0 && (
						<div className="wallet-meta" data-testid="assets-backed-up">
							Assets and their proofs were in the backup made {backedUp}.
						</div>
					)}
					<details className="field asset-details">
						<summary>What assets here do not cover</summary>
						<LimitsList network={network} host={host} lightning={lightning} testId="asset-limits-holdings" />
					</details>
				</div>
			</Card>

			{open && (
				<AssetTransferDetail row={open} network={network} host={host} origin={detail.open.origin} onClose={detail.close}>
					<ProofLateNote row={open} host={host} onRetry={() => retry(open)} busy={retrying === open.id} />
				</AssetTransferDetail>
			)}
		</>
	);
}
