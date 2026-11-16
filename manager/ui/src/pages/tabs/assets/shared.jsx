import { createContext, useContext, useState } from 'react';
import AssetAvatar from '../../../components/AssetAvatar.jsx';
import { AssetAmount } from '../../../components/AssetAmount.jsx';
import { Badge, ConfirmationMeter, CopyText, DetailRow, ExplorerLink, Modal, Timeline } from '../../../components/ui.jsx';
import { usePoll } from '../../../hooks/usePoll.js';
import { LIMITS } from '../../../lib/assets.js';
import { headline, kindWord, namesOf, proofUnpublished, railOf, statusOf, stepsOf, timelineLabel, unwatched } from '../../../lib/asset-progress.js';
import { txUrl } from '../../../lib/explorer.js';
import { fmtDate, fmtSats, shortId } from '../../../lib/format.js';

/** A click that is only a click: a modified one is the browser's to handle (new tab, new window). */
export function plainClick(handler) {
	return (e) => {
		if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		handler(e);
	};
}

/** Text in pieces, the { code } ones set in monospace. */
export function Parts({ parts }) {
	return (
		<>
			{(parts || []).map((p, i) => (typeof p === 'string' ? <span key={i}>{p}</span> : <code key={i}>{p.code}</code>))}
		</>
	);
}

/** What assets here do not cover, as a list. */
export function LimitsList({ network, host, lightning, testId = 'asset-limits' }) {
	return (
		<ul className="asset-limits wallet-meta" data-testid={testId}>
			{LIMITS(network, host, lightning).map((item) => (
				<li key={item.key}>
					<Parts parts={item.parts} />
				</li>
			))}
		</ul>
	);
}

/** Fee estimates, re-read every half minute, as the bitcoin send cards do. */
export function useFees(api) {
	const { data } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, [api]);
	return data;
}

/** The three estimates as buttons under a fee field. */
export function FeePresets({ fees, onPick, max }) {
	if (!fees) return null;
	return (
		<div className="preset-row" style={{ marginBottom: 12 }}>
			{[
				['Fast', fees.fast],
				['Normal', fees.normal],
				['Slow', fees.slow]
			].map(([label, rate]) => (
				<button
					key={label}
					type="button"
					className="btn sm"
					disabled={max != null && rate > max}
					onClick={() => onPick(String(rate))}
				>
					{label} · {rate} sat/vB
				</button>
			))}
		</div>
	);
}

/** The line every asset fee field carries, because it changes what a low rate costs. */
export function NoBumpNote({ what = 'transaction' }) {
	return (
		<div className="field-note" data-testid="no-bump-note">
			Asset transactions cannot be fee-bumped yet, so this starts at the fast rate. A low rate can leave the {what}{' '}
			waiting.
		</div>
	);
}

/**
 * A row's steps, drawn. The steps themselves come from lib/asset-progress.js
 * as plain data; this adds the parts that are components: the confirmation
 * meter, and a transaction ID that can be copied and looked up.
 */
/**
 * The network a block explorer link is for, when it is not the wallet's own
 * word for its network: a testnet wallet on testnet4. The Assets tab sets it
 * from its host's status, and null means the `network` a component was given.
 */
export const ExplorerNetwork = createContext(null);

export function RowTimeline({ row, network, host, compact = false, testId }) {
	const explorer = useContext(ExplorerNetwork) || network;
	if (!row) return null;
	const steps = stepsOf(row, { network, host }).map((s) => ({
		...s,
		detail:
			s.detail || s.txid || s.meter ? (
				<>
					{s.meter && <ConfirmationMeter have={s.meter.have} need={s.meter.need} />}
					{s.detail && <span>{s.detail}</span>}
					{s.txid && (
						<>
							<CopyText value={s.txid} label={shortId(s.txid, 8)} />
							<ExplorerLink url={txUrl(explorer, s.txid)}>View</ExplorerLink>
						</>
					)}
				</>
			) : null
	}));
	if (steps.length === 0) return null;
	return <Timeline label={timelineLabel(row)} steps={steps} compact={compact} live={compact ? undefined : headline(row, { network })} testId={testId} />;
}

