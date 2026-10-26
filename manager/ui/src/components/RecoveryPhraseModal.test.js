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
