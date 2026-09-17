import { useState } from 'react';
import { Field } from './ui.jsx';

/**
 * The per-wallet "settle offline receives" toggle (FFOR, beignet #729): this
 * wallet's daemon answers a sibling's request to pre-sign a voucher book on
 * their channel, then settles payers' HTLCs against it while the sibling is
 * offline. An epoch locks the whole budget of the book on this wallet's side
 * of the channel until it closes, so it is an explicit opt-in with caps.
 *
 * Shared by the create form and the edit dialog so both read the same, and
 * only offered for a Lightning wallet on an engine that has the surface.
 */
export default function FforSettleField({ value, onChange, disabled = false }) {
	const settle = value || {};
	const [advanced, setAdvanced] = useState(false);
	const patch = (key, raw) => onChange({ ...settle, [key]: raw });
	const digits = (e) => e.target.value.replace(/[^0-9]/g, '');
	return (
		<>
			<label className="checkbox field">
				<input
					type="checkbox"
					checked={!!settle.enabled}
					disabled={disabled}
					data-testid="ffor-settle"
					onChange={(e) => patch('enabled', e.target.checked)}
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
					<button type="button" className="wnav-toggle" onClick={() => setAdvanced((v) => !v)} style={{ marginBottom: 8 }}>
						{advanced ? 'Hide limits' : 'Limits and fees'}
					</button>
					{advanced && (
						<>
							<div className="row">
								<Field label="Largest book (msat, blank for no cap)">
									<input value={settle.maxBudgetMsat ?? ''} placeholder="no cap" onChange={(e) => patch('maxBudgetMsat', digits(e))} />
								</Field>
								<Field label="Longest epoch (blocks, blank for no cap)">
									<input value={settle.maxEpochBlocks ?? ''} placeholder="no cap" onChange={(e) => patch('maxEpochBlocks', digits(e))} />
								</Field>
							</div>
							<div className="row">
								<Field label="Fee floor per voucher (msat)">
									<input value={settle.feeBaseMsat ?? ''} onChange={(e) => patch('feeBaseMsat', digits(e))} />
								</Field>
								<Field label="Fee floor (ppm)">
									<input value={settle.feePpm ?? ''} onChange={(e) => patch('feePpm', digits(e))} />
								</Field>
							</div>
							<div className="field-hint">
								A book offering fees under either floor is refused. Left at zero, siblings pay nothing for the service.
							</div>
						</>
					)}
				</>
			)}
		</>
	);
}
