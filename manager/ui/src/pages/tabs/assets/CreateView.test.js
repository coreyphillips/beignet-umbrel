/**
 * Run with: npm test (from manager/ui).
 *
 * Creating an asset. A mint is one transaction that cannot be taken back, and
 * two of its choices (the decimal places, whether more can ever be made) are
 * for good, so the form says what the figures come to before the button is
 * pressed, the cost on screen is the wallet's own, and the request is the
 * form and nothing else.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { assetsBackend, follow, mountAssets } from '../../../../test/assets-backend.mjs';
import { click, select, settle, type } from '../../../../test/render.mjs';
import { EMPTY_SEEDLING, checkSeedling, describeSeedling, isBlank, reissueTarget } from './CreateView.jsx';

test.beforeEach(() => sessionStorage.clear());

// The cost is asked for a beat after the form settles.
const PRICED_MS = 350;
const pill = (r, label) => r.$$('.pill').find((b) => b.textContent === label);

async function createView(backend, wallet, options) {
	const r = await mountAssets(backend, wallet, options);
	await r.view('Create');
	await settle(PRICED_MS);
	return r;
}

/* ------------------------------------------------------------- the form */

const GROUP = `02${'ab'.repeat(32)}`;
const HELD = [
	{ key: GROUP, assetId: 'cd'.repeat(32), groupKey: GROUP, name: 'BUSD', type: 'normal', decimalDisplay: 2, canReissue: true },
	{ key: 'ef'.repeat(32), assetId: 'ef'.repeat(32), groupKey: null, name: 'Club Points', type: 'normal', decimalDisplay: 0, canReissue: false }
];
const form = (changes) => ({ ...EMPTY_SEEDLING, ...changes });

test('a form is read as the asset it describes', () => {
	assert.deepEqual(describeSeedling(form({ name: '  Gold Gram ', decimals: 3, text: '5', units: '5000', reissuable: true }), HELD), {
		name: 'Gold Gram',
		type: 'normal',
		decimalDisplay: 3,
		amount: '5000',
		reissue: false,
		groupKey: null,
		reissuable: true,
		meta: null
	});
	// A collectible is one of one, whatever was typed before the kind was changed.
	const ticket = describeSeedling(form({ kind: 'collectible', name: 'Ticket #7', decimals: 2, units: '500', reissuable: true, meta: 'Row A' }), HELD);
	assert.equal(ticket.amount, '1');
	assert.equal(ticket.decimalDisplay, null);
	assert.equal(ticket.reissuable, false);
	assert.deepEqual(ticket.meta, { type: 'text', data: 'Row A' });
	// More of an asset takes everything but the amount from that asset.
	const more = describeSeedling(form({ target: GROUP, name: 'ignored', decimals: 7, units: '100' }), HELD);
	assert.deepEqual([more.name, more.decimalDisplay, more.reissue, more.groupKey, more.reissuable], ['BUSD', 2, true, GROUP, true]);
	assert.equal(reissueTarget(form({ target: HELD[1].key }), HELD), null, 'an asset without a group cannot be added to');
	assert.equal(isBlank(EMPTY_SEEDLING), true);
	assert.equal(isBlank(form({ name: ' ' })), true);
	assert.equal(isBlank(form({ text: '5' })), false);
});

test('what is wrong with a form is said field by field', () => {
	const ok = checkSeedling(form({ name: 'Gold Gram', units: '5000' }), { holdings: HELD });
	assert.deepEqual(ok, { name: null, amount: null, meta: null, info: null, ok: true });

	assert.equal(checkSeedling(form({ units: '5' })).name, 'Give the asset a name.');
	assert.equal(checkSeedling(form({ name: 'x'.repeat(65), units: '5' })).name, 'Names can be up to 64 bytes.');
	assert.equal(checkSeedling(form({ name: '€'.repeat(22), units: '5' })).name, 'Names can be up to 64 bytes.', 'bytes, not characters');
	for (const name of ['sats', 'SAT', 'btc', 'Bitcoin']) {
		assert.match(checkSeedling(form({ name, units: '5' })).name || '', /would read as bitcoin/, name);
	}
	assert.equal(
		checkSeedling(form({ name: 'Points', units: '5' }), { batch: [form({ name: 'Points', units: '9' })] }).name,
		'This transaction already has an asset called Points.'
	);
	assert.equal(
		checkSeedling(form({ target: GROUP, units: '5' }), { batch: [form({ target: GROUP, units: '9' })], holdings: HELD }).name,
		'This transaction already mints more BUSD.'
	);

	// A name already held is allowed, because names are not identities. It is said, not refused.
	const again = checkSeedling(form({ name: 'BUSD', units: '5' }), { holdings: HELD });
	assert.equal(again.ok, true);
	assert.match(again.info, /You already hold an asset called BUSD\. This would be a different asset with the same name\./);

	assert.equal(checkSeedling(form({ name: 'Gold' })).amount, 'Say how many to create.');
	assert.equal(checkSeedling(form({ name: 'Gold', units: '0' })).amount, 'Say how many to create.');
	assert.equal(checkSeedling(form({ kind: 'collectible', name: 'Ticket' })).ok, true, 'a collectible has no amount to give');
	assert.match(checkSeedling(form({ name: 'Gold', units: '5', metaType: 'json', meta: '{bad' })).meta, /^This is not valid JSON: .+\.$/);
	assert.equal(checkSeedling(form({ name: 'Gold', units: '5', metaType: 'json', meta: '{"a":1}' })).ok, true);
	assert.equal(checkSeedling(form({ name: 'Gold', units: '5', metaType: 'text', meta: '{bad' })).ok, true, 'text is only text');
});

