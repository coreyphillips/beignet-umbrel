import { useState } from 'react';
import { m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { Badge, Button, Card, CopyText, Stat, staggerContainer, staggerItem } from '../../components/ui.jsx';
import { fmtSats, pct } from '../../lib/format.js';

export default function OverviewTab({ id, api, info, health, rec, tick }) {
	const { data } = usePoll(
		async () => {
			const [balance, nodeUri, liquidity, fees, feeEst] = await Promise.all([
				api.get('/balance').catch(() => null),
				api.get('/node/uri?host=127.0.0.1').then((r) => r.uri).catch(() => null),
				api.get('/liquidity').catch(() => null),
				api.get('/fees').catch(() => null),
				api.get('/fees/estimates').catch(() => null)
			]);
			return { balance, nodeUri, liquidity, fees, feeEst };
		},
		10000,
		[id, tick]
	);

	const bal = data?.balance;
	const liq = data?.liquidity;
	const fees = data?.fees;
	const feeEst = data?.feeEst;
	const splicing = bal?.splicingSats ?? info?.splicingBalanceSats ?? 0;

	return (
		<div>
			{splicing > 0 && (
				<div className="info-note" style={{ marginBottom: 14 }}>
					A splice is confirming: {fmtSats(splicing)} rejoin your Lightning
					balance when it locks. Payments keep working in the meantime.
				</div>
			)}
			<m.div
				className="grid cols-4"
				style={{ marginBottom: 18 }}
				variants={staggerContainer}
				initial="hidden"
				animate="show"
			>
				{[
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
						num={info?.channelCount}
						sub={`${info?.peerCount ?? 0} peers`}
					/>
				].map((stat, i) => (
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
							<Row k="Listening" v={info?.listening ? 'yes' : 'no'} />
							<Row k="Graph" v={health ? `${health.graphNodes} nodes / ${health.graphChannels} channels` : '-'} />
							<Row k="Pending close" v={fmtSats(info?.pendingCloseBalanceSats)} />
						{splicing > 0 && <Row k="Splicing" v={fmtSats(splicing)} />}
						</tbody>
					</table>
				</Card>

				<Card title="Liquidity">
					{liq && liq.channelCount > 0 ? (
						<>
							<div className="liq">
								<div className="out" style={{ width: `${liq.outboundLiquidityPct}%` }} />
								<div className="in" style={{ width: `${liq.inboundLiquidityPct}%` }} />
							</div>
							<div className="liq-legend">
								<span>◆ Outbound {pct(liq.outboundLiquidityPct)}</span>
								<span>Inbound {pct(liq.inboundLiquidityPct)} ◆</span>
							</div>
							<div className="grid cols-2" style={{ marginTop: 12 }}>
								<Stat
									label="Can send"
									num={liq.totalLocalBalanceSats}
									suffix=" sats"
									sub="outbound"
								/>
								<Stat
									label="Can receive"
									num={liq.totalRemoteBalanceSats}
									suffix=" sats"
									sub="inbound"
								/>
							</div>
							<div className="wallet-meta" style={{ marginTop: 10 }}>
								{liq.activeChannelCount}/{liq.channelCount} channels active · capacity{' '}
								{fmtSats(liq.totalCapacitySats)}
							</div>
						</>
					) : (
						<div className="empty">No channels yet. Open one from the Channels tab.</div>
					)}
				</Card>

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
					{fees && (
						<div className="wallet-meta" style={{ marginTop: 10 }}>
							Channel-open advice: {fees.recommendation} · ~{fmtSats(fees.estimatedOpenChannelCostSats)}
						</div>
					)}
				</Card>

				<ConnectCard id={id} info={info} rec={rec} nodeUri={data?.nodeUri} />
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
