/**
 * Run with: npm test (from manager/ui).
 *
 * Taproot Assets in the wallet list and its delete dialog. A recovery phrase
 * does not bring assets back, only a box backup that holds them does. So a
 * wallet whose assets the last backup was written without is named in the
 * list with the reason, and deleting a wallet that holds assets says what
 * goes with it and whether a backup has it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render } from '../../test/render.mjs';
import { manager } from '../api.js';
import { ToastProvider } from '../components/Toast.jsx';
import { AssetChannelBitcoinLine, AssetsBackupLine, DeleteModal } from './WalletsPage.jsx';

const AT = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();

const wallet = (assets = {}, rest = {}) => ({
	id: 'w1',
	name: 'Main',
	network: 'mainnet',
	status: 'running',
	lastBackupAt: AT,
	backupStale: false,
	lfbwDependents: [],
	assets: { enabled: true, universe: null, holdsAssets: true, phase: 'ready', error: null, backupFile: true, notArchived: null, ...assets },
	...rest
});

const dialog = (w, props = {}) =>
	render(ToastProvider, {
		children: createElement(DeleteModal, { wallet: w, onClose: () => {}, onDeleted: () => {}, ...props })
	});

test('the list names a wallet whose assets the last backup does not hold, with what to do', async () => {
	const r = await render(AssetsBackupLine, { wallet: wallet({ notArchived: 'no-file', backupFile: false }) });
	try {
		const line = r.$('[data-testid="wallet-assets-backup-w1"]');
		assert.ok(line.classList.contains('wallet-meta'), 'one quiet line, like its other standing conditions');
		assert.match(line.textContent, /^Assets not in the last backup/);
		assert.match(line.textContent, /Start the wallet and back up again\.$/);
	} finally {
		await r.unmount();
	}
});

test('an assets file too large for an archive is said to be on the box still, and where', async () => {
	const r = await render(AssetsBackupLine, { wallet: wallet({ notArchived: 'too-large' }, { id: 'abc123' }) });
	try {
		const line = r.$('[data-testid="wallet-assets-backup-abc123"]');
		assert.match(line.textContent, /too large for an archive/);
		assert.match(line.textContent, /under wallets\/abc123\/assets\/backup\.json\.$/);
	} finally {
		await r.unmount();
	}
});

test('a wallet whose assets are in the backup, or that holds none, adds no line to the list', async () => {
	const quiet = [
		wallet(),
		wallet({ holdsAssets: false, backupFile: null }),
		// Not yet backed up is Settings' to say, beside the button that fixes it.
		wallet({}, { lastBackupAt: null, backupStale: true }),
		{ id: 'w1', name: 'From before assets' }
	];
	for (const w of quiet) {
		const r = await render(AssetsBackupLine, { wallet: w });
		try {
			assert.equal(r.container.textContent, '', JSON.stringify(w.assets || null));
		} finally {
			await r.unmount();
		}
	}
});

test('deleting a wallet that holds assets says its asset records go too, and that the backup has them', async () => {
	const r = await dialog(wallet());
	try {
		const note = r.$('[data-testid="delete-assets-note"]');
		assert.ok(note.classList.contains('info-note'), 'calm where a backup holds them');
		assert.match(note.textContent, /^This wallet holds Taproot Assets\./);
		assert.match(note.textContent, /erasing its data deletes their records/);
		assert.match(note.textContent, /recovery phrase alone does not bring assets back/);
		assert.match(note.textContent, /The last box backup holds them\.$/);
	} finally {
		await r.unmount();
	}
});

test('it says so when the last backup does not hold them, and why', async () => {
	const cases = [
		[wallet({ notArchived: 'no-file', backupFile: false }), /Assets not in the last backup.*Start the wallet and back up again\.$/],
		[wallet({ notArchived: 'too-large' }), /too large for an archive.*under wallets\/w1\/assets\/backup\.json\.$/],
		[wallet({}, { backupStale: true }), /changed since the last box backup.*Back up the box first\.$/],
		[wallet({}, { lastBackupAt: null, backupStale: true }), /Assets in no backup yet\. Back up this box to keep them\.$/]
	];
	for (const [w, expected] of cases) {
		const r = await dialog(w);
		try {
			const note = r.$('[data-testid="delete-assets-note"]');
			assert.ok(note.classList.contains('error-note'), 'marked like the dialog\'s other losses');
			assert.match(note.textContent, expected);
			assert.doesNotMatch(note.textContent, /The last box backup holds them/);
		} finally {
			await r.unmount();
		}
	}
});

test('a wallet that holds no assets is deleted with the dialog it always had', async () => {
	const deleted = [];
	const before = manager.deleteWallet;
	manager.deleteWallet = async (id, purge) => deleted.push([id, purge]);
	let done = 0;
	const r = await dialog(wallet({ holdsAssets: false, backupFile: null }), { onDeleted: () => done++ });
	try {
		assert.equal(r.$('[data-testid="delete-assets-note"]'), null);
		assert.doesNotMatch(r.text(), /Taproot Assets/);
		await click(r.$$('button').find((b) => b.textContent.trim() === 'Delete wallet'));
		assert.deepEqual(deleted, [['w1', false]]);
		assert.equal(done, 1);
	} finally {
		manager.deleteWallet = before;
		await r.unmount();
	}
});

/* ------------------------------------------- the bitcoin in asset channels */

test('the list says the bitcoin a wallet has in asset channels, which its figure leaves out', async () => {
	const r = await render(AssetChannelBitcoinLine, { wallet: wallet(), balance: { onchain: 1, lightning: 2, total: 3, assetChannelSats: 98292 } });
	try {
		const line = r.$('[data-testid="wallet-asset-channel-sats-w1"]');
		assert.ok(line.classList.contains('wallet-meta'), 'one quiet line');
		assert.equal(line.textContent, '+ 98,292 sats in asset channels, comes home when the channel closes');
	} finally {
		await r.unmount();
	}
});

test('it says a closing channel\'s bitcoin as on its way back, beside what is still in channels', async () => {
	const r = await render(AssetChannelBitcoinLine, { wallet: wallet(), balance: { assetChannelSats: 98292, assetChannelClosingSats: 40000 } });
	try {
		assert.equal(
			r.$('[data-testid="wallet-asset-channel-sats-w1"]').textContent,
			'+ 98,292 sats in asset channels, comes home when the channel closes · + 40,000 sats on their way home from a closing asset channel'
		);
	} finally {
		await r.unmount();
	}
});

test('a wallet without asset channels adds no such line to the list', async () => {
	for (const balance of [null, undefined, { onchain: 1, lightning: 2, total: 3 }]) {
		const r = await render(AssetChannelBitcoinLine, { wallet: wallet(), balance });
		try {
			assert.equal(r.$('[data-testid="wallet-asset-channel-sats-w1"]'), null);
		} finally {
			await r.unmount();
		}
	}
});
