import { useState } from 'react';
import { Field } from './ui.jsx';

/**
 * The per-wallet FFOR roles (beignet #729): settle offline receives for
 * siblings (the settlement peer S), keep receipt witnesses' encrypted
 * records for them (a witness W), and answer BOLT 12 requests for payers
 * who hold no invoice (the issuer, co-hosted with the witness). Each is an
 * explicit opt-in; a settling epoch locks the whole budget of the book on
 * this wallet's side of the channel until it closes.
 *
 * `value` is the record's ffor block ({ settle, witness, issuer }); the
 * caller gets the whole block back on every change. Shared by the create
 * form and the edit dialog so both read the same, and only offered for a
 * Lightning wallet on an engine that has the surface.
 */
export default function FforSettleField({ value, onChange, disabled = false }) {
	const block = value || {};
	const settle = block.settle || {};
	const witness = block.witness || {};
	const issuer = block.issuer || {};
	const funding = block.funding || {};
	const patchFunding = (key, raw) => onChange({ ...block, funding: { ...funding, [key]: raw } });
	const [advanced, setAdvanced] = useState(false);
	const patchSettle = (key, raw) =>
		onChange({
			...block,
			settle: { ...settle, [key]: raw },
			funding: key === 'enabled' && !raw ? { ...funding, enabled: false } : funding
		});
	const patchWitness = (key, raw) => {
		const next = { ...witness, [key]: raw };
		// The issuer runs on the witness: dropping the witness drops it too.
		onChange({ ...block, witness: next, issuer: key === 'enabled' && !raw ? { ...issuer, enabled: false } : issuer });
	};
	const patchIssuer = (raw) => onChange({ ...block, issuer: { ...issuer, enabled: raw } });
	const digits = (e) => e.target.value.replace(/[^0-9]/g, '');
	return (
		<>
			<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
				Offline receive
			</div>
			<label className="checkbox field">
				<input
					type="checkbox"
					checked={!!settle.enabled}
					disabled={disabled}
					data-testid="ffor-settle"
					onChange={(e) => patchSettle('enabled', e.target.checked)}
				/>
				Settle offline receives for sibling wallets
			</label>
			<div className="info-note">
				{settle.enabled
					? 'A sibling wallet with a channel to this one can pre-sign a book of fixed-amount vouchers here before it goes offline. While it is away, this wallet settles payments to those vouchers at once from its own side of the channel, and the sibling collects them when it returns. Each book locks its whole amount on this side of the channel until the sibling closes it; the caps below bound what one book may ask for.'
					: 'Off: this wallet settles no offline receives for anyone. Turn it on for a wallet that stays online, such as the primary node of your lightning-first wallets; the sibling picks it from its Receive tab.'}
			</div>
			{settle.enabled && (
				<>
					<label className="checkbox field">
						<input
							type="checkbox"
							checked={!!funding.enabled}
							disabled={disabled}
							data-testid="ffor-funding"
							onChange={(e) => patchFunding('enabled', e.target.checked)}
						/>
						Fund channels for automatic receiving
					</label>
					<div className="info-note">
						Allow connected wallets, including external clients, to request channels funded by this node. Limits are
						cumulative across restarts and include failed allocations.
					</div>
					{funding.enabled && (
						<div className="row">
							{[
								['maxChannels', 'Total channel limit', 20],
								['maxChannelsPerPeer', 'Channels per wallet', 5],
								['maxChannelSats', 'Largest channel (sats)', 1000000],
								['maxTotalSats', 'Total funding budget (sats)', 5000000]
							].map(([key, label, fallback]) => (
								<Field key={key} label={label}>
									<input
										disabled={disabled}
										inputMode="numeric"
										value={funding[key] ?? fallback}
										onChange={(e) => patchFunding(key, digits(e))}
									/>
								</Field>
							))}
						</div>
					)}
				</>
			)}

			<label className="checkbox field">
				<input
					type="checkbox"
					checked={!!witness.enabled}
					disabled={disabled}
					data-testid="ffor-witness"
					onChange={(e) => patchWitness('enabled', e.target.checked)}
				/>
				Keep receipts for sibling wallets receiving offline (witness)
			</label>
			<div className="info-note">
				{witness.enabled
					? 'A sibling going offline can name this wallet as a receipt witness: payments to its vouchers route through this wallet, which stores an encrypted receipt of each one before passing it on, so the sibling can collect what it was paid even if its settlement peer disappears. The receipts are opaque to this wallet, and it needs a channel toward the settlement peer to sit on the path.'
					: 'Off: this wallet keeps no receipts for anyone. Turn it on for a wallet that stays online and has a channel to the settlement peer.'}
			</div>
			<label className="checkbox field">
				<input
					type="checkbox"
					checked={!!issuer.enabled}
					disabled={disabled || !witness.enabled}
					data-testid="ffor-issuer"
					onChange={(e) => patchIssuer(e.target.checked)}
				/>
				Issue invoices for sibling wallets receiving offline (issuer)
			</label>
			<div className="info-note">
				{!witness.enabled
					? 'The issuer runs on a receipt witness: turn the witness on first.'
					: issuer.enabled
					? 'A sibling going offline can hand this wallet a BOLT 12 offer: a payer who holds no invoice asks this wallet for one, and it answers with the invoice for the next unused voucher of the book, one per request, until the book runs out.'
					: 'Off: payers need an invoice the sibling handed out before leaving. Turn it on to answer BOLT 12 requests from payers who hold none.'}
			</div>
			{(settle.enabled || witness.enabled) && (
				<>
					<button
						type="button"
						className="wnav-toggle"
						onClick={() => setAdvanced((v) => !v)}
						style={{ marginBottom: 8 }}>
						{advanced ? 'Hide limits' : 'Limits and fees'}
					</button>
					{advanced && settle.enabled && (
						<>
							<div className="row">
								<Field label="Largest book (msat, blank for no cap)">
									<input
										value={settle.maxBudgetMsat ?? ''}
										placeholder="no cap"
										onChange={(e) => patchSettle('maxBudgetMsat', digits(e))}
									/>
								</Field>
								<Field label="Longest epoch (blocks, blank for no cap)">
									<input
										value={settle.maxEpochBlocks ?? ''}
										placeholder="no cap"
										onChange={(e) => patchSettle('maxEpochBlocks', digits(e))}
									/>
								</Field>
							</div>
							<div className="row">
								<Field label="Fee floor per voucher (msat)">
									<input value={settle.feeBaseMsat ?? ''} onChange={(e) => patchSettle('feeBaseMsat', digits(e))} />
								</Field>
								<Field label="Fee floor (ppm)">
									<input value={settle.feePpm ?? ''} onChange={(e) => patchSettle('feePpm', digits(e))} />
								</Field>
							</div>
							<div className="field-hint">
								A book offering fees under either floor is refused. Left at zero, siblings pay nothing for the service.
							</div>
						</>
					)}
					{advanced && witness.enabled && (
						<div className="row">
							<Field label="Most mailboxes kept (blank for the engine default)">
								<input
									value={witness.maxMailboxes ?? ''}
									placeholder="default"
									onChange={(e) => patchWitness('maxMailboxes', digits(e))}
								/>
							</Field>
							<Field label="Most bytes kept (blank for the engine default)">
								<input
									value={witness.maxBytes ?? ''}
									placeholder="default"
									onChange={(e) => patchWitness('maxBytes', digits(e))}
								/>
							</Field>
						</div>
					)}
				</>
			)}
		</>
	);
}
