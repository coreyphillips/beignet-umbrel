import { Button, Field, Help } from './ui.jsx';

const VIA_OPTIONS = [
	{ value: 'default', label: "Follow this wallet's network mode" },
	{ value: 'tor', label: 'Always through Tor' },
	{ value: 'direct', label: 'Always direct' }
];

/**
 * Porch relays for one wallet: each relay URL with its own registration
 * token. A saved token is never shown again; it can be replaced or removed.
 */
export default function PorchField({ enabled, onEnabled, via, onVia, rows, onRows, source, torAvailable = false }) {
	const set = (i, patch) => onRows(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
	return (
		<>
			<label className="checkbox field">
				<input type="checkbox" data-testid="porch-enabled" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
				Porch relay link
				<Help>
					Porch lets this wallet wait at a relay you name, so the peer link you hand out names the relay and not
					this Umbrel. Whoever holds the link learns the relay, not your IP address. The relay&apos;s operator still
					sees this Umbrel&apos;s address unless relay connections go through Tor. Other peers keep using the selected
					network mode.
				</Help>
			</label>
			{source === 'native' && (
				<div className="info-note" data-testid="porch-native">
					This wallet&apos;s config file sets these relays by hand. Saving here takes them over, keeping their tokens.
				</div>
			)}
			{enabled && (
				<div className="field" data-testid="porch-relays">
					{rows.map((row, i) => (
						<div key={i} style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
							<Field label={`Relay ${i + 1} URL`} hint="The relay's base URL. The node adds the paths it needs.">
								<input
									data-testid="porch-relay-url"
									value={row.url}
									// A saved token belongs to the URL it was saved with.
								onChange={(e) => set(i, { url: e.target.value, hasToken: !!row.savedToken && e.target.value.trim() === row.savedUrl })}
									placeholder="wss://relay.example.com"
								/>
							</Field>
							<Field
								label="Registration token"
								hint={
									row.hasToken && !row.removeToken
										? 'A token is saved. Type a new one to replace it.'
										: row.removeToken
											? 'The saved token is removed when you save.'
											: 'Only for a private relay. Leave blank for a public one.'
								}
							>
								<input
									type="password"
									autoComplete="off"
									data-testid="porch-relay-token"
									value={row.token}
									onChange={(e) => set(i, { token: e.target.value, removeToken: false })}
									placeholder={row.hasToken && !row.removeToken ? 'Saved' : ''}
								/>
							</Field>
							<div style={{ display: 'flex', gap: 6 }}>
								{row.hasToken && (
									<Button className="sm" data-testid="porch-token-remove" onClick={() => set(i, { removeToken: !row.removeToken, token: '' })}>
										{row.removeToken ? 'Keep saved token' : 'Remove token'}
									</Button>
								)}
								<Button className="sm" data-testid="porch-relay-remove" onClick={() => onRows(rows.filter((_, j) => j !== i))}>
									Remove relay
								</Button>
							</div>
						</div>
					))}
					{rows.length < 8 && (
						<Button
							className="sm"
							data-testid="porch-relay-add"
							onClick={() => onRows([...rows, { url: '', token: '', hasToken: false, removeToken: false }])}
						>
							Add relay
						</Button>
					)}
					<Field label="Relay connection" hint="How this wallet reaches its relays. Through Tor the relay does not see this Umbrel's IP address, at the cost of about a second per payment.">
						<select data-testid="porch-via" value={via} onChange={(e) => onVia(e.target.value)}>
							{VIA_OPTIONS.filter((o) => o.value !== 'tor' || torAvailable || via === 'tor').map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
						</select>
					</Field>
				</div>
			)}
		</>
	);
}
