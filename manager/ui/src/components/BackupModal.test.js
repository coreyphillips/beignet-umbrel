/**
 * Run with: npm test (from manager/ui).
 *
 * The backup dialog, both directions. Writing one out asks for the passphrase
 * twice and will not send until they agree, because there is no second chance
 * at it: the archive cannot be opened without the words typed here. Putting
 * one back opens it first and shows what it holds, and a wallet this box
 * already runs holds the restore until it is confirmed, since two records on
 * one seed is how channel funds are lost.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle, type } from '../../test/render.mjs';
import { manager } from '../api.js';
import { ToastProvider } from './Toast.jsx';
import BackupModal from './BackupModal.jsx';

function stub(name, fn) {
	const before = manager[name];
	manager[name] = fn;
	return () => {
		manager[name] = before;
	};
}

// jsdom has no blob URLs and no downloads; the dialog only needs the browser
// to take the file, so the two calls it makes are recorded instead.
function stubDownloads() {
	const created = [];
	const before = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
	URL.createObjectURL = (blob) => {
		created.push(blob);
		return 'blob:test';
	};
	URL.revokeObjectURL = () => {};
	return { created, restore: () => Object.assign(URL, { createObjectURL: before.create, revokeObjectURL: before.revoke }) };
}

const mount = (props) =>
	render(ToastProvider, {
		children: createElement(BackupModal, { onClose: () => {}, ...props })
	});

const archiveFile = (bytes = 'sealed') =>
	new globalThis.window.File([bytes], 'beignet-backup.beignet');

/** A file input jsdom will hand to the change handler. */
async function attach(input, file) {
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	await click(input);
	input.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
	await settle(10);
}

const PREVIEW = {
	createdAt: '2026-09-15T10:00:00.000Z',
	app: '0.20.10',
	engine: '0.21.3',
	settings: true,
	wallets: [
		{ id: 'w1', name: 'Spending', network: 'regtest', onchainOnly: false, action: 'restore', duplicateOf: null },
		{ id: 'w2', name: 'Savings', network: 'regtest', onchainOnly: true, action: 'present', duplicateOf: null }
	],
	conflicts: []
};

test('the archive is only written once the passphrase has been typed the same way twice', async () => {
	const calls = [];
	const downloads = stubDownloads();
	const restore = stub('exportBackup', async (passphrase) => {
		calls.push(passphrase);
		return { blob: new globalThis.window.Blob(['sealed']), filename: 'beignet-backup-2026.beignet' };
	});
	const r = await mount({ mode: 'export' });
	try {
		assert.equal(r.$('[data-testid="backup-export"]').disabled, true);
		await type(r.$('[data-testid="backup-passphrase"]'), 'short');
		assert.match(r.text(), /shorter than 8 characters is refused/);
		assert.equal(r.$('[data-testid="backup-export"]').disabled, true);

		await type(r.$('[data-testid="backup-passphrase"]'), 'a good long passphrase');
		await type(r.$('[data-testid="backup-passphrase-again"]'), 'a good long passphras');
		assert.match(r.text(), /do not match/);
		assert.equal(r.$('[data-testid="backup-export"]').disabled, true);

		await type(r.$('[data-testid="backup-passphrase-again"]'), 'a good long passphrase');
		assert.equal(r.$('[data-testid="backup-export"]').disabled, false);
		await click(r.$('[data-testid="backup-export"]'));
		await settle(20);
		assert.deepEqual(calls, ['a good long passphrase']);
		assert.equal(downloads.created.length, 1, 'the file was handed to the browser');
		assert.match(r.$('[data-testid="backup-saved"]').textContent, /beignet-backup-2026\.beignet/);
		// The passphrase is not kept on screen for the next person at the box.
		assert.equal(r.$('[data-testid="backup-passphrase"]'), null);
	} finally {
		restore();
		downloads.restore();
		await r.unmount();
	}
});

