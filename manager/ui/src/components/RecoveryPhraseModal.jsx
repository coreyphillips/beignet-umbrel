import { useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Button, ErrorNote, Modal, SeedWords } from './ui.jsx';
import { copy } from '../lib/format.js';

/**
 * A wallet's recovery phrase, shown again after the create dialog has closed.
 * The words are not asked for until the reader has seen the warning and
 * pressed Show phrase, and they live only in this dialog's state: closing it
 * drops them. The manager logs each read in the wallet's log.
 */
export default function RecoveryPhraseModal({ wallet, origin, onClose }) {
	const toast = useToast();
	const [phrase, setPhrase] = useState(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);

	const reveal = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await manager.recoveryPhrase(wallet.id);
			setPhrase(r.mnemonic);
		} catch (e) {
			setError(e);
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal title={`Recovery phrase for "${wallet.name}"`} onClose={onClose} origin={origin}>
			<div className="error-note">
				Anyone who sees these words can take every coin in this wallet. Show them only where no one
				can see your screen, and never type them into a website or give them to anyone who asks.
			</div>
			<div className="info-note" style={{ marginTop: 10 }}>
				{wallet.onchainOnly
					? 'Importing this phrase brings back the wallet and its on-chain funds.'
					: "Importing this phrase brings back the wallet's on-chain funds and its Lightning node. Channels also depend on the channel backup shown on the Overview tab: from the phrase alone, they close and their funds return on-chain."}
			</div>
			{phrase && <SeedWords mnemonic={phrase} />}
			<ErrorNote error={error} />
			<div className="center-actions">
				{phrase ? (
					<>
						<Button
							onClick={async () => {
								const ok = await copy(phrase);
								toast(ok ? 'Seed copied' : 'Copy failed', ok ? 'info' : 'error');
							}}
						>
							Copy phrase
						</Button>
						<Button variant="primary" onClick={onClose}>
							Done
						</Button>
					</>
				) : (
					<>
						<Button variant="primary" busy={busy} onClick={reveal} data-testid="reveal-phrase">
							Show phrase
						</Button>
						<Button onClick={onClose}>Cancel</Button>
					</>
				)}
			</div>
		</Modal>
	);
}
