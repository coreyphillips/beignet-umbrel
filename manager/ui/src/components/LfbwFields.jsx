import { Field } from './ui.jsx';

export const EMPTY_LFBW = {
	enabled: false,
	primaryWalletId: '',
	primaryUri: '',
	trusted: true,
	initialChannelSats: ''
};

/** The value the create form and the edit dialog post as `lfbw`. */
export function lfbwBody(value) {
	if (!value || !value.enabled) return { enabled: false };
	const body = { enabled: true, trusted: !!value.trusted };
	if (value.primaryWalletId && value.primaryWalletId !== 'external') {
		body.primaryWalletId = value.primaryWalletId;
		const sats = parseInt(value.initialChannelSats, 10);
		if (sats > 0) body.initialChannelSats = sats;
	} else {
		body.primaryUri = String(value.primaryUri || '').trim();
	}
	return body;
}

/** Whether the block can be posted as it stands. */
export function lfbwComplete(value) {
	if (!value || !value.enabled) return true;
	if (value.primaryWalletId && value.primaryWalletId !== 'external') return true;
	return /^[0-9a-fA-F]{66}@[^:\s]+:\d+$/.test(String(value.primaryUri || '').trim());
}

/** Wallets that may serve as a primary: running, same network, Lightning on, not lightning-first themselves. */
export function primaryCandidates(wallets, { network, selfId } = {}) {
	return (wallets || []).filter(
		(w) =>
			w.id !== selfId &&
			w.status === 'running' &&
			w.network === network &&
			!w.onchainOnly &&
			!(w.lfbw && w.lfbw.enabled)
	);
}

/**
 * The lightning-first block of the create form and the edit dialog: the
 * checkbox, the primary node (one of your own wallets, or an external node
 * URI), the trust option, and the starting channel.
 */