test('a refused export says why and offers the form again', async () => {
	const restore = stub('exportBackup', async () => {
		throw new Error('The wallet list on this box could not be read');
	});
	const r = await mount({ mode: 'export' });
	try {
		await type(r.$('[data-testid="backup-passphrase"]'), 'a good long passphrase');
		await type(r.$('[data-testid="backup-passphrase-again"]'), 'a good long passphrase');
		await click(r.$('[data-testid="backup-export"]'));
		await settle(20);
		assert.match(r.text(), /could not be read/);
		assert.equal(r.$('[data-testid="backup-saved"]'), null);
		assert.equal(r.$('[data-testid="backup-export"]').disabled, false, 'it can be tried again');
	} finally {
		restore();
		await r.unmount();
	}
});

test('a restore opens the archive first and says what it holds before writing anything', async () => {
	const calls = [];
	const restores = [
		stub('inspectBackup', async (passphrase, archive) => {
			calls.push(['inspect', passphrase, archive]);
			return PREVIEW;
		}),
		stub('restoreBackup', async (passphrase, archive, confirm) => {
			calls.push(['restore', passphrase, archive, confirm]);
			return { restored: [{ id: 'w1', name: 'Spending' }], skipped: [], settings: true };
		})
	];
	const restored = [];
	const r = await mount({ mode: 'restore', onRestored: () => restored.push(true) });
	try {
		assert.equal(r.$('[data-testid="restore-open"]').disabled, true);
		await attach(r.$('[data-testid="restore-file"]'), archiveFile());
		await type(r.$('[data-testid="restore-passphrase"]'), 'a good long passphrase');
		assert.equal(r.$('[data-testid="restore-open"]').disabled, false);
		await click(r.$('[data-testid="restore-open"]'));
		await settle(20);

		assert.equal(calls.length, 1, 'opening an archive writes nothing');
		assert.equal(calls[0][1], 'a good long passphrase');
		assert.match(r.$('[data-testid="restore-provenance"]').textContent, /Beignet 0\.20\.10.*engine 0\.21\.3/);
		const listed = r.$('[data-testid="restore-wallets"]').textContent;
		assert.match(listed, /Spending/);
		assert.match(listed, /Savings.*already on this box/);
		assert.match(r.$('[data-testid="restore-run"]').textContent, /Restore 1 wallet$/);

		await click(r.$('[data-testid="restore-run"]'));
		await settle(20);
		assert.equal(calls[1][0], 'restore');
		assert.equal(calls[1][3], false);
		assert.equal(restored.length, 1);
		assert.match(r.$('[data-testid="restore-done"]').textContent, /Restored 1 wallet\b/);
		assert.match(r.$('[data-testid="restore-done"]').textContent, /They are stopped/);
	} finally {
		restores.forEach((f) => f());
		await r.unmount();
	}
});

test('a wallet this box already runs holds the restore until it is confirmed', async () => {
	const calls = [];
	const conflicted = {
		...PREVIEW,
		wallets: [
			{ ...PREVIEW.wallets[0], duplicateOf: { id: 'other', name: 'The same node' } },
			PREVIEW.wallets[1]
		],
		conflicts: [{ ...PREVIEW.wallets[0], duplicateOf: { id: 'other', name: 'The same node' } }]
	};
	const restores = [
		stub('inspectBackup', async () => conflicted),
		stub('restoreBackup', async (passphrase, archive, confirm) => {
			calls.push(confirm);
			return { restored: [{ id: 'w1', name: 'Spending' }], skipped: [], settings: true };
		})
	];
	const r = await mount({ mode: 'restore' });
	try {
		await attach(r.$('[data-testid="restore-file"]'), archiveFile());
		await type(r.$('[data-testid="restore-passphrase"]'), 'a good long passphrase');
		await click(r.$('[data-testid="restore-open"]'));
		await settle(20);
		assert.match(r.text(), /how channel funds are lost/);
		assert.match(r.$('[data-testid="restore-wallets"]').textContent, /same node as .*The same node/);
		assert.equal(r.$('[data-testid="restore-run"]').disabled, true);

		await click(r.$('[data-testid="restore-confirm"]'));
		await settle(10);
		assert.equal(r.$('[data-testid="restore-run"]').disabled, false);
		await click(r.$('[data-testid="restore-run"]'));
		await settle(20);
		assert.deepEqual(calls, [true]);
	} finally {
		restores.forEach((f) => f());
		await r.unmount();
	}
});