/** A row's state as a badge. */
export function RowStatus({ row, network }) {
	const s = statusOf(row, { network });
	return <Badge tone={s.tone}>{s.text}</Badge>;
}

/** What a row moved: the face, and the amount. Several assets in one mint are named together. */
export function RowAssets({ row, avatar = true }) {
	const list = row.assets || [];
	if (list.length === 0) return <span className="faint">-</span>;
	if (list.length > 1) {
		return (
			<span className="asset-cell">
				{avatar && <AssetAvatar asset={list[0]} size="xs" />}
				<span>{list.length} assets</span>
			</span>
		);
	}
	return (
		<span className="asset-cell">
			{avatar && <AssetAvatar asset={list[0]} size="xs" />}
			<AssetAmount value={list[0].amount} asset={list[0]} />
		</span>
	);
}

/** Everything known about one row, with its full timeline. Opened from any list of rows. */
export function AssetTransferDetail({ row, network, host, origin, onClose, children }) {
	const explorer = useContext(ExplorerNetwork) || network;
	if (!row) return null;
	return (
		<Modal title={kindWord(row)} origin={origin} onClose={onClose} wide>
			<div data-testid="asset-transfer-detail" data-state={row.state}>
				<div className="asset-transfer-head">
					<RowAssets row={row} />
					<RowStatus row={row} network={network} />
				</div>
				{children}
				{stepsOf(row, { network, host }).length > 0 && (
					<div className="asset-transfer-steps">
						<RowTimeline row={row} network={network} host={host} testId="asset-transfer-timeline" />
					</div>
				)}
				<div className="detail">
					{row.assets?.length > 1 &&
						row.assets.map((a) => (
							<DetailRow key={a.assetId} label={a.name}>
								<AssetAmount value={a.amount} asset={a} />
							</DetailRow>
						))}
					<DetailRow label="Over">{railOf(row)}</DetailRow>
					{row.txid && (
						<DetailRow label="Transaction">
							<CopyText value={row.txid} label={shortId(row.txid, 10)} />
							<ExplorerLink url={txUrl(explorer, row.txid)}>View</ExplorerLink>
						</DetailRow>
					)}
					{row.feeSats != null && (
						<DetailRow label="Miner fee">
							{fmtSats(row.feeSats)}
							{row.satsPerVbyte ? ` at ${row.satsPerVbyte} sat/vB` : ''}
						</DetailRow>
					)}
					{row.anchorSats > 0 && <DetailRow label="Locked with it">{fmtSats(row.anchorSats)}</DetailRow>}
					{row.address && (
						<DetailRow label="Address">
							<CopyText value={row.address} label={shortId(row.address, 12)} />
						</DetailRow>
					)}
					{row.courier && (
						<DetailRow label="Proof server">
							<code>{row.courier}</code>
						</DetailRow>
					)}
					{row.paymentHash && (
						<DetailRow label="Payment hash">
							<CopyText value={row.paymentHash} label={shortId(row.paymentHash, 10)} />
						</DetailRow>
					)}
					<DetailRow label="Started">{fmtDate(row.at?.created)}</DetailRow>
					{row.at?.completed && <DetailRow label="Finished">{fmtDate(row.at.completed)}</DetailRow>}
				</div>
			</div>
		</Modal>
	);
}

/** Which row a list has open in the detail dialog, and where the click was. */
export function useRowDetail() {
	const [open, setOpen] = useState(null); // { id, origin } | null
	return {
		open,
		show: (row, e) => setOpen({ id: row.id, origin: e ? { x: e.clientX, y: e.clientY } : null }),
		close: () => setOpen(null)
	};
}

/**
 * A receive whose transaction confirmed and whose proof has not come. It is
 * the one asset state that looks like a loss and is not, so it says so, and
 * offers the only thing there is to do about it.
 */
