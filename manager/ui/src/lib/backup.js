/**
 * The backup archive on the browser's side: handing the file to the
 * downloader, reading one back in, and saying how long ago a wallet was in one.
 */

// The backup dialog lives at the top of the app (it is opened from the header
// and from the empty first-run screen, and outlives both), so the pages ask
// for it the way the settings dialog already broadcasts its result.
export const BACKUP_EVENT = 'beignet:backup';

/** Open the backup dialog in `mode` ('export' or 'restore'). */
export function openBackup(mode, origin) {
	window.dispatchEvent(new CustomEvent(BACKUP_EVENT, { detail: { mode, origin } }));
}

/** Hand a blob to the browser as a download named `filename`. */
export function saveFile(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoking immediately cancels the download in some browsers; a tick is
	// enough for the navigation to have taken the blob.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** An uploaded archive as base64, which is how the manager takes it. */
export async function fileToBase64(file) {
	const bytes = new Uint8Array(await file.arrayBuffer());
	let binary = '';
	// String.fromCharCode takes the whole array as arguments, so a large file
	// would blow the argument limit; 32k at a time stays well under it.
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

/** "3 days ago", "just now", or null when there is no stamp to phrase. */
export function timeAgo(iso, now = Date.now()) {
	const at = Date.parse(iso || '');
	if (!Number.isFinite(at)) return null;
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 90) return 'just now';
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} minutes ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hours ago`;
	return `${Math.round(hours / 24)} days ago`;
}

/** One wallet's backup state, as the list and the wallet header say it. */
export function backupStamp(wallet) {
	if (!wallet) return null;
	if (!wallet.lastBackupAt) return 'never backed up';
	const when = timeAgo(wallet.lastBackupAt);
	return wallet.backupStale ? `changed since the backup ${when}` : `backed up ${when}`;
}

/**
 * The line above the wallet list: when the box was last backed up, and how
 * many wallets have been created or edited since.
 */
export function backupSummary(wallets, lastBackupAt, now = Date.now()) {
	const list = wallets || [];
	const stale = list.filter((w) => w.backupStale);
	const when = timeAgo(lastBackupAt, now);
	if (!when) {
		return {
			stale: stale.length,
			text:
				list.length > 0
					? 'No backup of this box yet. A seed alone does not carry a wallet’s settings, its API token or its guardians.'
					: 'No backup of this box yet.'
		};
	}
	if (stale.length === 0) return { stale: 0, text: `Backed up ${when}.` };
	return {
		stale: stale.length,
		text: `Backed up ${when}, but ${stale.length} wallet${
			stale.length === 1 ? ' has' : 's have'
		} been created or edited since.`
	};
}
