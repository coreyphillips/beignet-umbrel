/**
 * Run with: npm test (from manager/ui).
 *
 * Receiving an asset on-chain. An address is for one asset and one amount, it
 * is two hundred characters nobody can check by eye, and the payment takes an
 * hour to be usable. So the view asks for both before it makes one, shows the
 * address the way two people compare one, and then tells the truth about the
 * wait: nothing is claimed before a block has it, and a paid address stops
 * looking like one that is still waiting.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { assetsBackend, mountAssets } from '../../../../test/assets-backend.mjs';
import { click, settle, type } from '../../../../test/render.mjs';

test.beforeEach(() => sessionStorage.clear());

const chip = (r, name) => r.$$('.asset-chip').find((b) => b.querySelector('.asset-chip-name').textContent === name);
const steps = (root) => [...root.querySelectorAll('li')].map((li) => `${li.getAttribute('data-step')}:${li.getAttribute('data-state')}`).join(' ');

/** The Receive view with an asset chosen and an amount typed. */
async function asking(backend, wallet, name, amount) {
	const r = await mountAssets(backend, wallet);
	await r.view('Receive');
	await click(chip(r, name));
	if (amount != null) await type(r.test('asset-receive-amount'), amount);
	return r;
}

test('an address is for one asset and one amount, so both are asked for first', async () => {
	const backend = assetsBackend();
	const r = await mountAssets(backend, 'demo-main');
	try {
		await r.view('Receive');
		assert.match(r.test('asset-receive').textContent, /Choose the asset above first\./);
		assert.equal(r.test('asset-address-create'), null);
		const chips = r.$$('.asset-chip');
		assert.deepEqual(
			chips.map((c) => c.querySelector('.asset-chip-name').textContent),
			['BUSD', 'Club Points', 'Pico', 'Beignet Poster', 'Genesis Ticket #7', 'Another asset']
		);
		assert.equal(chips[0].parentElement.getAttribute('role'), 'radiogroup');
		assert.ok(chips.every((c) => c.getAttribute('role') === 'radio' && c.getAttribute('aria-checked') === 'false'));
		assert.deepEqual(chips.map((c) => c.tabIndex), [0, -1, -1, -1, -1, -1], 'one stop for Tab, and the arrows move within');

		await click(chip(r, 'BUSD'));
		assert.equal(chip(r, 'BUSD').getAttribute('aria-checked'), 'true');
		assert.match(r.test('asset-receive').textContent, /Up to 2 decimal places\. The smallest amount is 0\.01\./);
		assert.equal(r.test('asset-address-create').disabled, true, 'not without an amount');
		await type(r.test('asset-receive-amount'), '250');
		assert.equal(r.test('asset-address-create').disabled, false);
		assert.equal(backend.posted('/addresses').length, 0, 'and no address exists until it is asked for');

		// The arrow keys choose, as they do between radio buttons.
		await act(async () => {
			chip(r, 'BUSD').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		});
		assert.equal(chip(r, 'Club Points').getAttribute('aria-checked'), 'true');
		assert.match(r.test('asset-receive').textContent, /Whole units only: this asset has no decimal places\./);
	} finally {
		await r.unmount();
	}
});