/* ------------------------------------------------------------- the view */

test('pressing Create on an unfinished form says what is missing', async () => {
	const backend = assetsBackend();
	const r = await createView(backend, 'demo-fresh');
	try {
		const button = r.test('mint-submit');
		assert.equal(button.textContent, 'Create asset');
		assert.equal(button.disabled, false, 'a live button can answer; a greyed one cannot');
		assert.equal(r.test('mint-name-refusal'), null, 'nothing is red before anything was tried');
		await click(button);
		assert.equal(r.test('mint-name-refusal').textContent, 'Give the asset a name.');
		assert.equal(r.test('mint-name-refusal').getAttribute('role'), 'alert');
		assert.equal(r.test('mint-amount-refusal').textContent, 'Say how many to create.');
		assert.equal(backend.posted('/mint').length, 0);

		await type(r.test('mint-name'), 'sats');
		assert.match(r.test('mint-name-refusal').textContent, /cannot be called sats or BTC here/);
	} finally {
		await r.unmount();
	}
});

test('the preview says what the figures come to, on screen and on the network', async () => {
	const r = await createView(assetsBackend(), 'demo-fresh');
	try {
		assert.match(r.test('mint-preview').textContent, /Your asset/);
		await type(r.test('mint-name'), 'BUSD');
		await select(r.test('mint-decimals'), '2');
		await type(r.test('mint-amount'), '1000000');
		const preview = () => r.test('mint-preview').textContent;
		assert.match(preview(), /BUSD1,000,000\.00 BUSD/);
		assert.match(preview(), /Smallest amount0\.01 BUSD/);
		assert.match(preview(), /On the network100,000,000 units/);
		assert.match(preview(), /Supplyfixed/);
		assert.equal(r.test('mint-amount-units').textContent, '= 100,000,000 units on the network');
		assert.match(r.test('asset-create').textContent, /Fixed supply: no more can ever be created\./);

		await click(r.test('mint-reissuable'));
		assert.match(preview(), /Supplymore can be minted later/);

		// Changing the decimal places keeps the figure that was meant.
		await select(r.test('mint-decimals'), '0');
		assert.equal(r.test('mint-amount').value, '1000000');
		assert.match(preview(), /1,000,000 BUSD/);
		assert.match(preview(), /On the network1,000,000 units/);

		// A digit past the precision cannot be typed in the first place.
		await select(r.test('mint-decimals'), '2');
		await type(r.test('mint-amount'), '0.005');
		assert.equal(r.test('mint-amount').value, '1000000');
	} finally {
		await r.unmount();
	}
});

