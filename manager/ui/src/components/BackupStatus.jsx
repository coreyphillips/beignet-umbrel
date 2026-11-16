import { backupStamp, backupSummary } from '../lib/backup.js';
import { assetsBackupGap, assetsLeftOut } from '../lib/wallet-assets.js';

/**
 * How current the box's backup is: when the last archive was written, and
 * where each wallet stands against it. It lives in Settings, beside the
 * buttons that act on it, rather than above the wallet list, where it sat in
 * front of everything else on every visit.
 *
 * A wallet's assets are in an archive only if the wallet had written them out
 * when it was made, and a recovery phrase does not bring them back. So a
 * wallet whose assets the last archive does not hold is named here with the
 * reason, in the same yellow as one edited since.
 *
 * `wallets` is null while the list is still being read.
 */
export default function BackupStatus({ wallets, lastBackupAt }) {
	if (!wallets) return <div className="wallet-meta" style={{ marginBottom: 12 }}>Reading the wallets…</div>;
	const summary = backupSummary(wallets, lastBackupAt);
	const leftOut = assetsLeftOut(wallets);
	return (
		<>
			<div className={summary.stale > 0 || leftOut.length > 0 ? 'error-note' : 'info-note'} data-testid="backup-summary">
				{summary.text}
				{leftOut.length > 0 && (
					<span data-testid="backup-assets-summary">
						{' '}
						It does not hold the assets of {leftOut.length === 1 ? `"${leftOut[0].name}"` : `${leftOut.length} wallets`}.
					</span>
				)}
			</div>
			{wallets.length > 0 && (
				<ul className="backup-list" data-testid="backup-list">
					{wallets.map((w) => {
						// "never backed up" already says a wallet with no stamp is in
						// no archive; its assets are not a second thing to say.
						const gap = assetsBackupGap(w);
						const said = gap && gap.code !== 'never' ? gap : null;
						return (
							<li key={w.id} className={w.backupStale || said ? 'stale' : ''} data-testid={`backup-stamp-${w.id}`}>
								<span className="backup-name">{w.name}</span>
								<span className="backup-when">{backupStamp(w)}</span>
								{said && (
									<span className="backup-assets" data-testid={`backup-assets-${w.id}`}>
										{said.text}
									</span>
								)}
							</li>
						);
					})}
				</ul>
			)}
		</>
	);
}
