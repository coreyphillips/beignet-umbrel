/**
 * Taproot Assets as the rest of the dashboard sees them (docs/ASSETS.md): the
 * judgements the Overview, Activity, Settings, the wallet list and the wallet
 * dialogs make about a wallet's assets, away from the Assets tab itself.
 *
 * Nothing here asks the wallet anything. Each function is given what a page
 * already holds: the app's config, a wallet's record, its asset rows.
 */
import { fmtAsset } from './asset-amount.js';

/**
 * Whether anything about assets is shown for this wallet at all: the app has
 * an assets host, and the wallet has not switched assets off.
 */
export function assetsShown(config, rec) {
	return !!(config && config.assetsAvailable) && !(rec && rec.assets && rec.assets.enabled === false);
}

/* ------------------------------------------------- anchor transactions */

// The operations that put a transaction on chain. A Lightning row has none.
const ON_CHAIN = ['mint', 'send', 'receive', 'burn'];

const ANCHOR_LABEL = { mint: 'Asset mint', send: 'Asset send', receive: 'Asset receive', burn: 'Asset burn' };

/**
 * txid -> the asset row that transaction carries. On chain an asset
 * transaction is an ordinary taproot spend, so the wallet's own history
 * cannot tell it from a payment: the asset rows are what know.
 */
export function anchorIndex(rows) {
	const index = new Map();
	for (const row of rows || []) {
		if (!row || !row.txid || !ON_CHAIN.includes(row.kind)) continue;
		// Rows arrive newest first, and one transaction is one operation.
		if (!index.has(row.txid)) index.set(row.txid, row);
	}
	return index;
}

/** "Asset send", "Asset mint": what the transaction is, in a badge. */
export const anchorLabel = (row) => ANCHOR_LABEL[row && row.kind] || 'Asset transfer';

/** The asset the Assets tab opens for this row, or null when it names none. */
export function anchorAssetKey(row) {
	const first = row && Array.isArray(row.assets) ? row.assets[0] : null;
	return first ? first.key || first.assetId || null : null;
}

/** "300.00 BUSD", or "10 Alpha and 20 Beta" for a mint of several. */
export function anchorAmounts(row) {
	const parts = ((row && row.assets) || []).filter((a) => a && a.amount != null).map((a) => fmtAsset(a.amount, a));
	if (parts.length <= 1) return parts[0] || '';
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Whether Bump fee may be offered for an unconfirmed transaction.
 *
 * Replacing an asset transaction gives it a new id, and the proof the wallet
 * is waiting to build names the old one, so the ordinary fee bump must never
 * be offered for one. That makes "I do not know yet" a reason to withhold it
 * too: while a wallet has assets in play and their rows have not been read,
 * no pending transaction can be told from an asset's.
 *
 *   'yes'      an ordinary transaction
 *   'asset'    it carries an asset operation
 *   'unknown'  the asset rows are not in hand, and the wallet has assets
 */
export function bumpVerdict(txid, { anchors, known, atStake } = {}) {
	if (anchors && anchors.has(txid)) return 'asset';
	if (!known && atStake) return 'unknown';
	return 'yes';
}

export const NO_ASSET_BUMP = 'Asset transactions cannot be fee bumped yet.';

/* ------------------------------------------------------------- backup */

/**
 * What stands between a wallet's assets and the box backup, or null when
 * there is nothing to say: it holds none, or the last backup has them.
 *
 * A recovery phrase alone does not bring assets back, so a wallet that holds
 * some and is not in a backup with them is worth a line wherever backups are
 * talked about. `text` is that line.
 *
 *   'too-large'  its assets file would have made the archive too large
 *   'no-file'    it had no assets file when the last archive was written
 *   'unwritten'  the file an archive carries does not exist right now
 *   'never'      the box has never been backed up with this wallet in it
 */
export function assetsBackupGap(wallet) {
	const assets = wallet && wallet.assets;
	if (!assets || !assets.holdsAssets) return null;
	if (assets.notArchived === 'too-large') {
		return {
			code: 'too-large',
			text: `Assets not in the last backup: their file is too large for an archive. It is still on this box, under wallets/${wallet.id}/assets/backup.json.`
		};
	}
	if (assets.notArchived === 'no-file') {
		return {
			code: 'no-file',
			text: 'Assets not in the last backup: the wallet had not written them out, usually because it was not running. Start the wallet and back up again.'
		};
	}
	if (assets.backupFile === false) {
		return {
			code: 'unwritten',
			text: 'Assets not written out for a backup yet. Start the wallet before you back up.'
		};
	}
	if (!wallet.lastBackupAt) {
		return { code: 'never', text: 'Assets in no backup yet. Back up this box to keep them.' };
	}
	return null;
}

/**
 * The same, kept to what the last archive was written without: the two
 * reasons the manager records against a wallet when it writes one.
 */
export function assetsNotArchived(wallet) {
	const gap = assetsBackupGap(wallet);
	return gap && (gap.code === 'too-large' || gap.code === 'no-file') ? gap : null;
}

/** The wallets whose assets the last archive does not hold. */
export const assetsLeftOut = (wallets) => (wallets || []).filter((w) => !!assetsNotArchived(w));

/**
 * What deleting a wallet that holds assets costs, for the delete dialog.
 * Null for a wallet that holds none.
 */
export function deleteAssetsNote(wallet) {
	if (!wallet || !wallet.assets || !wallet.assets.holdsAssets) return null;
	const gap = assetsBackupGap(wallet);
	const state = gap
		? gap.text
		: wallet.backupStale
		? 'This wallet has changed since the last box backup, so that backup may not hold its assets as they are now. Back up the box first.'
		: 'The last box backup holds them.';
	return {
		// The assets survive the delete only where a backup has them.
		safe: !gap && !wallet.backupStale,
		text: `This wallet holds Taproot Assets. Deleting it takes them out of Beignet, and erasing its data deletes their records. The recovery phrase alone does not bring assets back: only a box backup that holds them does. ${state}`
	};
}

export const PHRASE_ASSETS_NOTE =
	'This wallet holds Taproot Assets. The phrase alone does not restore them: assets come back from the box backup (Settings, Back up all wallets), restored together with this phrase.';