test("the cost is the wallet's own figure, and the request is the form", async () => {
	const backend = assetsBackend();
	const r = await createView(backend, 'demo-fresh');
	try {
		await type(r.test('mint-name'), 'BUSD');
		await select(r.test('mint-decimals'), '2');
		await type(r.test('mint-amount'), '1000000');
		await settle(PRICED_MS);
		const cost = r.test('mint-cost').textContent;
		assert.match(cost, /Miner fee2,772 satsat 18 sat\/vB over 154 vB/);
		assert.match(cost, /1,000 sats/, 'the sats that stay locked with the asset are a line of their own');
		assert.match(cost, /Total in bitcoin3,772 sats/);
		assert.match(cost, /On-chain available500,000 sats/);
		assert.match(cost, /Readyafter 6 confirmationsabout an hour/);
		assert.match(r.test('no-bump-note').textContent, /cannot be fee-bumped/);

		const button = r.test('mint-submit');
		assert.equal(button.textContent, 'Create BUSD');
		// Two presses before the first has answered.
		await act(async () => {
			button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
			button.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		});
		await settle(50);

		const mints = backend.posted('/mint');
		assert.equal(mints.length, 1, 'one transaction');
		assert.deepEqual(mints[0].body, {
			seedlings: [{ name: 'BUSD', type: 'normal', amount: '100000000', decimalDisplay: 2, meta: null, group: { mode: 'none' } }],
			feeRate: 18,
			// The fee that was on screen is the most this request will pay.
			maxFeeSats: 2772
		});
		assert.match(mints[0].headers['X-Idempotency-Key'], /^[0-9a-f]{32}$/);
		assert.deepEqual(r.toasts(), ['BUSD is being created']);
		assert.equal(r.test('mint-timeline').getAttribute('data-state'), 'broadcast');
		assert.match(r.test('asset-create').textContent, /You can leave this page: minting carries on in the wallet/);
	} finally {
		await r.unmount();
	}
});

test('a collectible has no amount and no decimal places to choose', async () => {
	const backend = assetsBackend();
	const r = await createView(backend, 'demo-fresh');
	try {
		await type(r.test('mint-amount'), '500');
		await click(pill(r, 'Collectible'));
		assert.match(r.test('mint-kind-hint').textContent, /One of a kind\. There is exactly one and it cannot be divided\./);
		assert.equal(r.test('mint-decimals'), null);
		assert.equal(r.test('mint-amount'), null);
		assert.equal(r.test('mint-reissuable'), null);
		assert.match(r.test('asset-create').textContent, /How many to create1 \(collectible\)/);
		assert.match(r.test('mint-preview').textContent, /One of a kind/);

		await type(r.test('mint-name'), 'Founders Pass');
		await type(r.test('mint-meta'), 'Seat 7, row A');
		await settle(PRICED_MS);
		await click(r.test('mint-submit'));
		await settle(50);
		assert.deepEqual(backend.posted('/mint')[0].body.seedlings, [
			{ name: 'Founders Pass', type: 'collectible', amount: '1', decimalDisplay: null, meta: { type: 'text', data: 'Seat 7, row A' }, group: { mode: 'none' } }
		]);
	} finally {
		await r.unmount();
	}
});

test('several assets can share one transaction and one fee', async () => {
	const backend = assetsBackend();
	const r = await createView(backend, 'demo-fresh');
	try {
		assert.equal(r.test('mint-add-another').disabled, true, 'there is nothing to set aside yet');
		await type(r.test('mint-name'), 'Club Points');
		await type(r.test('mint-amount'), '5000');
		await click(r.test('mint-reissuable'));
		await click(r.test('mint-add-another'));
		assert.equal(r.test('mint-name').value, '', 'the form is cleared for the next one');
		assert.deepEqual(r.tests('mint-batch-item').map((li) => li.querySelector('.mint-batch-name').textContent), ['5,000 Club Points']);
		assert.equal(r.test('mint-submit').textContent, 'Create Club Points', 'with the form empty, the button mints what was set aside');

		await type(r.test('mint-name'), 'Club Points');
		await type(r.test('mint-amount'), '7');
		assert.equal(r.test('mint-name-refusal').textContent, 'This transaction already has an asset called Club Points.');
		await type(r.test('mint-name'), 'Gold Gram');
		await select(r.test('mint-decimals'), '3');
		await settle(PRICED_MS);
		assert.equal(r.test('mint-submit').textContent, 'Create 2 assets');
		assert.deepEqual(backend.posted('/mint/quote').at(-1).body, { count: 2, feeRate: 18 });

		await click(r.test('mint-submit'));
		await settle(50);
		assert.deepEqual(
			backend.posted('/mint')[0].body.seedlings.map((s) => [s.name, s.amount, s.decimalDisplay, s.group.mode]),
			[
				['Club Points', '5000', 0, 'new'],
				['Gold Gram', '7000', 3, 'none']
			]
		);
		assert.deepEqual(r.toasts(), ['2 assets are being created']);
		assert.match(r.test('asset-create').textContent, /2 assets/);
		assert.match(r.test('asset-create').textContent, /Club Points, Gold Gram/);
	} finally {
		await r.unmount();
	}
});

