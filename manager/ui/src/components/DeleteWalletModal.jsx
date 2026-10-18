import { useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Button, Modal, Note } from './ui.jsx';

/** The one dialog that removes a wallet, reached from a card's menu or the hero's. */
export default function DeleteWalletModal({ wallet, origin, onClose, onDeleted }) {
	const toast = useToast();
	const [purge, setPurge] = useState(false);
	const [busy, setBusy] = useState(false);
	const [refused, setRefused] = useState(null);
	const dependents = refused?.dependents || wallet.lfbwDependents || [];
	return (
		<Modal
			title={`Delete "${wallet.name}"`}
			onClose={onClose}
			origin={origin}
			foot={
				<>
					<Button onClick={onClose}>Cancel</Button>
					<span className="spacer" />
					<Button
						variant="danger"
						busy={busy}
						onClick={async () => {
							setBusy(true);
							try {
								await manager.deleteWallet(wallet.id, purge);
								onDeleted();
							} catch (e) {
								if (e.code === 'PRIMARY_IN_USE') setRefused(e.details || { dependents: [] });
								toast(e.message, 'error');
								setBusy(false);
							}
						}}
						disabled={dependents.length > 0}
					>
						Delete wallet
					</Button>
				</>
			}
		>
			<Note tone="error">
				Deleting removes this wallet from Beignet. If you also erase its data and have not backed up
				the seed, any funds will be lost permanently.
			</Note>
			{dependents.length > 0 && (
				<Note tone="error">
					This wallet is the primary node of {dependents.map((d) => `"${d.name}"`).join(', ')}: their
					home channel, inbound capacity and deposits all run through it. Change their primary node or
					delete them first.
				</Note>
			)}
			<label className="checkbox field">
				<input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
				Also erase wallet data (seed, database) from disk
			</label>
		</Modal>
	);
}
