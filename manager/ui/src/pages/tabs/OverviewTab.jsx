import { useState } from 'react';
import { m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { Badge, Button, Card, CopyText, Help, Stat, staggerContainer, staggerItem } from '../../components/ui.jsx';
import { fmtSats, pct } from '../../lib/format.js';
import { isClosedChannel } from '../../lib/channels.js';
import { describeRecovery } from '../../lib/recovery.js';

import { currentEpoch, describeEpoch, slotCounts } from '../../lib/ffor.js';
import { nodeUris } from '../../lib/node-uris.js';

export default function OverviewTab({ id, api, info, health, recovery, rec, tick, config }) {
	// A liquidity provider fronts its own coins for lightning-first wallets;
	// what it is willing to front and what it has committed is the one figure
	// its owner cannot see anywhere else (GET /jit/status, beignet 0.10+).
	const provider = !!rec?.liquidityProvider && !rec?.onchainOnly;
	const { data: jit } = usePoll(
		() => (provider ? api.get('/jit/status').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, provider]
	);
	// A provider serving swaps (beignet #737, #743) commits its own coins to
	// contracts in one direction and pays invoices for coins locked to it in
	// the other; what is committed right now against the caps it set is the
	// figure its owner cannot see anywhere else (GET /swaps/status, 0.15+).
	const swapping = provider && !!rec?.swaps?.enabled;
	const { data: swaps } = usePoll(
		() => (swapping ? api.get('/swaps/status').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, swapping]
	);
	// A wallet serving as a guardian for other beignet nodes (beignet #699):
	// what it holds for whom, and the address to hand out.
	const serving = !!rec?.guardianServe && !rec?.onchainOnly;
	const { data: guardian } = usePoll(
		() => (serving ? api.get('/guardian/status').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, serving]
	);
	// FFOR offline receive (beignet #729): the voucher book this wallet is
	// being paid against while away, and, on a wallet that settles for its
	// siblings, the books it holds for them. Only on an engine with the routes.
	const fforOn = !!config?.fforAvailable && !rec?.onchainOnly;
	const { data: epochs } = usePoll(
		() => (fforOn ? api.get('/ffor/epochs').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, fforOn]
	);
	const settling = fforOn && !!rec?.ffor?.settle?.enabled;
	const { data: settlements } = usePoll(
		() => (settling ? api.get('/ffor/settlements').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, settling]
	);
	const witnessing = fforOn && !!rec?.ffor?.witness?.enabled;
	const { data: witnessStatus } = usePoll(
		() => (witnessing ? api.get('/ffor/witness/status').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, witnessing]
	);
	const issuing = witnessing && !!rec?.ffor?.issuer?.enabled;
	const { data: issuerStatus } = usePoll(
		() => (issuing ? api.get('/ffor/issuer/status').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, issuing]
	);
	const { data } = usePoll(
		async () => {

			const [balance, liquidity, fees, feeEst, channels] = await Promise.all([
				api.get('/balance').catch(() => null),
				api.get('/liquidity').catch(() => null),
				api.get('/fees').catch(() => null),
				api.get('/fees/estimates').catch(() => null),
				api.get('/channels').catch(() => null)
			]);

			return { balance, liquidity, fees, feeEst, channels };
		},
		10000,
		[id, tick]
	);

	// An on-chain only wallet's overview is an on-chain wallet's overview: the
	// balance, the chain, the fees. Lightning stats, liquidity and the connect
	// card would all describe apparatus the wallet has put away.
	const onchainOnly = !!rec?.onchainOnly;
	const bal = data?.balance;
	const liq = data?.liquidity;
	const fees = data?.fees;
	const feeEst = data?.feeEst;
	const splicing = bal?.splicingSats ?? info?.splicingBalanceSats ?? 0;
	// Both /info's channelCount and the liquidity snapshot's channelCount are
	// every channel the node has ever had, closed ones included forever. Every
	// count this page shows is of channels that still OPERATE, so count open
	// ones from the list itself; until the list answers, fall back to the
	// daemon figure rather than showing nothing.
	const openCount = data?.channels
		? data.channels.filter((c) => !isClosedChannel(c)).length
		: null;

	// What you can actually send is the balance above the channel reserve; below
	// it, nothing is sendable and the balance is still filling the reserve. Fall
	// back to the raw local balance when the daemon does not report the reserve.
	const sendable = liq?.sendableSats ?? liq?.totalLocalBalanceSats ?? 0;
	const belowReserve =
		liq && sendable === 0 && liq.activeChannelCount > 0 && liq.reserveSats > 0;
	const reservePct = belowReserve
		? Math.min(100, Math.round((liq.totalLocalBalanceSats / liq.reserveSats) * 100))
		: 0;

	// The liquidity bar splits capacity into what you can send (sendable), the
	// slice of your balance locked as reserve, and what you can receive. Basing
	// outbound on sendable rather than the raw local balance keeps the bar honest:
	// below the reserve, outbound reads zero. Falls back to the daemon's own
	// percentages when it does not report the reserve.
	const cap = liq?.totalCapacitySats || 0;
	const hasReserveData = liq?.sendableSats != null && cap > 0;
	const outBarPct = hasReserveData
		? (sendable / cap) * 100
		: liq?.outboundLiquidityPct ?? 0;
	const reserveBarPct = hasReserveData
		? (Math.max(0, liq.totalLocalBalanceSats - sendable) / cap) * 100
		: 0;
	const inBarPct = hasReserveData
		? (liq.totalRemoteBalanceSats / cap) * 100
		: liq?.inboundLiquidityPct ?? 0;

	return (
		<div>
			{splicing > 0 && (
				<div className="info-note" style={{ marginBottom: 14 }}>
					A splice is confirming: {fmtSats(splicing)} rejoin your Lightning
					balance when it locks. Payments keep working in the meantime.
				</div>
			)}
			<m.div
				className={onchainOnly ? 'grid cols-2' : 'grid cols-4'}
				style={{ marginBottom: 18 }}
				variants={staggerContainer}
				initial="hidden"
				animate="show"
			>
				{(onchainOnly
					? [
							<Stat key="on" label="On-chain" num={bal?.onchain ?? info?.onchainBalanceSats} suffix=" sats" />,
							<Stat key="height" label="Block height" num={info?.blockHeight} />
					  ]
					: [
							<Stat key="on" label="On-chain" num={bal?.onchain ?? info?.onchainBalanceSats} suffix=" sats" />,
							<Stat
								key="ln"
								label="Lightning"
								num={bal?.lightning ?? info?.lightningBalanceSats}
								suffix=" sats"
								sub={splicing > 0 ? `+ ${fmtSats(splicing)} splicing` : undefined}
							/>,
							<Stat key="total" label="Total" num={bal?.total} suffix=" sats" />,
							<Stat
								key="ch"
								label="Channels"
								num={openCount ?? info?.channelCount}
								sub={`${info?.peerCount ?? 0} peers`}
							/>
					  ]
				).map((stat, i) => (
					<m.div key={i} variants={staggerItem}>
						{stat}
					</m.div>
				))}
			</m.div>

			<div className="grid cols-2">
				<Card title="Node status">
					<table>
						<tbody>
							<Row k="Sync" v={<Badge tone={health?.status === 'ready' ? 'green' : 'yellow'}>{health?.status || '-'}</Badge>} />
							<Row k="Block height" v={info?.blockHeight ?? '-'} />
							<Row k="Electrum" v={<Badge tone={health?.electrumConnected ? 'green' : 'red'}>{health?.electrumConnected ? 'connected' : 'disconnected'}</Badge>} />
							{!onchainOnly && <Row k="Listening" v={info?.listening ? 'yes' : 'no'} />}
							{!onchainOnly && (
								<Row k="Graph" v={health ? `${health.graphNodes} nodes / ${health.graphChannels} channels` : '-'} />
							)}
							{!onchainOnly && <Row k="Pending close" v={fmtSats(info?.pendingCloseBalanceSats)} />}
						{splicing > 0 && <Row k="Splicing" v={fmtSats(splicing)} />}
							{!onchainOnly && <BackupRow recovery={recovery} rec={rec} />}
							{fforOn && <EpochRow epochs={epochs} tip={info?.blockHeight} />}
						</tbody>
					</table>
				</Card>

				{!onchainOnly && (
				<Card title="Liquidity">
					{liq && (openCount ?? liq.channelCount) > 0 ? (
						<>
							<div className="liq">
								<div className="out" style={{ width: `${outBarPct}%` }} />
								{reserveBarPct > 0 && (
									<div
										className="reserve-seg"
										style={{ width: `${reserveBarPct}%` }}
										title="Locked as channel reserve"
									/>
								)}
								<div className="in" style={{ width: `${inBarPct}%` }} />
							</div>
							<div className="liq-legend">
								<span>◆ Outbound {pct(outBarPct)}</span>
								<span>Inbound {pct(inBarPct)} ◆</span>
							</div>
							<div className="grid cols-2" style={{ marginTop: 12 }}>
								<Stat label="Can send" num={sendable} suffix=" sats" sub="outbound" />
								<Stat
									label="Can receive"
									num={liq.totalRemoteBalanceSats}
									suffix=" sats"
									sub="inbound"
								/>
							</div>
							{belowReserve && (
								<div className="reserve-note">
									<div className="reserve-head">
										Fill the channel reserve before you can send
									</div>
									<div className="reserve-bar">
										<div className="reserve-fill" style={{ width: `${reservePct}%` }} />
									</div>
									<div className="reserve-legend">
										<span>{fmtSats(liq.totalLocalBalanceSats)} balance</span>
										<span>{fmtSats(liq.reserveSats)} reserve</span>
									</div>
								</div>
							)}
							<div className="wallet-meta" style={{ marginTop: 10 }}>
								{liq.activeChannelCount}/{openCount ?? liq.channelCount} channels
								active · capacity {fmtSats(liq.totalCapacitySats)}
							</div>
						</>
					) : (
						<div className="empty">No channels yet. Open one from the Channels tab.</div>
					)}
				</Card>
				)}

				{provider && <ProviderCard jit={jit} rec={rec} />}
				{swapping && <SwapsCard swaps={swaps} rec={rec} />}
				{serving && <GuardianCard guardian={guardian} rec={rec} info={info} />}
				{settling && <SettlementCard settlements={settlements} />}
				{witnessing && <WitnessCard status={witnessStatus} />}
				{issuing && <IssuerCard status={issuerStatus} />}

				<Card title="Fees">
					{feeEst ? (
						<div className="grid cols-3">
							<Stat label="Fast" num={feeEst.fast} sub="sat/vB" />
							<Stat label="Normal" num={feeEst.normal} sub="sat/vB" />
							<Stat label="Slow" num={feeEst.slow} sub="sat/vB" />
						</div>
					) : (
						<div className="empty">Fee estimates not available yet.</div>
					)}
					{fees && !onchainOnly && (
						<div className="wallet-meta" style={{ marginTop: 10 }}>
							Channel-open advice: {fees.recommendation} · ~{fmtSats(fees.estimatedOpenChannelCostSats)}
						</div>
					)}
				</Card>


				{!onchainOnly && <ConnectCard info={info} rec={rec} />}
			</div>
		</div>
	);
}


/**
 * The ways a peer can reach this node, by the wallet's network mode (umbrel
 * #193), one at a time so the card stays a single line of address instead of
 * a wall of them: the public address the record holds (Clearnet and Hybrid),
 * the Tor address (Tor and Hybrid), and the address on the home network,
 * which every wallet has because the app publishes the wallet ports on this
 * Umbrel. The ports are the record's, so they are the host ports peers dial.
 * The first way that has an address is shown until the reader picks another.
 */
function ConnectCard({ info, rec }) {
	const [picked, setPicked] = useState(null);
	const ways = nodeUris({ nodeId: info?.nodeId, rec, lanHost: window.location.hostname });
	const first = (ways.find((w) => w.uri) || ways[0]).key;
	const key = picked && ways.some((w) => w.key === picked) ? picked : first;
	const way = ways.find((w) => w.key === key);

	return (
		<Card
			title="Connect to this node"
			help="Each way in follows this wallet's network mode, set with Edit above: its public address in Clearnet and Hybrid, its Tor address in Tor and Hybrid, and its address on your home network in every mode, since the app publishes the wallet ports on this Umbrel. The public and home-network ports are the ones on this Umbrel; a peer on the internet reaches the public one once your router forwards it."
		>
			<div style={{ display: 'flex', gap: 6, marginBottom: 12 }} data-testid="connect-ways">
				{ways.map((w) => (
					<Button
						key={w.key}
						className="sm"
						style={{ flex: 1 }}
						variant={w.key === key ? 'primary' : 'ghost'}
						onClick={() => setPicked(w.key)}
					>
						{w.label}
					</Button>
				))}
			</div>
			{way.uri ? <CopyText value={way.uri} /> : <div className="empty">Not available yet.</div>}
			<span className="field-hint" style={{ display: 'block', marginTop: 8 }} data-testid="connect-hint">
				{way.hint}
			</span>
		</Card>
	);
}

// Channel backup, the tier stated plainly: the daemon's recovery status
// (null while it has not answered yet, state 'unsupported' when the engine
// predates the feature) reduced to a line and a sentence.
/**
 * What this wallet fronts for lightning-first wallets (the JIT receive role)
 * and what it has committed right now. The caps are the owner's own policy
 * from the Edit dialog; the rest is the daemon's account of the exposure.
 */
function ProviderCard({ jit, rec }) {
	const lsp = jit?.lsp || null;
	const dependents = rec?.lfbwDependents || [];
	return (
		<Card
			title="Liquidity provider"
			help="This wallet funds channels for lightning-first wallets from its own on-chain balance when a payment to them arrives. Any beignet wallet may ask; the caps bound what is committed."
			className="grid-full"
		>
			{dependents.length > 0 && (
				<div className="wallet-meta" style={{ marginBottom: 10 }}>
					Serving as the primary node of {dependents.map((d) => `"${d.name}"`).join(', ')}.
				</div>
			)}
			{!jit ? (
				<div className="wallet-meta">Reading the provider status…</div>
			) : !lsp ? (
				<div className="info-note">
					The daemon is not running the provider role. It takes it on its next start
					(the Edit dialog restarts the wallet), or the bundled engine predates the
					status route.
				</div>
			) : (
				<>
					<div className="grid cols-4">
						<Stat label="Fronted so far" num={lsp.frontedSats} suffix=" sats" sub="across restarts" />
						<Stat label="Committed now" num={lsp.reservedSats} suffix=" sats" sub={`${lsp.fundingsInFlight} funding${lsp.fundingsInFlight === 1 ? '' : 's'} in flight`} />
						<Stat label="Live intents" num={lsp.liveIntents} sub={`${lsp.heldParts} payment${lsp.heldParts === 1 ? '' : 's'} held`} />
						<Stat
							label="Fee"
							value={`${fmtSats(lsp.flatFeeSat)}${lsp.feePpm > 0 ? ` + ${lsp.feePpm} ppm` : ''}`}
							sub="taken from each delivery"
						/>
					</div>
					<div className="wallet-meta" style={{ marginTop: 10 }}>
						Caps: {fmtSats(lsp.maxClientFundingSats)} per client · {lsp.maxConcurrentFundings} funding
						{lsp.maxConcurrentFundings === 1 ? '' : 's'} at once ·{' '}
						{lsp.maxTotalFundingSats == null ? 'no lifetime budget' : `${fmtSats(lsp.maxTotalFundingSats)} lifetime budget`}
						{lsp.maxTotalFundingSats != null && lsp.frontedSats + lsp.reservedSats >= lsp.maxTotalFundingSats
							? ' (spent: nothing more is fronted until it is raised)'
							: ''}
					</div>
				</>
			)}
		</Card>
	);
}

function fmtBytes(n) {
	const v = Number(n) || 0;
	if (v >= 1024 * 1024 * 1024) return `${(v / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
	if (v >= 1024 * 1024) return `${(v / (1024 * 1024)).toFixed(1)} MiB`;
	if (v >= 1024) return `${(v / 1024).toFixed(0)} KiB`;
	return `${v} B`;
}

// The daemon reports the caps per direction, but enforces one budget across
// both, so the card prints them once. Should some engine ever let the two
// differ, there is no single budget to print and each direction keeps its own.
const oneBudget = (a = {}, b = {}) =>
	String(a.maxTotalExposureSat ?? '') === String(b.maxTotalExposureSat ?? '') &&
	String(a.maxConcurrentSwaps ?? '') === String(b.maxConcurrentSwaps ?? '');

/**
 * The guardian this wallet serves to other beignet nodes (beignet #699):
 * the sets it holds, how much, how many sessions are up, and the address
 * another wallet pastes into its Settings to pin this node.
 */
/**
 * What this wallet has committed to swaps right now, per direction, against
 * the caps the owner set. The daemon's exposure figure counts every swap it
 * still answers for (the contract funded and not yet resolved, a payment out
 * with the claim still owed); the state breakdown is the ledger as it stands.
 */
function SwapsCard({ swaps, rec }) {
	const wantsSubmarine = !!rec?.swaps?.submarine;
	const sharing = !!(
		swaps?.enabled &&
		swaps.submarine?.enabled &&
		oneBudget(swaps.limits, swaps.submarine.limits)
	);
	return (
		<Card
			title="Swaps"
			help={
				<>
					This wallet serves swaps for other wallets: Lightning to on-chain, where it funds a contract
					from its own balance and settles the payment once the coins are claimed
					{wantsSubmarine
						? ', and on-chain to Lightning, where it pays an invoice for coins locked to it and claims them with the preimage'
						: ''}
					. The caps bound what is committed at once
					{sharing ? ', across both directions together' : ''}.
				</>
			}
			className="grid-full"
		>
			{!swaps ? (
				<div className="wallet-meta">Reading the swap status…</div>
			) : !swaps.enabled ? (
				<div className="info-note">
					The daemon is not running the swap role, so nothing is being served yet. Either it
					has not restarted since you turned swaps on (the Edit dialog restarts it), or the
					bundled engine drops this policy on the way to the node, which no restart fixes and
					an app update does.
				</div>
			) : (
				<>
					{sharing && <SwapBudget reverse={swaps} submarine={swaps.submarine} />}
					<SwapDirection label="Lightning to on-chain (reverse)" status={swaps} sharing={sharing} />
					{wantsSubmarine &&
						(swaps.submarine?.enabled ? (
							<SwapDirection
								label="On-chain to Lightning (submarine)"
								status={swaps.submarine}
								sharing={sharing}
							/>
						) : (
							<div className="info-note" style={{ marginTop: 10 }}>
								The on-chain to Lightning direction starts with the wallet's next restart, or the
								bundled engine predates it (beignet 0.16.0).
							</div>
						))}
				</>
			)}
		</Card>
	);
}

// A ledger state as a phrase: CLAIM_BROADCAST reads "claim broadcast".
const swapStateWords = (state) => String(state).toLowerCase().replace(/_/g, ' ');

// The states a swap ends in. The concurrency limit counts every row that is
// not one of these, while the reported exposure counts only the rows whose
// principal is at risk, so the slots have to be counted from the ledger
// breakdown. A state this app has not heard of counts as live: overstating
// the room left is the worse way to be wrong.
const terminalSwapStates = new Set([
	'SETTLED',
	'REFUNDED',
	'CANCELLED',
	'FAILED',
	'CLAIM_CONFIRMED',
	'PAYMENT_FAILED'
]);

const liveSwaps = (status) =>
	Object.entries(status.counts || {}).reduce(
		(n, [state, c]) => (terminalSwapStates.has(state) ? n : n + Number(c || 0)),
		0
	);

/**
 * The one budget both directions draw on. The daemon admits a swap against the
 * whole ledger with no direction filter, so the exposure ceiling and the
 * concurrency limit are shared: what reverse holds is not there for submarine.
 * Only the reporting is per direction, and the two row sets partition the
 * ledger, so the sum of the two is the whole of it.
 */
function SwapBudget({ reverse, submarine }) {
	const limits = reverse.limits || {};
	const exposedSat = Number(reverse.exposedSat || 0) + Number(submarine.exposedSat || 0);
	const exposedCount = Number(reverse.exposedCount || 0) + Number(submarine.exposedCount || 0);
	const maxSat = Number(limits.maxTotalExposureSat || 0);
	const maxCount = Number(limits.maxConcurrentSwaps);
	// Every exposed row is a live one, so the ledger breakdown can only be an
	// undercount if it is missing.
	const liveCount = Math.max(liveSwaps(reverse) + liveSwaps(submarine), exposedCount);
	const slotsLeft = Number.isFinite(maxCount) ? Math.max(0, maxCount - liveCount) : null;
	return (
		<div style={{ marginTop: 10 }}>
			<div className="field-label" style={{ marginBottom: 8 }}>
				Both directions together
			</div>
			<div className="grid cols-3">
				<Stat
					label="Committed now"
					num={exposedSat}
					suffix=" sats"
					sub={`over ${exposedCount} swap${exposedCount === 1 ? '' : 's'}, both directions`}
				/>
				<Stat
					label="Caps"
					value={fmtSats(maxSat)}
					sub={`at once, ${limits.maxConcurrentSwaps ?? '-'} swap${maxCount === 1 ? '' : 's'} at most`}
				/>
				<Stat
					label="Room left"
					num={Math.max(0, maxSat - exposedSat)}
					suffix=" sats"
					sub={
						slotsLeft === null
							? 'for either direction'
							: `${slotsLeft} more swap${slotsLeft === 1 ? '' : 's'} of the ${maxCount}, either direction`
					}
				/>
			</div>
			<div className="wallet-meta" style={{ marginTop: 8 }}>
				One budget covers both directions, not one each. What a reverse swap holds is not there
				for a submarine one, and the limit on swaps in flight is the total. Each direction below
				reports its own share of this.
			</div>
		</div>
	);
}

function SwapDirection({ label, status, sharing }) {
	const limits = status.limits || {};
	const fee = status.fee || {};
	const exposedSat = Number(status.exposedSat || 0);
	const exposedCount = Number(status.exposedCount || 0);
	const counts = Object.entries(status.counts || {}).filter(([, n]) => n > 0);
	const exposedRows = Number((status.counts || {}).EXPOSED || 0);
	return (
		<div style={{ marginTop: 10 }}>
			<div className="field-label" style={{ marginBottom: 8 }}>
				{label}
			</div>
			<div className={`grid cols-${sharing ? 3 : 4}`}>
				<Stat
					label="Committed now"
					num={exposedSat}
					suffix=" sats"
					sub={`${exposedCount} swap${exposedCount === 1 ? '' : 's'} in flight${sharing ? ', of the shared budget' : ''}`}
				/>
				{!sharing && (
					<Stat
						label="Caps"
						value={fmtSats(Number(limits.maxTotalExposureSat || 0))}
						sub={`at once, ${limits.maxConcurrentSwaps ?? '-'} swap${limits.maxConcurrentSwaps === 1 ? '' : 's'} at most`}
					/>
				)}
				<Stat
					label="Swap size"
					value={`${fmtSats(Number(limits.minSwapSat || 0))} to ${fmtSats(Number(limits.maxSwapSat || 0))}`}
					sub="sats per swap"
				/>
				<Stat
					label="Fee"
					value={`${fmtSats(Number(fee.flatFeeSat || 0))}${Number(fee.feePpm) > 0 ? ` + ${fee.feePpm} ppm` : ''}`}
					sub="taken from each swap"
				/>
			</div>
			<div className="wallet-meta" style={{ marginTop: 8 }}>
				{counts.length === 0
					? 'No swaps yet.'
					: `Ledger: ${counts.map(([state, n]) => `${n} ${swapStateWords(state)}`).join(' · ')}.`}
				{exposedRows > 0 ? (
					<>
						{' '}
						<Badge tone="red">
							{exposedRows} exposed
						</Badge>{' '}
						A payment went out while the contract is not claimable; check the Logs tab.
					</>
				) : null}
			</div>
		</div>
	);
}

function GuardianCard({ guardian, rec, info }) {
	const sets = guardian?.sets || [];
	const namespaces = sets.reduce((n, s) => n + (s.namespaces || 0), 0);
	const bytes = sets.reduce((n, s) => n + (s.bytes || 0), 0);

	const onionUri = info?.nodeId && rec?.onionAddress ? `${info.nodeId}@${rec.onionAddress}` : null;
	const publicUri = info?.nodeId && rec?.publicAddress ? `${info.nodeId}@${rec.publicAddress}` : null;
	const localUri = info?.nodeId && rec?.listenPort ? `${info.nodeId}@127.0.0.1:${rec.listenPort}` : null;
	return (
		<Card
			title="Guardian for other nodes"
			help="This wallet holds an encrypted journal of channel state for beignet nodes that pinned it as one of their three guardians. The journal is opaque to it; a full quota refuses new writes rather than deleting anything."
			className="grid-full"
		>
			{!guardian ? (
				<div className="wallet-meta">Reading the guardian status…</div>
			) : guardian.serving === false ? (
				<div className="info-note">
					The daemon is not serving yet. Either it has not restarted since you turned this on
					(the Edit dialog restarts it), or the bundled engine drops the setting on the way to
					the node, which no restart fixes and an app update does.
				</div>
			) : (
				<>
					<div className="grid cols-4">
						<Stat label="Sets served" num={sets.length} sub={`of ${guardian.limits?.maxSets ?? '-'} allowed`} />
						<Stat label="Nodes guarded" num={namespaces} sub="namespaces registered" />
						<Stat label="Stored" value={fmtBytes(bytes)} sub={`up to ${fmtBytes(guardian.limits?.maxBytesPerSet)} per set`} />
						<Stat label="Sessions" num={guardian.sessions || 0} sub="open right now" />
					</div>
					<div className="wallet-meta" style={{ marginTop: 10 }}>
						Guardian id: <code>{guardian.guardianId}</code>
					</div>
					<div className="field-label" style={{ marginTop: 10, marginBottom: 6 }}>
						Address to share
					</div>

					{onionUri ? (
						<>
							<CopyText value={onionUri} />
							<div className="wallet-meta" style={{ marginTop: 4 }}>
								Another beignet wallet pastes this into its Settings guardians; it resolves to a
								guardian entry over Tor, no port forwarding needed.
							</div>
						</>
					) : publicUri ? (
						<>
							<CopyText value={publicUri} />
							<div className="wallet-meta" style={{ marginTop: 4 }}>
								Another beignet wallet pastes this into its Settings guardians; it resolves to a
								guardian entry at your public address, once the port is forwarded on your router.
							</div>
						</>
					) : (
						<div className="info-note">
							Turn on announcing in Edit so nodes outside this Umbrel can reach this guardian.
							{localUri ? ` Wallets on this Umbrel can use ${localUri}.` : ''}
						</div>
					)}
				</>
			)}
		</Card>
	);
}

function BackupRow({ recovery, rec }) {
	if (!recovery) return <Row k="Backup" v="-" />;
	const d = describeRecovery(recovery, rec || {});
	return (
		<Row
			k="Backup"
			v={
				<>
					<Badge tone={d.tone}>{d.tier}</Badge>
					{d.about && <Help>{d.about}</Help>}
					{d.detail && (
						<div className="wallet-meta" style={{ marginTop: 4 }}>
							{d.detail}
						</div>
					)}
				</>
			}
		/>
	);
}

// The voucher book this wallet is being paid against while away (FFOR): its
// state, how many vouchers were paid, and the height to be back by.
function EpochRow({ epochs, tip }) {
	const epoch = Array.isArray(epochs) ? currentEpoch(epochs) : null;
	if (!epoch) return null;
	const d = describeEpoch(epoch, tip || 0);
	return (
		<Row
			k="Offline receive"
			v={
				<>
					<Badge tone={d.tone}>{d.label}</Badge>
					<div className="wallet-meta" style={{ marginTop: 4 }} data-testid="ffor-row">
						{d.detail}
					</div>
				</>
			}
		/>
	);
}

/**
 * The voucher books this wallet settles for its siblings (FFOR, beignet
 * #729): one row per epoch, with what it has settled so far. The whole
 * budget of each book is locked on this wallet's side of the channel until
 * the sibling returns and closes it.
 */
function SettlementCard({ settlements }) {
	return (
		<Card
			title="Offline receives settled for siblings"
			help="Sibling wallets pre-sign voucher books on their channels with this one and go offline; this wallet settles payments to those vouchers at once from its side of the channel, and each book locks its amount here until the sibling is back and closes it."
			className="grid-full"
		>
			{!settlements ? (
				<div className="wallet-meta">Reading the settlement status…</div>
			) : settlements.length === 0 ? (
				<div className="empty">No voucher book is open with this wallet right now.</div>
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Channel</th>
								<th>State</th>
								<th>Paid</th>
								<th>Locked</th>
								<th>Return by</th>
							</tr>
						</thead>
						<tbody>
							{settlements.map((e) => {
								const counts = slotCounts(e);
								const d = describeEpoch({ ...e, role: 'R' }, 0);
								return (
									<tr key={e.channelId}>
										<td className="mono">{String(e.channelId).slice(0, 12)}…</td>
										<td>
											<Badge tone={d.tone}>{e.state.toLowerCase()}</Badge>
										</td>
										<td>
											{counts.settled} of {counts.total}
										</td>
										<td>{fmtSats(Math.floor(Number(e.budgetMsat || 0) / 1000))}</td>
										<td>block {e.settlementDeadline}</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}

// The receipt mailboxes this wallet keeps for siblings receiving offline.
function WitnessCard({ status }) {
	return (
		<Card
			title="Receipts kept for siblings"
			help="Sibling wallets receiving offline can name this wallet as a witness: payments to their vouchers route through it, and it stores an encrypted receipt of each before passing it on. Each mailbox is one book; the receipts are opaque to this wallet and kept until their retention height."
			className="grid-full"
		>
			{!status ? (
				<div className="wallet-meta">Reading the witness status…</div>
			) : !status.enabled ? (
				<div className="info-note">
					The daemon is not running the witness role. It takes it on its next start (the Edit dialog
					restarts the wallet), or the bundled engine predates the status route.
				</div>
			) : status.mailboxes.length === 0 ? (
				<div className="empty">No mailbox is open here right now.</div>
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Mailbox</th>
								<th>State</th>
								<th>Vouchers</th>
								<th>Receipts</th>
								<th>Kept until</th>
							</tr>
						</thead>
						<tbody>
							{status.mailboxes.map((m) => (
								<tr key={m.mailboxId}>
									<td className="mono">{String(m.mailboxId).slice(0, 12)}…</td>
									<td>
										<Badge tone={m.state === 'PROVISIONED' ? 'green' : 'muted'}>{String(m.state).toLowerCase()}</Badge>
									</td>
									<td>{m.slots}</td>
									<td>{m.records}</td>
									<td>block {m.retentionUntil}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}

// The offers this wallet answers invoices for, on behalf of siblings.
function IssuerCard({ status }) {
	return (
		<Card
			title="Invoices issued for siblings"
			help="A sibling receiving offline can hand this wallet a BOLT 12 offer; a payer who holds no invoice asks here and gets the invoice for the next unused voucher of the book, one per request."
			className="grid-full"
		>
			{!status ? (
				<div className="wallet-meta">Reading the issuer status…</div>
			) : !status.enabled ? (
				<div className="info-note">
					The daemon is not running the issuer role. It takes it on its next start (the Edit dialog
					restarts the wallet), or the bundled engine predates the status route.
				</div>
			) : status.manifests.length === 0 ? (
				<div className="empty">No offer is delegated here right now.</div>
			) : (
				<div className="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Offer</th>
								<th>State</th>
								<th>Issued</th>
								<th>Issue until</th>
							</tr>
						</thead>
						<tbody>
							{status.manifests.map((m) => (
								<tr key={m.mailboxId}>
									<td className="mono">{String(m.offerId).slice(0, 12)}…</td>
									<td>
										<Badge tone={m.state === 'ISSUING' ? 'green' : 'muted'}>{String(m.state).toLowerCase()}</Badge>
									</td>
									<td>
										{(m.issued || []).length} of {m.slots}
									</td>
									<td>block {m.issueUntil}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</Card>
	);
}

function Row({ k, v }) {
	return (
		<tr>
			<td className="wallet-meta" style={{ width: 130 }}>
				{k}
			</td>
			<td>{v}</td>
		</tr>
	);
}