test('the address is shown the way two people check one, beside what it is for', async () => {
	const backend = assetsBackend();
	const r = await asking(backend, 'demo-main', 'BUSD', '250');
	try {
		await click(r.test('asset-address-create'));
		await settle(50);
		const made = backend.posted('/addresses', 'demo-main');
		assert.equal(made.length, 1);
		assert.equal(made[0].body.amount, '25000', 'the amount goes to the wallet in the asset\'s own units, as a string');
		assert.match(made[0].body.key, /^02[0-9a-f]{64}$/, 'for the group, so any issuance of it will do');

		const full = r.test('asset-address-full').textContent;
		assert.match(full, /^tapbc1[a-z0-9]{200,}$/);
		const shown = r.test('asset-receive-address');
		assert.equal(shown.querySelector('.tap-address-line').textContent, `${full.slice(0, 14)}…${full.slice(-6)}`);
		assert.equal(shown.querySelector('.tap-address-line').getAttribute('title'), full);
		assert.match(shown.textContent, /For 250\.00 BUSD · proofs through universe\.lightning\.finance:10029/);
		assert.ok(shown.textContent.includes(`compare the last six characters: ${full.slice(-6)}.`));
		assert.equal(r.test('asset-address-once').textContent, 'Use this address once. A second payment to it would not be credited.');
		// While it waits it is looked at by itself, and can be looked at now.
		assert.match(r.test('asset-watched').textContent, /checks this address by itself for seven days/);
		assert.equal(r.test('asset-watched').querySelector('[data-testid="asset-check-now"]').textContent, 'Check now');

		const qr = r.test('asset-receive-qr').querySelector('.qr');
		assert.equal(qr.getAttribute('aria-label'), 'Taproot Assets address for 250.00 BUSD');
		assert.ok(r.test('qr-zoom-open'), 'and it can be enlarged, since a code this dense is hard to scan small');

		const status = r.test('asset-receive-status');
		assert.equal(status.getAttribute('data-state'), 'waiting');
		assert.equal(steps(status), 'waiting:current first:pending confirmations:pending proof:pending complete:pending');
		assert.match(status.textContent, /Nothing seen yet\. This page updates by itself\./);
		assert.doesNotMatch(status.textContent, /unconfirmed|mempool/i, 'no step claims to have seen what only a block can show');
		assert.match(r.test('asset-receive').textContent, /You can leave this page\. The wallet keeps watching/);

		const again = r.test('asset-address-create');
		assert.equal(again.textContent, 'Replace with a new address', 'a second press would make a second address, and the button says so');
		assert.equal(r.tests('asset-receive-row')[0].getAttribute('data-state'), 'waiting', 'it is in the list of receives from the start');
	} finally {
		await r.unmount();
	}
});

test('the wait is told as it happens, and a paid address gives way to a receipt', async () => {
	const backend = assetsBackend();
	const r = await asking(backend, 'demo-main', 'BUSD', '250');
	try {
		await click(r.test('asset-address-create'));
		await settle(50);
		const status = () => r.test('asset-receive-status');

		// Found in a block: seen and confirmed once are the same moment.
		await r.pass(9000 + 1600);
		assert.equal(status().getAttribute('data-state'), 'confirming');
		assert.equal(steps(status()), 'waiting:done first:done confirmations:current proof:pending complete:pending');
		assert.equal(status().querySelector('[data-testid="conf-meter"]').getAttribute('aria-label'), '2 of 6 confirmations');
		assert.ok(r.test('asset-receive-qr'), 'still an address, while it is still on its way');

		await r.pass(1600 * 4);
		assert.equal(status().getAttribute('data-state'), 'proofs');
		assert.match(status().textContent, /Fetching it from universe\.lightning\.finance:10029…/);

		await r.pass(3000);
		await settle(450);
		assert.equal(status().getAttribute('data-state'), 'complete');
		assert.match(status().textContent, /250\.00 BUSD is in your holdings\./);
		const receipt = r.test('asset-received');
		assert.equal(receipt.getAttribute('role'), 'status');
		assert.match(receipt.textContent, /Received/);
		assert.match(receipt.textContent, /250\.00 BUSD received on-chain\. About 1,000 sats came with it and stay locked with the asset\./);
		assert.equal(r.test('asset-receive-qr'), null, 'the code is gone: it has been paid');
		assert.equal(r.test('asset-address-create').textContent, 'Create address');

		await click(r.test('asset-receive-again'));
		await settle(50);
		assert.equal(r.test('asset-received'), null);
		assert.equal(r.test('asset-receive-amount').value, '', 'the next one starts from the asset, not from the last amount');
		assert.equal(chip(r, 'BUSD').getAttribute('aria-checked'), 'true');

		await r.view('Holdings');
		await settle(900);
		assert.match(r.$('[data-testid^="asset-row-"]').textContent, /15,150\.00/);
	} finally {
		await r.unmount();
	}
});

