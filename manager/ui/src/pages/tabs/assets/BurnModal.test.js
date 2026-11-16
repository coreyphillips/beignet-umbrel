/**
 * Run with: npm test (from manager/ui).
 *
 * Burning is the one thing on the Assets tab that cannot be put right
 * afterwards, so the button is earned twice: an amount the wallet has built
 * a transaction for, and the asset's name typed out exactly. What is pinned
 * here is the gate, and that the wallet is told the amount a second time
 * with the commit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { assetsBackend, follow, mountAssets } from '../../../../test/assets-backend.mjs';
import { click, settle, type } from '../../../../test/render.mjs';

test.beforeEach(() => sessionStorage.clear());

// The prepare waits for the amount to settle.
const PRICED_MS = 800;

/** The burn dialog of one of the main wallet's assets, opened from its page. */
async function burning(backend, pick) {
	const r = await mountAssets(backend, 'demo-main', { at: {} });
	await follow(pick(r));
	await click(r.test('asset-action-burn'));
	await settle(50);
	return r;
}
const firstRow = (r) => r.$('[data-testid^="asset-row-"]');
const ticket = (r) => r.$$('[data-testid^="asset-tile-"]').find((a) => /Genesis Ticket/.test(a.textContent));

test("a burn is asked for twice: an amount the wallet has priced, then the asset's name", async () => {
	const backend = assetsBackend();
	const r = await burning(backend, firstRow);
	try {
		const dialog = r.test('asset-burn').closest('[role="dialog"]');
		assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Burn BUSD');
		assert.match(r.test('asset-burn').textContent, /Burning destroys these units for good\. It cannot be undone\./);
		assert.match(r.test('asset-burn').textContent, /2,400\.00 BUSD in Lightning channels cannot be burned from here\./);
		const button = r.test('asset-burn-confirm');
		assert.equal(button.textContent, 'Burn BUSD');
		assert.equal(button.disabled, true, 'nothing to burn yet');

		// The name alone is not enough.
		await type(r.test('asset-burn-name'), 'BUSD');
		assert.equal(button.disabled, true);
		await type(r.test('asset-burn-name'), '');

		// Nor is the amount alone, even once the wallet has built the transaction.
		await type(r.test('asset-burn-amount'), '100');
		await settle(PRICED_MS);
		assert.match(r.test('asset-burn-preview').textContent, /Miner fee: 3,816 sats at 18 sat\/vB over 212 vB\. This is what the transaction pays, not an estimate of it\./);
		assert.equal(button.textContent, 'Burn 100.00 BUSD', 'the button says exactly what it will destroy');
		assert.equal(button.disabled, true);

		// And the name has to be the name: a near miss is a miss.
		await type(r.test('asset-burn-name'), 'busd');
		assert.equal(button.disabled, true);
		await type(r.test('asset-burn-name'), 'BUSD ');
		assert.equal(button.disabled, false, 'a stray space from a paste is forgiven');
		await type(r.test('asset-burn-name'), 'BUSD');
		assert.equal(button.disabled, false);
		assert.equal(backend.posted('/burn/commit').length, 0, 'and nothing has been burned by getting this far');

		// Two presses before the first has answered.
		await act(async () => {
			button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
			button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		});
		await settle(300);
		const commits = backend.posted('/burn/commit');
		assert.equal(commits.length, 1);
		assert.match(commits[0].body.previewId, /^preview-/);
		assert.equal(commits[0].body.confirmAmount, '10000', 'the amount is said to the wallet again, so the two can be compared');
		assert.match(commits[0].headers['X-Idempotency-Key'], /^[0-9a-f]{32}$/);
		assert.deepEqual(r.toasts(), ['Burn broadcast']);
		assert.equal(r.test('asset-burn'), null, 'the dialog is put away');

		// It is in the asset's history from the moment it is broadcast.
		const burn = r.tests('asset-history-row')[0];
		assert.match(burn.textContent, /Burn/);
		assert.match(burn.textContent, /100\.00/);
	} finally {
		await r.unmount();
	}
});

test('Max is what is on-chain, and more than that is refused before the wallet is asked', async () => {
	const backend = assetsBackend();
	const r = await burning(backend, firstRow);
	try {
		await click([...r.test('asset-burn').querySelectorAll('button')].find((b) => b.textContent === 'Max'));
		assert.equal(r.test('asset-burn-amount').value, '12500', 'not the 14,900.00 held in all: the channel is not this dialog\'s to burn');
		assert.match(r.test('asset-burn').textContent, /This burns everything you hold on-chain\./);
		await settle(PRICED_MS);
		assert.equal(backend.posted('/burn/prepare').at(-1).body.amount, '1250000');
		assert.equal(r.test('asset-burn-confirm').textContent, 'Burn 12,500.00 BUSD');

		const prepared = backend.posted('/burn/prepare').length;
		await type(r.test('asset-burn-amount'), '12500.01');
		await type(r.test('asset-burn-name'), 'BUSD');
		await settle(PRICED_MS);
		assert.match(r.test('asset-burn').textContent, /That is more than the 12,500\.00 BUSD this wallet holds on-chain\./);
		assert.equal(r.test('asset-burn-confirm').disabled, true);
		assert.equal(backend.posted('/burn/prepare').length, prepared);
	} finally {
		await r.unmount();
	}
});

test('a collectible is burned whole, and still only by name', async () => {
	const backend = assetsBackend();
	const r = await burning(backend, ticket);
	try {
		assert.equal(r.test('asset-burn-amount'), null);
		assert.match(r.test('asset-burn').textContent, /Amount to burn1 \(collectible\)/);
		await settle(PRICED_MS);
		const button = r.test('asset-burn-confirm');
		assert.equal(button.textContent, 'Burn Genesis Ticket #7');
		assert.equal(button.disabled, true);
		await type(r.test('asset-burn-name'), 'Genesis Ticket');
		assert.equal(button.disabled, true);
		await type(r.test('asset-burn-name'), 'Genesis Ticket #7');
		assert.equal(button.disabled, false);
	} finally {
		await r.unmount();
	}
});

test('without bitcoin for the fee, the burn says what it needs and the button stays shut', async () => {
	const backend = assetsBackend();
	backend.setSpendable('demo-main', 500);
	const r = await burning(backend, firstRow);
	try {
		await type(r.test('asset-burn-amount'), '100');
		await type(r.test('asset-burn-name'), 'BUSD');
		await settle(PRICED_MS);
		// The fee is 3,816 sats, and the wallet has to hold more than the fee to
		// build the transaction at all. Both figures are said, and which is which.
		assert.match(
			r.test('asset-burn').textContent,
			/Burning costs 3,816 sats, but the wallet has to hold about 39,816 sats on-chain to build the transaction\. What is not spent comes straight back\. This wallet has 500 sats\. Deposit bitcoin on the Receive tab first\./
		);
		assert.equal(r.test('asset-burn-preview').textContent, '', 'no fee is shown for a transaction that was not built');
		assert.equal(r.test('asset-burn-confirm').disabled, true);
	} finally {
		await r.unmount();
	}
});
