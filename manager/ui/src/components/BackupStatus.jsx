import { backupStamp, backupSummary } from '../lib/backup.js';

/**
 * How current the box's backup is: when the last archive was written, and
 * where each wallet stands against it. It lives in Settings, beside the
 * buttons that act on it, rather than above the wallet list, where it sat in
 * front of everything else on every visit.
 *
 * `wallets` is null while the list is still being read.
 */
export default function BackupStatus({ wallets, lastBackupAt }) {
	if (!wallets) return <div className="wallet-meta" style={{ marginBottom: 12 }}>Reading the wallets…</div>;
	const summary = backupSummary(wallets, lastBackupAt);
	return (
		<>
			<div className={summary.stale > 0 ? 'error-note' : 'info-note'} data-testid="backup-summary">
				{summary.text}
			</div>
			{wallets.length > 0 && (
				<ul className="backup-list" data-testid="backup-list">
					{wallets.map((w) => (
						<li key={w.id} className={w.backupStale ? 'stale' : ''} data-testid={`backup-stamp-${w.id}`}>
							<span className="backup-name">{w.name}</span>
							<span className="backup-when">{backupStamp(w)}</span>
						</li>
					))}
				</ul>
			)}
		</>
	);
}
