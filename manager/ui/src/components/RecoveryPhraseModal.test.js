/**
 * Run with: npm test (from manager/ui).
 *
 * The recovery phrase dialog. The words are a wallet's every coin, so the
 * dialog opens on the warning alone and asks the manager for nothing until
 * Show phrase is pressed; then it shows the words numbered, in order. A
 * wallet whose seed is not on the box says so instead of showing an empty
 * grid.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle } from '../../test/render.mjs';
import { manager } from '../api.js';
import { ToastProvider } from './Toast.jsx';
import RecoveryPhraseModal from './RecoveryPhraseModal.jsx';

const PHRASE = Array.from({ length: 24 }, (_, i) => `word${i + 1}`).join(' ');

function stub(fn) {
	const before = manager.recoveryPhrase;
	manager.recoveryPhrase = fn;
	return () => {
		manager.recoveryPhrase = before;
	};
}

const mount = (wallet, props = {}) =>
	render(ToastProvider, {
		children: createElement(RecoveryPhraseModal, { wallet, onClose: () => {}, ...props })
	});

const button = (r, label) => r.$$('button').find((b) => b.textContent.trim() === label);

test('the phrase is asked for only on Show phrase, then shown numbered and in order', async () => {
	const asked = [];
	const restore = stub(async (id) => {
		asked.push(id);
		return { mnemonic: PHRASE };
	});
	const r = await mount({ id: 'w1', name: 'Spending', onchainOnly: false });
	try {
		assert.match(r.text(), /Recovery phrase for "Spending"/);
		assert.match(r.text(), /Anyone who sees these words can take every coin/);
		assert.match(r.text(), /channel backup/);
		assert.equal(r.$('[data-testid="seed-words"]'), null);
		assert.deepEqual(asked, []);

		await click(r.$('[data-testid="reveal-phrase"]'));
		await settle(20);
		assert.deepEqual(asked, ['w1']);
		const words = r.$$('.seed-word').map((w) => w.textContent);
		assert.equal(words.length, 24);
		assert.equal(words[0], '1word1');
		assert.equal(words[23], '24word24');
		assert.ok(button(r, 'Copy phrase'));
		assert.ok(button(r, 'Done'));
		assert.equal(button(r, 'Show phrase'), undefined);
	} finally {
		await r.unmount();
		restore();
	}
});

test('an on-chain only wallet is not told about channels', async () => {
	const restore = stub(async () => ({ mnemonic: PHRASE }));
	const r = await mount({ id: 'w2', name: 'Savings', onchainOnly: true });
	try {
		assert.match(r.text(), /on-chain funds/);
		assert.doesNotMatch(r.text(), /channel/i);
	} finally {
		await r.unmount();
		restore();
	}
});

test('a wallet that holds assets is told the phrase alone does not restore them, before the words are shown', async () => {
	const restore = stub(async () => ({ mnemonic: PHRASE }));
	const assets = { enabled: true, universe: null, holdsAssets: true, phase: 'ready', error: null, backupFile: true, notArchived: null };
	const r = await mount({ id: 'w1', name: 'Main', assets });
	try {
		const note = r.$('[data-testid="phrase-assets-note"]');
		assert.ok(note, 'said on the warning, not after the reveal');
		assert.ok(note.classList.contains('info-note'), 'a calm note, not a second alarm');
		assert.match(note.textContent, /^This wallet holds Taproot Assets\. The phrase alone does not restore them/);
		assert.match(note.textContent, /box backup \(Settings, Back up all wallets\)/);
		await click(button(r, 'Show phrase'));
		await settle(20);
		assert.ok(r.$('[data-testid="seed-words"]'));
		assert.ok(r.$('[data-testid="phrase-assets-note"]'), 'and it stays beside the words');
	} finally {
		await r.unmount();
		restore();
	}
});

test('a wallet that holds no assets is told nothing about them', async () => {
	const restore = stub(async () => ({ mnemonic: PHRASE }));
	const records = [
		{ id: 'w1', name: 'Main' },
		{ id: 'w1', name: 'Main', assets: { enabled: true, universe: null, holdsAssets: false, backupFile: null, notArchived: null } }
	];
	try {
		for (const wallet of records) {
			const r = await mount(wallet);
			try {
				assert.equal(r.$('[data-testid="phrase-assets-note"]'), null);
				assert.doesNotMatch(r.text(), /Taproot Assets/);
			} finally {
				await r.unmount();
			}
		}
	} finally {
		restore();
	}
});

test('a wallet whose seed is not on this box says so, with no words and Show phrase still there', async () => {
	const restore = stub(async () => {
		const e = new Error("This wallet's recovery phrase is not on this Umbrel.");
		e.code = 'NO_SEED';
		throw e;
	});
	const r = await mount({ id: 'w3', name: 'Moved', onchainOnly: false });
	try {
		await click(r.$('[data-testid="reveal-phrase"]'));
		await settle(20);
		assert.match(r.$('[role="alert"]').textContent, /not on this Umbrel/);
		assert.equal(r.$('[data-testid="seed-words"]'), null);
		assert.ok(button(r, 'Show phrase'));
	} finally {
		await r.unmount();
		restore();
	}
});
