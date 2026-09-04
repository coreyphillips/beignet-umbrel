import { useState } from 'react';
import { m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { Badge, Button, Card, CopyText, Stat, staggerContainer, staggerItem } from '../../components/ui.jsx';
import { fmtSats, pct } from '../../lib/format.js';
import { isClosedChannel } from '../../lib/channels.js';
import { describeRecovery } from '../../lib/recovery.js';

export default function OverviewTab({ id, api, info, health, recovery, rec, tick }) {
	// A liquidity provider fronts its own coins for lightning-first wallets;
	// what it is willing to front and what it has committed is the one figure
	// its owner cannot see anywhere else (GET /jit/status, beignet 0.10+).
	const provider = !!rec?.liquidityProvider && !rec?.onchainOnly;
	const { data: jit } = usePoll(
		() => (provider ? api.get('/jit/status').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, provider]
	);
	// A wallet serving as a guardian for other beignet nodes (beignet #699):
	// what it holds for whom, and the address to hand out.
	const serving = !!rec?.guardianServe && !rec?.onchainOnly;
	const { data: guardian } = usePoll(
		() => (serving ? api.get('/guardian/status').catch(() => null) : Promise.resolve(null)),
		10000,
		[id, tick, serving]
	);
	const { data } = usePoll(
		async () => {
			const [balance, nodeUri, liquidity, fees, feeEst, channels] = await Promise.all([
				api.get('/balance').catch(() => null),
				api.get('/node/uri?host=127.0.0.1').then((r) => r.uri).catch(() => null),
				api.get('/liquidity').catch(() => null),
				api.get('/fees').catch(() => null),
				api.get('/fees/estimates').catch(() => null),
				api.get('/channels').catch(() => null)
			]);
			return { balance, nodeUri, liquidity, fees, feeEst, channels };
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
						</tbody>
					</table>
				</Card>

				{provider && <ProviderCard jit={jit} rec={rec} />}
				{serving && <GuardianCard guardian={guardian} rec={rec} info={info} />}
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

				{!onchainOnly && <ConnectCard id={id} info={info} rec={rec} nodeUri={data?.nodeUri} />}
			</div>
		</div>
	);
}

/**
 * The three ways a peer can reach this node, one at a time so the card stays a
 * single line of address instead of a wall of them.
 *
 * The listen port comes from the daemon's own URI rather than a hardcoded 9735,
 * because wallets here are assigned ports out of a range. The clearnet host is
 * typed by the user and remembered: only they know their public address, and
 * looking it up would mean calling an outside service from their node.
 */
function ConnectCard({ id, info, rec, nodeUri }) {
	const [mode, setMode] = useState('local');
	const storeKey = `beignet.clearnetHost.${id}`;
	const [clearnetHost, setClearnetHost] = useState(() => localStorage.getItem(storeKey) || '');

	const port = nodeUri?.split(':').pop() || '';
	const lanHost = window.location.hostname;
	const clearnet = clearnetHost.trim();

	const options = [
		{ key: 'local', label: 'Local network' },
		{ key: 'clearnet', label: 'Clearnet' },
		{ key: 'tor', label: 'Tor' }
	];

	let uri = null;
	let hint = null;
	if (mode === 'local') {
		uri = info?.nodeId && port ? `${info.nodeId}@${lanHost}:${port}` : null;
		hint = `Reachable from other machines on your home network, at the address you use to open this dashboard.`;
	} else if (mode === 'clearnet') {
		uri = info?.nodeId && port && clearnet ? `${info.nodeId}@${clearnet}:${port}` : null;
		hint = `Your public IP or domain. Port ${port || '(unknown)'} must be forwarded to your Umbrel for peers to reach you.`;
	} else {
		uri = info?.nodeId && rec?.onionAddress ? `${info.nodeId}@${rec.onionAddress}` : null;
		hint = rec?.onionAddress
			? 'Reachable over Tor with no port forwarding. Share this to receive inbound channels.'
			: 'Tor announcing is off for this wallet. Turn it on with Edit above.';
	}

	return (
		<Card title="Connect to this node">
			<div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
				{options.map((o) => (
					<Button
						key={o.key}
						className="sm"
						style={{ flex: 1 }}
						variant={o.key === mode ? 'primary' : 'ghost'}
						onClick={() => setMode(o.key)}
					>
						{o.label}
					</Button>
				))}
			</div>
			{mode === 'clearnet' && (
				<input
					value={clearnetHost}
					placeholder="node.example.com or 203.0.113.4"
					style={{ marginBottom: 10 }}
					onChange={(e) => {
						setClearnetHost(e.target.value);
						localStorage.setItem(storeKey, e.target.value);
					}}
				/>
			)}
			{uri ? <CopyText value={uri} /> : <div className="empty">Not available yet.</div>}
			<span className="field-hint" style={{ display: 'block', marginTop: 8 }}>
				{hint}
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
		<Card title="Liquidity provider" className="grid-full">
			<div className="wallet-meta" style={{ marginBottom: 10 }}>
				This wallet funds channels for lightning-first wallets from its own on-chain balance
				when a payment to them arrives
				{dependents.length > 0 ? `: primary node of ${dependents.map((d) => `"${d.name}"`).join(', ')}` : ''}
				. Any beignet wallet may ask; the caps bound what is committed.
			</div>
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

/**
 * The guardian this wallet serves to other beignet nodes (beignet #699):
 * the sets it holds, how much, how many sessions are up, and the address
 * another wallet pastes into its Settings to pin this node.
 */
function GuardianCard({ guardian, rec, info }) {
	const sets = guardian?.sets || [];
	const namespaces = sets.reduce((n, s) => n + (s.namespaces || 0), 0);
	const bytes = sets.reduce((n, s) => n + (s.bytes || 0), 0);
	const onionUri = info?.nodeId && rec?.onionAddress ? `${info.nodeId}@${rec.onionAddress}` : null;
	const localUri = info?.nodeId && rec?.listenPort ? `${info.nodeId}@127.0.0.1:${rec.listenPort}` : null;
	return (
		<Card title="Guardian for other nodes" className="grid-full">
			<div className="wallet-meta" style={{ marginBottom: 10 }}>
				This wallet holds an encrypted journal of channel state for beignet nodes that pinned it
				as one of their three guardians. The journal is opaque to it; a full quota refuses new
				writes rather than deleting anything.
			</div>
			{!guardian ? (
				<div className="wallet-meta">Reading the guardian status…</div>
			) : guardian.serving === false ? (
				<div className="info-note">
					The daemon is not serving yet. It takes the role on its next start (the Edit dialog
					restarts the wallet), or the bundled engine predates the guardian surface.
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
					) : (
						<div className="info-note">
							Turn on the Tor address in Edit so nodes outside this Umbrel can reach this guardian.
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
					<div className="wallet-meta" style={{ marginTop: 4 }}>
						{d.detail}
					</div>
				</>
			}
		/>
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
