/**
 * The per-wallet "serve as guardian" toggle (beignet #699): this wallet's
 * daemon hosts the reference guardian at its Lightning address, so other
 * beignet nodes can pin it as one of their three guardians. Open to any
 * beignet node, with the engine's quotas bounding what a stranger can store.
 *
 * Shared by the create form and the edit dialog so both read the same, and
 * only offered for a Lightning wallet on an engine that has the surface.
 */
export default function GuardianServeField({ value, onChange, disabled = false, announce = false }) {
	return (
		<>
			<label className="checkbox field">
				<input
					type="checkbox"
					checked={!!value}
					disabled={disabled}
					data-testid="guardian-serve"
					onChange={(e) => onChange(e.target.checked)}
				/>
				Serve as a guardian for other beignet nodes
			</label>
			<div className="info-note">
				{value
					? 'Other beignet wallets can pin this node as one of their three guardians and store an encrypted journal of their channel state here, over a dedicated session at this node’s Lightning address. The journal is opaque to this node. Quotas bound how much is kept, and a full quota refuses new writes rather than deleting anything a stranger’s node still depends on.' +
					  (announce
							? ' The address to share is on the Overview tab once the wallet is running.'
							: ' Turn on the Tor address below so nodes outside this Umbrel can reach it.')
					: 'Off: this node holds no channel state for anyone else. Turn it on to take part in a guardian pool; a node you guard depends on this wallet staying online, so pick a wallet that is.'}
			</div>
		</>
	);
}