export function ProofLateNote({ row, host, onRetry, busy }) {
	if (proofUnpublished(row)) return <ProofUnpublishedNote row={row} host={host} onRetry={onRetry} busy={busy} />;
	if (row && row.failure && row.kind === 'send' && row.state === 'proofs' && !row.failed) {
		return <ProofUndeliveredNote row={row} host={host} onRetry={onRetry} busy={busy} />;
	}
	if (!row || !row.failure || row.kind !== 'receive' || row.state !== 'proofs') return null;
	const where = host || row.courier || 'the proof server';
	return (
		<div className="error-note note-with-action" role="alert" data-testid="asset-proof-late">
			<span>
				The transaction confirmed, but its proof has not arrived from <code>{where}</code> yet. The asset is not lost:
				the wallet keeps asking, and the sender can deliver the proof again.
			</span>
			{onRetry && (
				<button type="button" className="btn sm" disabled={busy} data-testid="asset-proof-retry" onClick={onRetry}>
					{busy ? 'Asking…' : 'Try again now'}
				</button>
			)}
		</div>
	);
}

/**
 * A send that confirmed, whose proof the proof server does not have. A
 * server that answered "no" is the case that matters: the recipient is
 * waiting on it, so it is said in red, with what it means and the one thing
 * there is to do. A server that is only out of reach is said calmly.
 */
function ProofUndeliveredNote({ row, host, onRetry, busy }) {
	// A send's proof goes to the server its address names, not this wallet's own.
	const where = row.courier || host || 'the proof server';
	const refused = row.failure.code === 'PROOF_REFUSED';
	return (
		<div
			className={`${refused ? 'error-note' : 'info-note'} note-with-action`}
			role={refused ? 'alert' : 'status'}
			data-testid="asset-proof-undelivered"
			data-code={row.failure.code}
		>
			<span>
				{refused ? (
					<>
						<code>{where}</code> answered and did not take this transfer's proof, so the recipient does not have the asset
						yet. Nothing is lost: this wallet keeps the proof and offers it again, less and less often.
					</>
				) : (
					<>
						The transaction confirmed, and its proof has not reached <code>{where}</code> yet. The recipient has the asset
						once it has, and the wallet keeps trying.
					</>
				)}
			</span>
			{onRetry && (
				<button type="button" className="btn sm" disabled={busy} data-testid="asset-proof-retry" onClick={onRetry}>
					{busy ? 'Offering…' : 'Offer it again now'}
				</button>
			)}
		</div>
	);
}

/**
 * A mint that is done, whose proof the proof server has not taken yet. The
 * assets are held and spendable, so this is said calmly and in blue: what
 * waits is somebody else being able to check them.
 */
function ProofUnpublishedNote({ row, host, onRetry, busy }) {
	const where = host || row.courier || null;
	const several = (row.assets || []).length > 1;
	return (
		<div className="info-note note-with-action" role="status" data-testid="asset-proof-unpublished">
			<span>
				{namesOf(row)} {several ? 'are' : 'is'} created and in your holdings. The proof server
				{where ? (
					<>
						{' '}
						(<code>{where}</code>)
					</>
				) : null}{' '}
				has not taken {several ? 'their proofs' : 'its proof'} yet, so someone you send {several ? 'them' : 'it'} to may not be
				able to verify {several ? 'them' : 'it'} until it has. The wallet keeps trying.
			</span>
			{onRetry && (
				<button type="button" className="btn sm" disabled={busy} data-testid="asset-proof-retry" onClick={onRetry}>
					{busy ? 'Trying…' : 'Try again'}
				</button>
			)}
		</div>
	);
}

/**
 * An address still waiting to be paid: whether the wallet is looking at it,
 * and a way to look now. An unpaid address is checked by itself for seven
 * days; after that it is only found by asking, and the reader is told.
 */
export function WatchNote({ row, onCheck, busy }) {
	if (!row || row.kind !== 'receive' || row.state !== 'waiting' || !onCheck) return null;
	const button = (
		<button type="button" className="btn sm" disabled={busy} data-testid="asset-check-now" onClick={onCheck}>
			{busy ? 'Checking…' : 'Check now'}
		</button>
	);
	if (unwatched(row)) {
		return (
			<div className="info-note note-with-action" role="status" data-testid="asset-not-watched">
				<span>This address is no longer checked automatically. A payment to it is still found when you check.</span>
				{button}
			</div>
		);
	}
	return (
		<div className="field-hint note-with-action asset-watch" data-testid="asset-watched">
			<span>The wallet checks this address by itself for seven days.</span>
			{button}
		</div>
	);
}