test('a collectible is received as itself: one, with no amount to type', async () => {
	const backend = assetsBackend();
	const r = await asking(backend, 'demo-main', 'Genesis Ticket #7');
	try {
		assert.equal(r.test('asset-receive-amount'), null);
		assert.match(r.test('asset-receive').textContent, /Amount to receive1 \(collectible\)/);
		await click(r.test('asset-address-create'));
		await settle(50);
		assert.equal(backend.posted('/addresses')[0].body.amount, '1');
		assert.match(r.test('asset-receive-address').textContent, /For Genesis Ticket #7 · proofs through/, 'named, not counted');
	} finally {
		await r.unmount();
	}
});

test('an asset this wallet has never held is found by its ID, not by its name', async () => {
	const backend = assetsBackend();
	const busd = (await backend.api('demo-main').get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');
	const r = await mountAssets(backend, 'demo-fresh');
	try {
		await r.view('Receive');
		assert.deepEqual(r.$$('.asset-chip').map((c) => c.textContent), ['Another asset'], 'with nothing held, there is only the way to name one');
		await click(r.test('asset-chip-other'));
		const lookup = () => r.test('asset-lookup');
		assert.match(lookup().textContent, /Paste the asset ID \(64 characters\) or the group key \(66\) from whoever is sending it\./);

		await type(r.test('asset-other-input'), 'busd');
		assert.match(lookup().textContent, /An asset ID is 64 characters of 0 to 9 and a to f, and a group key is 66\. This is 4\./);
		assert.equal(backend.posted('/lookup').length, 0, 'a name is not looked up: there is nothing a name could prove');

		await type(r.test('asset-other-input'), 'ab'.repeat(32));
		assert.equal(lookup().getAttribute('data-state'), 'looking');
		await settle(500);
		assert.equal(lookup().getAttribute('data-state'), 'missing');
		assert.match(lookup().textContent, /No asset with this ID was found on universe\.lightning\.finance:10029/);
		assert.equal(r.test('asset-address-create'), null);

		await type(r.test('asset-other-input'), ` ${busd.assetId.toUpperCase()} `);
		await settle(500);
		assert.equal(lookup().getAttribute('data-state'), 'found');
		assert.match(lookup().textContent, /BUSD · asset · 2 decimal places · 1,000,000\.00 issued/);
		assert.match(lookup().textContent, /Check the ID with whoever is sending it: a name proves nothing\./);
		assert.equal(backend.posted('/lookup').at(-1).body.id, busd.assetId);

		await type(r.test('asset-receive-amount'), '12.5');
		await click(r.test('asset-address-create'));
		await settle(50);
		assert.deepEqual(backend.posted('/addresses', 'demo-fresh')[0].body, { key: busd.key, amount: '1250' });
		assert.match(r.test('asset-receive-address').textContent, /For 12\.50 BUSD/);
	} finally {
		await r.unmount();
	}
});

test('a wallet with no bitcoin on-chain is told it can still receive, and can', async () => {
	const backend = assetsBackend({ spendable: (id) => (id === 'demo-lfbw' ? 0 : 500_000) });
	const r = await asking(backend, 'demo-lfbw', 'Club Points', '40');
	try {
		const warning = r.test('asset-warning');
		assert.equal(warning.getAttribute('data-code'), 'NO_SATS_LFBW');
		assert.match(warning.textContent, /Receiving an asset still works/);
		await click(r.test('asset-address-create'));
		await settle(50);
		assert.equal(backend.posted('/addresses', 'demo-lfbw').length, 1);
		assert.ok(r.test('asset-receive-qr'));
	} finally {
		await r.unmount();
	}
});

test("a receive in the list opens to everything known about it, and Escape puts it away", async () => {
	const backend = assetsBackend();
	const r = await mountAssets(backend, 'demo-main');
	try {
		await r.view('Receive');
		const rows = r.tests('asset-receive-row');
		assert.equal(rows.length, 3, 'on-chain and Lightning receives, and nothing that was sent');
		assert.deepEqual(rows.map((tr) => tr.querySelector('.badge').textContent), ['lightning', 'on-chain', 'on-chain']);
		const onchain = rows[1];
		assert.equal(onchain.tabIndex, 0, 'a row can be reached and opened from the keyboard');
		await click(onchain);
		await settle(50);

		const detail = r.test('asset-transfer-detail');
		assert.equal(detail.getAttribute('data-state'), 'complete');
		const dialog = detail.closest('[role="dialog"]');
		assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Receive');
		assert.equal(
			steps(r.test('asset-transfer-timeline')),
			'waiting:done first:done confirmations:done proof:done complete:done'
		);
		assert.match(detail.textContent, /Overon-chain/);
		assert.match(detail.textContent, /Locked with it1,000 sats/);

		await act(async () => {
			window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		await settle(250);
		assert.equal(r.test('asset-transfer-detail'), null);
	} finally {
		await r.unmount();
	}
});