test('minting more of an asset takes its name and decimal places from it', async () => {
	const backend = assetsBackend();
	const r = await mountAssets(backend, 'demo-main', { at: {} });
	try {
		// From the asset's own page, which knows which asset is meant.
		await follow(r.$('[data-testid^="asset-row-"]'));
		const groupKey = r.test('asset-detail').getAttribute('data-key');
		await click(r.test('asset-action-mint-more'));
		await settle(450 + PRICED_MS);
		assert.equal(r.test('assets-tab').getAttribute('data-view'), 'create');
		assert.equal(r.test('mint-target').value, groupKey);
		assert.equal(r.test('mint-name'), null, 'the name is not asked for again');
		assert.equal(r.test('mint-decimals'), null);
		assert.match(r.test('asset-create').textContent, /NameBUSDFrom the asset you are adding to\./);

		await type(r.test('mint-amount'), '500');
		assert.match(r.test('mint-preview').textContent, /500\.00 BUSD/);
		assert.match(r.test('mint-preview').textContent, /Supplyadded to BUSD/);
		await settle(PRICED_MS);
		await click(r.test('mint-submit'));
		await settle(50);
		assert.deepEqual(backend.posted('/mint')[0].body.seedlings, [
			{ name: 'BUSD', type: 'normal', amount: '50000', decimalDisplay: 2, meta: null, group: { mode: 'existing', groupKey } }
		]);
	} finally {
		await r.unmount();
	}
});

test('a name this wallet already holds is allowed, and said', async () => {
	const r = await createView(assetsBackend(), 'demo-main');
	try {
		assert.deepEqual([...r.test('mint-target').options].map((o) => o.textContent), ['A new asset', 'More of BUSD'], 'only what can be re-issued is offered');
		await type(r.test('mint-name'), 'BUSD');
		assert.match(r.test('mint-name-info').textContent, /You already hold an asset called BUSD\. This would be a different asset with the same name\./);
		assert.equal(r.test('mint-name-refusal'), null);
	} finally {
		await r.unmount();
	}
});

test('without the bitcoin for it, the cost says so and the button waits', async () => {
	const backend = assetsBackend();
	backend.setSpendable('demo-fresh', 900);
	const r = await createView(backend, 'demo-fresh');
	try {
		const refusal = r.test('mint-refusal');
		assert.equal(refusal.getAttribute('data-code'), 'INSUFFICIENT_SATS');
		assert.equal(
			refusal.textContent,
			'Minting costs 3,772 sats, but the wallet has to hold about 38,772 sats on-chain to build the transaction. What is not spent comes straight back. This wallet has 900 sats. Deposit bitcoin on the Receive tab first.'
		);
		assert.equal(r.test('mint-submit').disabled, true);

		// A lower fee rate is re-priced, and still honest about being short.
		await click(r.$$('.preset-row button').find((b) => /^Slow/.test(b.textContent)));
		await settle(PRICED_MS);
		assert.match(r.test('mint-cost').textContent, /Miner fee308 satsat 2 sat\/vB over 154 vB/);
		assert.match(r.test('mint-refusal').textContent, /^Minting costs 1,308 sats, but the wallet has to hold about 4,308 sats on-chain .* This wallet has 900 sats\./);
	} finally {
		await r.unmount();
	}
});

test('metadata that claims to be JSON has to parse', async () => {
	const backend = assetsBackend();
	const r = await createView(backend, 'demo-fresh');
	try {
		await type(r.test('mint-name'), 'Gold');
		await type(r.test('mint-amount'), '5');
		await click(pill(r, 'JSON'));
		await type(r.test('mint-meta'), '{"issuer": ');
		assert.match(r.test('mint-meta-refusal').textContent, /^This is not valid JSON: /);
		assert.match(r.test('asset-create').textContent, /11 bytes · Published with the asset and public for good\. Put nothing private here\./);
		await settle(PRICED_MS);
		await click(r.test('mint-submit'));
		await settle(50);
		assert.equal(backend.posted('/mint').length, 0, 'and it is not minted until it does');

		await type(r.test('mint-meta'), '{"issuer": "Beignet"}');
		assert.equal(r.test('mint-meta-refusal'), null);
		await click(r.test('mint-submit'));
		await settle(50);
		assert.deepEqual(backend.posted('/mint')[0].body.seedlings[0].meta, { type: 'json', data: '{"issuer": "Beignet"}' });
	} finally {
		await r.unmount();
	}
});