export default function LfbwFields({ value, onChange, candidates, editing = false, currentPrimary = null }) {
	const patch = (next) => onChange({ ...value, ...next });
	const choice = value.primaryWalletId || '';
	return (
		<>
			<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
				Lightning-first
			</div>
			<label className="checkbox field">
				<input type="checkbox" checked={!!value.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
				Make this a lightning-first wallet
			</label>
			{value.enabled && (
				<>
					<div className="info-note">
						One balance, held in a single channel with a primary node. Bitcoin that lands on the
						deposit address moves into that channel by itself once it confirms, invoices are
						payable even before the channel exists (the primary provides the capacity when the
						payment arrives), and sending to a bitcoin address spends from the channel.
						{editing && currentPrimary
							? ` Currently paired with ${currentPrimary}; changing the primary starts the setup over.`
							: ''}
					</div>
					<Field
						label="Primary node"
						hint="One of your own wallets on this Umbrel provides inbound capacity to this wallet from its own on-chain balance; keep it funded."
					>
						<select value={choice} onChange={(e) => patch({ primaryWalletId: e.target.value })}>
							<option value="">Choose a node…</option>
							{candidates.map((w) => (
								<option key={w.id} value={w.id}>
									{w.name} (your wallet, {w.network})
								</option>
							))}
							<option value="external">An external beignet node (pubkey@host:port)</option>
						</select>
					</Field>
					{candidates.length === 0 && (
						<div className="info-note">
							No wallet of yours can serve as primary right now: it must be running, on the same
							network, with Lightning on, and not lightning-first itself.
						</div>
					)}
					{choice === 'external' && (
						<Field label="External node URI" hint="The node must run beignet with JIT receive on to provide inbound capacity.">
							<input
								value={value.primaryUri}
								placeholder="02abc…@node.example:9735"
								onChange={(e) => patch({ primaryUri: e.target.value })}
							/>
						</Field>
					)}
					{choice && choice !== 'external' && (
						<>
							<label className="checkbox field">
								<input type="checkbox" checked={!!value.trusted} onChange={(e) => patch({ trusted: e.target.checked })} />
								Zero-conf both ways (channels usable the moment they are created)
							</label>
							{!value.trusted && (
								<div className="info-note">
									Without zero-conf, every channel and splice between the two waits for a confirmation
									before it can carry payments. Both wallets are yours, so the only risk zero-conf
									takes is your own.
								</div>
							)}
							{!editing && (
								<Field
									label="Starting channel (sats, optional)"
									hint="Opened from the primary right away so this wallet can receive over Lightning at once. Funded from the primary's on-chain balance."
								>
									<input
										value={value.initialChannelSats}
										placeholder="none"
										onChange={(e) => patch({ initialChannelSats: e.target.value.replace(/[^0-9]/g, '') })}
									/>
								</Field>
							)}
						</>
					)}
					{choice === 'external' && (
						<>
							<label className="checkbox field">
								<input type="checkbox" checked={!!value.trusted} onChange={(e) => patch({ trusted: e.target.checked })} />
								Trust this node for zero-conf channels
							</label>
							<div className="info-note">
								{value.trusted
									? 'A channel this node opens to you is usable the moment it is created, which is what lets it provide inbound capacity just in time for a payment. You trust it not to double-spend that funding before it confirms.'
									: 'Without zero-conf trust the node cannot provide inbound capacity just in time: invoices it would have to provision fail. Deposits and direct funding still work, and confirm first.'}
							</div>
						</>
					)}
				</>
			)}
		</>
	);
}

/**
 * The liquidity provider block of the edit dialog: whether this wallet
 * fronts channel funding for lightning-first wallets, at what fee, and
 * within what caps.
 */
export function ProviderFields({ value, jit, swaps = {}, onChange, onJit, onSwaps = () => {}, dependents = [] }) {
	const locked = dependents.length > 0;
	const patchJit = (key, raw) => onJit({ ...jit, [key]: raw });
	const patchSwaps = (key, raw) => onSwaps({ ...swaps, [key]: raw });
	const digits = (e) => e.target.value.replace(/[^0-9]/g, '');
	return (
		<>
			<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
				Liquidity provider
			</div>
			<label className="checkbox field">
				<input type="checkbox" checked={!!value} disabled={locked} onChange={(e) => onChange(e.target.checked)} />
				Provide inbound capacity to lightning-first wallets (JIT receive)
			</label>
			{locked && (
				<div className="info-note">
					Serving as the primary node of {dependents.map((d) => `"${d.name}"`).join(', ')}. Change their
					primary node or delete them before switching this off.
				</div>
			)}
			{value && (
				<>
					<div className="info-note">
						When a wallet asks, this node holds the incoming payment, funds a channel to the wallet
						from its own on-chain balance (or grows the one it has), then forwards the payment
						minus the fee below. Any beignet wallet may ask; the caps bound what is committed.
					</div>
					<div className="row">
						<Field label="Flat fee (sats)">
							<input value={jit.flatFeeSat ?? ''} onChange={(e) => patchJit('flatFeeSat', e.target.value.replace(/[^0-9]/g, ''))} />
						</Field>
						<Field label="Proportional fee (ppm)">
							<input value={jit.feePpm ?? ''} onChange={(e) => patchJit('feePpm', e.target.value.replace(/[^0-9]/g, ''))} />
						</Field>
					</div>
					<div className="row">
						<Field label="Most fronted per client (sats)">
							<input
								value={jit.maxClientFundingSats ?? ''}
								onChange={(e) => patchJit('maxClientFundingSats', e.target.value.replace(/[^0-9]/g, ''))}
							/>
						</Field>
						<Field label="Fundings in flight at once">
							<input
								value={jit.maxConcurrentFundings ?? ''}
								onChange={(e) => patchJit('maxConcurrentFundings', e.target.value.replace(/[^0-9]/g, ''))}
							/>
						</Field>
						<Field label="Lifetime budget (sats, blank for none)">
							<input
								value={jit.maxTotalFundingSats ?? ''}
								placeholder="no limit"
								onChange={(e) => patchJit('maxTotalFundingSats', e.target.value.replace(/[^0-9]/g, ''))}
							/>
						</Field>
					</div>
					<div className="field-label" style={{ marginTop: 12, marginBottom: 8 }}>
						Reverse swaps
					</div>
					<label className="checkbox field">
						<input
							type="checkbox"
							checked={!!swaps.enabled}
							onChange={(e) => patchSwaps('enabled', e.target.checked)}
						/>
						Serve Lightning to on-chain swaps from this wallet's balance
					</label>
					{swaps.enabled && (
						<>
							<div className="info-note">
								A wallet pays this node over Lightning and this node pays the same amount, minus
								the fee below, to an address the wallet chose, from its own on-chain balance.
								The node only settles the Lightning payment once the wallet has claimed the
								coins, and takes them back after the refund height if it never does. The caps
								bound what is committed at once.
							</div>
							<div className="row">
								<Field label="Flat fee (sats)">
									<input value={swaps.flatFeeSat ?? ''} onChange={(e) => patchSwaps('flatFeeSat', digits(e))} />
								</Field>
								<Field label="Proportional fee (ppm)">
									<input value={swaps.feePpm ?? ''} onChange={(e) => patchSwaps('feePpm', digits(e))} />
								</Field>
							</div>
							<div className="row">
								<Field label="Smallest swap (sats)">
									<input value={swaps.minSat ?? ''} onChange={(e) => patchSwaps('minSat', digits(e))} />
								</Field>
								<Field label="Largest swap (sats)">
									<input value={swaps.maxSat ?? ''} onChange={(e) => patchSwaps('maxSat', digits(e))} />
								</Field>
							</div>
							<div className="row">
								<Field label="Most committed at once (sats)">
									<input
										value={swaps.maxExposureSat ?? ''}
										onChange={(e) => patchSwaps('maxExposureSat', digits(e))}
									/>
								</Field>
								<Field label="Swaps in flight at once">
									<input value={swaps.maxConcurrent ?? ''} onChange={(e) => patchSwaps('maxConcurrent', digits(e))} />
								</Field>
							</div>
						</>
					)}
				</>
			)}
		</>
	);
}
