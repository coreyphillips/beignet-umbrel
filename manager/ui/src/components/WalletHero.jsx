import { NavLink } from 'react-router-dom';
import { m } from 'motion/react';
import { AnimatedNumber, Badge, Button, Menu, Skeleton, StatusBadge } from './ui.jsx';
import { Icon } from './icons.jsx';
import { walletStatusLabel } from '../lib/labels.js';

const TRANSIENT = new Set(['starting', 'restarting', 'stopping', 'waiting-electrum']);

/**
 * The wallet's name, its state, its one balance, and the two things most
 * often done with it. The card on the home page morphs into this (the
 * shared layout ids), so the row of chips and the balance move rather than
 * stretch while the panel grows.
 */
export default function WalletHero({
	id,
	rec,
	info,
	running,
	simple,
	isLfbw,
	advanced,
	onToggleAdvanced,
	chips = [],
	attention = [],
	onEdit,
	onStart,
	onStop,
	onDelete,
	starting = false
}) {
	if (!rec) {
		return (
			<div className="hero hero-skeleton" aria-busy="true">
				<Skeleton height={26} width={220} className="line" />
				<Skeleton height={44} width={320} className="line" />
			</div>
		);
	}

	const status = walletStatusLabel(rec.status);
	const onchain = info?.onchainBalanceSats || 0;
	const lightning = info?.lightningBalanceSats || 0;
	const total = rec.onchainOnly ? onchain : onchain + lightning;
	const stopped = rec.status === 'stopped';
	const menu = [
		{ label: 'Edit wallet', icon: 'edit', onSelect: onEdit },
		stopped || rec.status === 'restore-required'
			? { label: 'Start wallet', icon: 'play', onSelect: onStart, disabled: rec.status === 'restore-required' }
			: { label: 'Stop wallet', icon: 'stop', onSelect: onStop },
		'sep',
		{ label: 'Delete wallet', icon: 'trash', danger: true, onSelect: onDelete }
	];

	return (
		<>
			<m.div layoutId={`wallet-card-${id}`} className="hero">
				<div className="hero-top">
					<m.div layoutId={`wallet-name-${id}`} layout="position">
						<h1>{rec.name}</h1>
					</m.div>
					<m.span layoutId={`wallet-status-${id}`} layout="position">
						<StatusBadge label={status.label} tone={status.tone} raw={rec.status} pulse={TRANSIENT.has(rec.status)} />
					</m.span>
					{chips.length > 0 && (
						<div className="hero-chips">
							{chips.map((c) => (
								<Badge key={c.label} tone={c.tone || 'muted'} chip={c.tone === 'chip' || !c.tone}>
									{c.label}
								</Badge>
							))}
						</div>
					)}
					<div className="hero-end">
						{isLfbw && (
							<button type="button" className="btn subtle sm" onClick={onToggleAdvanced}>
								{advanced ? 'Simple view' : 'Advanced view'}
							</button>
						)}
						<Menu label="Wallet actions" items={menu} />
					</div>
				</div>

				<m.div className="hero-main" layout="position">
					<div>
						{/* No figure until the daemon has one: a stopped or holding wallet
						    has nothing to count, and a placeholder would read as a balance. */}
						{info && (
							<div className="hero-balance">
								<AnimatedNumber value={total} />
								<span className="unit">sats</span>
							</div>
						)}
						<div className="hero-split">
							{info && !simple && !rec.onchainOnly && (
								<>
									<span>
										<AnimatedNumber value={onchain} /> on-chain
									</span>
									<span className="sep">·</span>
									<span>
										<AnimatedNumber value={lightning} /> Lightning
									</span>
								</>
							)}
							{info && simple && <span>One balance, held in your channel with the primary node</span>}
							{info && rec.onchainOnly && <span>On-chain only</span>}
							{!info && rec.electrum && (
								<span>
									Electrum {rec.electrum.host}:{rec.electrum.port}
								</span>
							)}
							{!info && !rec.electrum && <span>Loading…</span>}
						</div>
					</div>
					<div className="hero-actions">
						{running ? (
							<>
								<NavLink to={`/w/${id}/receive`} className="btn primary lg">
									<Icon name="receive" size={16} strokeWidth={2.2} />
									Receive
								</NavLink>
								<NavLink to={`/w/${id}/send`} className="btn lg">
									<Icon name="send" size={16} strokeWidth={2.2} />
									Send
								</NavLink>
							</>
						) : stopped ? (
							<Button variant="primary" size="lg" icon="play" busy={starting} onClick={onStart}>
								Start wallet
							</Button>
						) : null}
					</div>
				</m.div>
			</m.div>
			{attention.length > 0 && (
				<div className="attention">
					{attention.map((a) => (
						<Badge key={a.label} tone={a.tone}>
							{a.label}
						</Badge>
					))}
				</div>
			)}
		</>
	);
}
