import { useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Button, Field, Modal } from './ui.jsx';
import { fileToBase64, saveFile } from '../lib/backup.js';

// The manager refuses a shorter one; saying so before the request is made
// keeps the rule in front of the person typing it.
const MIN_PASSPHRASE = 8;

// Both directions change app-level config (the box's backup stamp, and on a
// restore the defaults themselves), which pages hold from their own /config
// call. This is the event the Settings dialog already uses to refresh them.
async function announceConfig() {
	try {
		window.dispatchEvent(new CustomEvent('beignet:config', { detail: await manager.config() }));
	} catch (_) {
		/* the next poll or reload picks it up */
	}
}

/**
 * The archive that carries this box: every wallet's seed, API token and
 * record, plus the app settings, under one passphrase. Two directions, one
 * dialog: writing one out, and putting one back on a box that may be empty.
 */
export default function BackupModal({ mode = 'export', origin, onClose, onRestored }) {
	return (
		<Modal
			title={mode === 'restore' ? 'Restore from backup' : 'Back up all wallets'}
			onClose={onClose}
			origin={origin}
		>
			{mode === 'restore' ? (
				<RestorePanel onClose={onClose} onRestored={onRestored} />
			) : (
				<ExportPanel />
			)}
		</Modal>
	);
}

function ExportPanel() {
	const toast = useToast();
	const [passphrase, setPassphrase] = useState('');
	const [again, setAgain] = useState('');
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(null);
	const short = passphrase.length > 0 && passphrase.length < MIN_PASSPHRASE;
	const mismatch = again.length > 0 && again !== passphrase;
	const ready = passphrase.length >= MIN_PASSPHRASE && again === passphrase;

	const run = async () => {
		setBusy(true);
		try {
			const { blob, filename } = await manager.exportBackup(passphrase);
			saveFile(blob, filename);
			setSaved(filename);
			setPassphrase('');
			setAgain('');
			await announceConfig();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	if (saved) {
		return (
			<>
				<div className="info-note" data-testid="backup-saved">
					Saved <code>{saved}</code>. Keep it somewhere this box is not, and keep the passphrase
					somewhere else again: without it the archive is unreadable, and nothing here can reset it.
				</div>
				<div className="center-actions">
					<Button onClick={() => setSaved(null)}>Make another</Button>
				</div>
			</>
		);
	}

	return (
		<>
			<div className="info-note">
				One encrypted file holding every wallet on this box: its recovery phrase, its API token,
				its record (network, Electrum server, Tor, channel backup mode and guardians, the
				lightning-first link) and the app defaults. Channel databases are not in it; channels come
				back through the seed and each wallet&apos;s own channel backup.
			</div>
			<Field
				label="Passphrase"
				hint={`At least ${MIN_PASSPHRASE} characters. The archive is only as safe as this.`}
			>
				<input
					type="password"
					value={passphrase}
					data-testid="backup-passphrase"
					autoComplete="new-password"
					onChange={(e) => setPassphrase(e.target.value)}
				/>
			</Field>
			<Field label="Passphrase again">
				<input
					type="password"
					value={again}
					data-testid="backup-passphrase-again"
					autoComplete="new-password"
					onChange={(e) => setAgain(e.target.value)}
				/>
			</Field>
			{short && <div className="error-note">A passphrase shorter than {MIN_PASSPHRASE} characters is refused.</div>}
			{mismatch && <div className="error-note">The two passphrases do not match.</div>}
			<div className="center-actions">
				<Button variant="primary" busy={busy} disabled={!ready} data-testid="backup-export" onClick={run}>
					Create backup
				</Button>
			</div>
		</>
	);
}

function RestorePanel({ onClose, onRestored }) {
	const toast = useToast();
	const [archive, setArchive] = useState(null); // { name, base64 }
	const [passphrase, setPassphrase] = useState('');
	const [preview, setPreview] = useState(null);
	const [confirm, setConfirm] = useState(false);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(null);

	const pick = async (file) => {
		setPreview(null);
		setConfirm(false);
		if (!file) return setArchive(null);
		try {
			setArchive({ name: file.name, base64: await fileToBase64(file) });
		} catch (e) {
			toast(`That file could not be read (${e.message})`, 'error');
		}
	};

	const open = async () => {
		setBusy(true);
		try {
			setPreview(await manager.inspectBackup(passphrase, archive.base64));
			setConfirm(false);
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	const restore = async () => {
		setBusy(true);
		try {
			setDone(await manager.restoreBackup(passphrase, archive.base64, confirm));
			await announceConfig();
			if (onRestored) onRestored();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	if (done) {
		return (
			<>
				<div className="info-note" data-testid="restore-done">
					Restored {done.restored.length} wallet{done.restored.length === 1 ? '' : 's'}. They are
					stopped: start each one when you are sure the box it came from is not still running it.
					A restored wallet then syncs from the chain like an imported seed and runs its own
					channel backup.
				</div>
				<div className="center-actions">
					<Button variant="primary" onClick={onClose}>
						Done
					</Button>
				</div>
			</>
		);
	}

	const restorable = preview ? preview.wallets.filter((w) => w.action === 'restore') : [];
	const blocked = preview && preview.conflicts.length > 0 && !confirm;

	return (
		<>
			<div className="info-note">
				Reads an archive made by &ldquo;Back up all wallets&rdquo; and recreates the wallets it
				holds, with their settings. Nothing is started: each wallet waits until you start it.
			</div>
			<Field label="Backup file">
				<input
					type="file"
					accept=".beignet"
					data-testid="restore-file"
					onChange={(e) => pick(e.target.files && e.target.files[0])}
				/>
			</Field>
			<Field label="Passphrase">
				<input
					type="password"
					value={passphrase}
					data-testid="restore-passphrase"
					autoComplete="off"
					onChange={(e) => {
						setPassphrase(e.target.value);
						setPreview(null);
					}}
				/>
			</Field>
			{!preview && (
				<div className="center-actions">
					<Button
						variant="primary"
						busy={busy}
						disabled={!archive || !passphrase}
						data-testid="restore-open"
						onClick={open}
					>
						Open backup
					</Button>
				</div>
			)}
			{preview && (
				<>
					<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
						This archive
					</div>
					<div className="wallet-meta" data-testid="restore-provenance">
						Written {preview.createdAt ? new Date(preview.createdAt).toLocaleString() : 'at an unknown time'}
						{preview.app ? ` by Beignet ${preview.app}` : ''}
						{preview.engine ? ` on engine ${preview.engine}` : ''}.
					</div>
					<ul className="guardian-list" data-testid="restore-wallets">
						{preview.wallets.map((w) => (
							<li key={w.id}>
								{w.name} <span className="wallet-meta">({w.network}{w.onchainOnly ? ', on-chain only' : ''})</span>
								{w.action === 'present' && <span className="wallet-meta"> · already on this box</span>}
								{w.action === 'incomplete' && (
									<span className="wallet-meta"> · no seed in the archive, cannot be restored</span>
								)}
								{w.duplicateOf && (
									<span className="wallet-meta"> · same node as &ldquo;{w.duplicateOf.name}&rdquo; here</span>
								)}
							</li>
						))}
					</ul>
					{preview.conflicts.length > 0 && (
						<>
							<div className="error-note" role="alert">
								{preview.conflicts.length === 1 ? 'A wallet' : `${preview.conflicts.length} wallets`} in
								this archive already {preview.conflicts.length === 1 ? 'runs' : 'run'} here under
								another record. Two records on one seed both think they own its channels, and that
								is how channel funds are lost. Restore only if you know the other record is not the
								same wallet.
							</div>
							<label className="checkbox field">
								<input
									type="checkbox"
									checked={confirm}
									data-testid="restore-confirm"
									onChange={(e) => setConfirm(e.target.checked)}
								/>
								Restore anyway, on a seed this box already holds
							</label>
						</>
					)}
					{preview.settings && (
						<div className="info-note">
							The app defaults in the archive (network, Electrum server, recovery guardians) replace
							the ones on this box.
						</div>
					)}
					<div className="center-actions">
						<Button
							variant="primary"
							busy={busy}
							disabled={restorable.length === 0 || blocked}
							data-testid="restore-run"
							onClick={restore}
						>
							{restorable.length === 0
								? 'Nothing to restore'
								: `Restore ${restorable.length} wallet${restorable.length === 1 ? '' : 's'}`}
						</Button>
					</div>
				</>
			)}
		</>
	);
}
