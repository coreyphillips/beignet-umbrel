import { usePoll } from '../../hooks/usePoll.js';
import { Badge, Card, Stat } from '../../components/ui.jsx';
import { fmtSats, pct } from '../../lib/format.js';

const CHECK_TONE = { PASS: 'green', WARN: 'yellow', FAIL: 'red' };

export default function OverviewTab({ id, api, info, health, tick }) {
	const { data } = usePoll(
		async () => {
			const [balance, readiness, liquidity, fees] = await Promise.all([
				api.get('/balance').catch(() => null),
				api.get('/readiness').catch(() => null),
				api.get('/liquidity').catch(() => null),
				api.get('/fees').catch(() => null)
			]);
			return { balance, readiness, liquidity, fees };
		},
		10000,
		[id, tick]
	);

	const bal = data?.balance;
	const liq = data?.liquidity;
	const fees = data?.fees;
	const readiness = data?.readiness;

	return (
		<div>
			<div className="grid cols-4" style={{ marginBottom: 18 }}>
				<Stat label="On-chain" value={fmtSats(bal?.onchain ?? info?.onchainBalanceSats)} />
				<Stat label="Lightning" value={fmtSats(bal?.lightning ?? info?.lightningBalanceSats)} />
				<Stat label="Total" value={fmtSats(bal?.total)} />
				<Stat
					label="Channels"
					value={info?.channelCount ?? '-'}
					sub={`${info?.peerCount ?? 0} peers`}
				/>
			</div>

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
								<span>◆ Outbound {pct(liq.outboundLiquidityPct)} · {fmtSats(liq.totalLocalBalanceSats)}</span>
								<span>Inbound {pct(liq.inboundLiquidityPct)} · {fmtSats(liq.totalRemoteBalanceSats)} ◆</span>
							</div>
							<div className="wallet-meta" style={{ marginTop: 10 }}>
								{liq.activeChannelCount}/{liq.channelCount} channels active · capacity{' '}
								{fmtSats(liq.totalCapacitySats)}
							</div>
							{liq.recommendations?.map((r, i) => (
								<div key={i} className="info-note" style={{ marginTop: 10 }}>
									{r.reason}
								</div>
							))}
						</>
					) : (
						<div className="empty">No channels yet. Open one from the Channels tab.</div>
					)}
				</Card>

				<Card title="Fee advisor">
					{fees ? (
						<div className="grid cols-2">
							<Stat label="Current" value={`${fees.currentSatPerVbyte} sat/vB`} sub={`trend ${fees.trend}`} />
							<Stat label="Recommendation" value={fees.recommendation} sub={`open cost ~${fmtSats(fees.estimatedOpenChannelCostSats)}`} />
						</div>
					) : (
						<div className="empty">Fee data not available yet.</div>
					)}
				</Card>

				<Card title="Mainnet readiness">
					{readiness ? (
						<>
							<div className="wallet-title" style={{ marginBottom: 10 }}>
								<div className="stat-value">{readiness.score}/100</div>
								<Badge tone={readiness.ready ? 'green' : 'yellow'}>
									{readiness.ready ? 'ready' : 'not ready'}
								</Badge>
							</div>
							{readiness.checks?.slice(0, 6).map((c, i) => (
								<div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
									<Badge tone={CHECK_TONE[c.status] || 'muted'}>{c.status}</Badge>
									<span className="wallet-meta">{c.message || c.name}</span>
								</div>
							))}
						</>
					) : (
						<div className="empty">Readiness report unavailable.</div>
					)}
				</Card>
			</div>
		</div>
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
