/**
 * Run with: npm test (from manager/ui).
 *
 * The backup status in Settings: the box's line, and where each wallet stands
 * against the last archive. It left the wallet list for Settings, so this is
 * the one place a wallet missing from the archive is named.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../../test/render.mjs';
import BackupStatus from './BackupStatus.jsx';

const ago = (days) => new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();

test('a current box reads as backed up, with every wallet in it', async () => {
	const at = ago(2);
	const wallets = [
		{ id: 'a', name: 'Spending', lastBackupAt: at, backupStale: false },
		{ id: 'b', name: 'Savings', lastBackupAt: at, backupStale: false }
	];
	const r = await render(BackupStatus, { wallets, lastBackupAt: at });
	try {
		const summary = r.$('[data-testid="backup-summary"]');
		assert.equal(summary.textContent, 'Backed up 2 days ago.');
		assert.ok(summary.classList.contains('info-note'));
		assert.match(r.$('[data-testid="backup-stamp-a"]').textContent, /Spending\s*backed up 2 days ago/);
		assert.equal(r.$$('.backup-list li.stale').length, 0);
	} finally {
		await r.unmount();
	}
});

test('wallets changed since the archive are counted and named', async () => {
	const at = ago(5);
	const wallets = [
		{ id: 'a', name: 'Spending', lastBackupAt: at, backupStale: true },
		{ id: 'b', name: 'Savings', lastBackupAt: at, backupStale: false },
		{ id: 'c', name: 'New one', lastBackupAt: null, backupStale: true }
	];
	const r = await render(BackupStatus, { wallets, lastBackupAt: at });
	try {
		const summary = r.$('[data-testid="backup-summary"]');
		assert.equal(summary.textContent, 'Backed up 5 days ago, but 2 wallets have been created or edited since.');
		assert.ok(summary.classList.contains('error-note'));
		assert.match(r.$('[data-testid="backup-stamp-a"]').textContent, /changed since the backup 5 days ago/);
		assert.match(r.$('[data-testid="backup-stamp-c"]').textContent, /never backed up/);
		assert.deepEqual(
			r.$$('.backup-list li.stale').map((li) => li.dataset.testid),
			['backup-stamp-a', 'backup-stamp-c']
		);
	} finally {
		await r.unmount();
	}
});

test('a box never backed up says what a seed alone leaves behind', async () => {
	const r = await render(BackupStatus, {
		wallets: [{ id: 'a', name: 'Spending', lastBackupAt: null, backupStale: true }],
		lastBackupAt: null
	});
	try {
		assert.match(r.text(), /No backup of this box yet\. A seed alone does not carry/);
		assert.ok(r.$('[data-testid="backup-summary"]').classList.contains('error-note'));
	} finally {
		await r.unmount();
	}
});

// Taproot Assets: a recovery phrase does not bring them back, the archive
// does, and only if the wallet had written them out when it was made.
const assetsOf = (extra = {}) => ({
	enabled: true,
	universe: null,
	holdsAssets: true,
	phase: 'ready',
	error: null,
	backupFile: true,
	notArchived: null,
	...extra
});

test('a wallet whose assets the last archive does not hold is named, with the reason', async () => {
	const at = ago(3);
	const wallets = [
		{ id: 'a', name: 'Spending', lastBackupAt: at, backupStale: false, assets: assetsOf({ notArchived: 'no-file', backupFile: false }) },
		{ id: 'b', name: 'Vault', lastBackupAt: at, backupStale: false, assets: assetsOf({ notArchived: 'too-large' }) },
		{ id: 'c', name: 'Savings', lastBackupAt: at, backupStale: false, assets: assetsOf() },
		{ id: 'd', name: 'Plain', lastBackupAt: at, backupStale: false }
	];
	const r = await render(BackupStatus, { wallets, lastBackupAt: at });
	try {
		const summary = r.$('[data-testid="backup-summary"]');
		assert.equal(summary.textContent, 'Backed up 3 days ago. It does not hold the assets of 2 wallets.');
		assert.ok(summary.classList.contains('error-note'), 'an archive without them is not a current one');

		const noFile = r.$('[data-testid="backup-assets-a"]');
		assert.match(noFile.textContent, /^Assets not in the last backup/);
		assert.match(noFile.textContent, /Start the wallet and back up again\.$/);
		const tooLarge = r.$('[data-testid="backup-assets-b"]');
		assert.match(tooLarge.textContent, /too large for an archive/);
		assert.match(tooLarge.textContent, /still on this box, under wallets\/b\/assets\/backup\.json\.$/);

		// In the same yellow as a wallet edited since, and only those two.
		assert.deepEqual(
			r.$$('.backup-list li.stale').map((li) => li.dataset.testid),
			['backup-stamp-a', 'backup-stamp-b']
		);
		assert.equal(r.$('[data-testid="backup-assets-c"]'), null);
		assert.equal(r.$('[data-testid="backup-assets-d"]'), null);
		assert.match(r.$('[data-testid="backup-stamp-c"]').textContent, /^Savings\s*backed up 3 days ago$/);
	} finally {
		await r.unmount();
	}
});

test('one wallet left out is named in the line itself', async () => {
	const at = ago(1);
	const wallets = [
		{ id: 'a', name: 'Spending', lastBackupAt: at, backupStale: true, assets: assetsOf({ notArchived: 'no-file' }) },
		{ id: 'b', name: 'Savings', lastBackupAt: at, backupStale: false }
	];
	const r = await render(BackupStatus, { wallets, lastBackupAt: at });
	try {
		assert.equal(
			r.$('[data-testid="backup-summary"]').textContent,
			'Backed up 24 hours ago, but 1 wallet has been created or edited since. It does not hold the assets of "Spending".'
		);
	} finally {
		await r.unmount();
	}
});

test('assets not yet written out are said before the next backup, and a wallet never backed up is not said twice', async () => {
	const at = ago(2);
	const wallets = [
		{ id: 'a', name: 'Stopped', lastBackupAt: at, backupStale: true, assets: assetsOf({ backupFile: false }) },
		{ id: 'b', name: 'New one', lastBackupAt: null, backupStale: true, assets: assetsOf() }
	];
	const r = await render(BackupStatus, { wallets, lastBackupAt: at });
	try {
		assert.equal(
			r.$('[data-testid="backup-assets-a"]').textContent,
			'Assets not written out for a backup yet. Start the wallet before you back up.'
		);
		assert.equal(r.$('[data-testid="backup-assets-b"]'), null);
		assert.match(r.$('[data-testid="backup-stamp-b"]').textContent, /^New one\s*never backed up$/);
		// Neither was left out of the last archive: that line is about the past.
		assert.equal(r.$('[data-testid="backup-assets-summary"]'), null);
	} finally {
		await r.unmount();
	}
});

test('while the wallets are read it says so, and an empty box has no list', async () => {
	const loading = await render(BackupStatus, { wallets: null, lastBackupAt: null });
	try {
		assert.match(loading.text(), /Reading the wallets/);
		assert.equal(loading.$('[data-testid="backup-summary"]'), null);
	} finally {
		await loading.unmount();
	}
	const empty = await render(BackupStatus, { wallets: [], lastBackupAt: null });
	try {
		assert.equal(empty.text(), 'No backup of this box yet.');
		assert.equal(empty.$('[data-testid="backup-list"]'), null);
	} finally {
		await empty.unmount();
	}
});
