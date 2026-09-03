/**
 * The one-time question a peer-storage import asks (beignet #690): is the
 * previous device stopped? With the answer the daemon applies the newest
 * checkpoint its peers return by itself, on an empty database, and the
 * channels come back held. Without it the wallet keeps offering the restore
 * from a card, as before.
 *
 * Shared by the import form and the edit dialog so both read the same, and
 * only ever shown under peer storage: the daemon refuses to start with the
 * flag under any other mode, and the manager drops it there.
 */
export default function RecoveryAutoApplyField({ value, onChange, disabled = false }) {
	return (
		<>
			<label className="checkbox field">
				<input
					type="checkbox"
					checked={!!value}
					disabled={disabled}
					data-testid="recovery-auto-apply"
					onChange={(e) => onChange(e.target.checked)}
				/>
				The previous device is stopped. Restore my channels from my peers' copies automatically.
			</label>
			<div className="info-note">
				{value
					? 'When this wallet is empty and a peer returns a checkpoint for this seed, the newest one is applied by itself and the channels come back held: no new payments in until each peer confirms them, and closing one means accepting that a peer may hold a newer state. Nothing fences the old device in this mode: if the previous device is still running, both act on the same channels and a peer closes them.'
					: 'Leave this off if the previous device may still be running. A checkpoint a peer returns is then offered on the wallet page instead of applied by itself. Nothing fences the old device in this mode.'}
			</div>
		</>
	);
}
