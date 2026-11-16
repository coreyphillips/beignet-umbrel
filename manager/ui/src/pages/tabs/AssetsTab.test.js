/**
 * Run with: npm test (from manager/ui).
 *
 * The Assets tab as a whole, over the demo's own backend with the clock in
 * the test's hand (test/assets-backend.mjs). What is pinned here is what a
 * person would notice going wrong: an amount losing its last digit, a mint
 * that vanishes when the page is left, a form emptied by a look at Holdings,
 * a Lightning button on a wallet that has no Lightning.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assetsBackend, follow, mountAssets } from '../../../test/assets-backend.mjs';
import { click, select, settle, type } from '../../../test/render.mjs';
import { BACKUP_EVENT } from '../../lib/backup.js';
import { createFromDraft, draftOf } from './AssetsTab.jsx';
import { EMPTY_CREATE, EMPTY_SEEDLING } from './assets/CreateView.jsx';

test.beforeEach(() => sessionStorage.clear());

// A mint's whole life in the demo: the first block, five more, the proofs.
const MINT_DONE_MS = 6000 + 5 * 5000 + 4000;

/** Describe an asset on the Create view, and wait for it to be priced. */
async function describe(r, { name, decimals, amount }) {
	await type(r.test('mint-name'), name);
	if (decimals) await select(r.test('mint-decimals'), String(decimals));
	await type(r.test('mint-amount'), amount);
	await settle(300);
}

test('an empty wallet is invited to create or receive, and told the limits first', async () => {
	const r = await mountAssets(assetsBackend(), 'demo-fresh');
	try {
		assert.ok(r.test('assets-empty'));
		assert.match(r.test('assets-empty').textContent, /No assets yet/);
		assert.equal(r.test('asset-rows'), null, 'no empty table stands in for holdings');
		const limits = r.test('asset-limits').textContent;
		assert.match(limits, /recovery phrase alone does not bring assets back/);
		assert.match(limits, /cannot be fee-bumped yet/);
		assert.match(limits, /universe\.lightning\.finance:10029/, 'the proof server is named, not alluded to');
		// The one bitcoin fact a first mint needs is in the tiles' place.
		await click(r.test('assets-empty-receive'));
		await settle(450);
		assert.equal(r.test('assets-tab').getAttribute('data-view'), 'receive');
		await r.view('Holdings');
		await click(r.test('assets-empty-create'));
		await settle(450);
		assert.equal(r.test('assets-tab').getAttribute('data-view'), 'create');
		assert.ok(r.test('mint-name'), 'the form, with nothing to agree to on the way, on mainnet as anywhere');
		assert.equal(document.querySelector('[role="dialog"]'), null);
	} finally {
		await r.unmount();
	}
});

test('a holding above 2^53 is shown to the digit', async () => {
	const r = await mountAssets(assetsBackend(), 'demo-main');
	try {
		const rows = r.$$('[data-testid^="asset-row-"]');
		assert.deepEqual(rows.map((a) => a.querySelector('.asset-name').textContent), ['BUSD', 'Club Points', 'Pico']);
		const pico = rows[2];
		// 9007199254740993 units at 8 places. Through a JS number the last digit is a 2.
		assert.match(pico.textContent, /90,071,992\.54740993/);
		assert.match(rows[0].textContent, /14,900\.00/);
		assert.match(rows[0].textContent, /on-chain 12,500\.00 · lightning 2,400\.00/, 'and where a balance is in two places, both are said');
		assert.match(rows[1].textContent, /4,200/);
		assert.equal(r.$$('[data-testid^="asset-tile-"]').length, 2, 'collectibles are shown as what they are, not as a balance of 1');
		assert.match(r.test('assets-locked-sats').textContent, /6,000\s*sats/);
		assert.equal(r.test('asset-progress'), null, 'nothing in progress, so no card for it');
	} finally {
		await r.unmount();
	}
});

test('an asset opens to its own page, and Back returns to the list', async () => {
	const backend = assetsBackend();
	const r = await mountAssets(backend, 'demo-main', { at: {} });
	try {
		const row = r.$('[data-testid^="asset-row-"]');
		assert.match(row.getAttribute('href'), /\/w\/demo-main\/assets\?asset=02[0-9a-f]{64}$/, 'a row is a link, so it can be opened in a new tab');
		await follow(row);
		assert.deepEqual(r.moves.at(-1), ['assets', { query: { asset: row.getAttribute('data-key') } }], 'and its place is in the address');
		const detail = r.test('asset-detail');
		assert.equal(detail.getAttribute('data-key'), row.getAttribute('data-key'));
		assert.match(r.test('asset-detail-balance').textContent, /14,900\.00\s*BUSD/);
		assert.match(detail.textContent, /1f2268a6/, 'the ID is on the page, because the name proves nothing');
		assert.equal(r.$('.assets-bar'), null, 'the bar of views gives way to the way back');
		assert.equal(r.tests('asset-history-row').length, 6, 'its own history, and nobody else\'s');

		await follow(r.test('asset-back'));
		assert.equal(r.test('asset-detail'), null);
		assert.ok(r.test('asset-rows'));
	} finally {
		await r.unmount();
	}
});

test('an asset this wallet does not hold says so, with the way back', async () => {
	const r = await mountAssets(assetsBackend(), 'demo-main', { at: { asset: 'ab'.repeat(32) } });
	try {
		await settle(50);
		assert.ok(r.test('asset-missing'));
		assert.match(r.test('asset-missing').textContent, /does not hold/);
		assert.ok(r.test('asset-back'));
	} finally {
		await r.unmount();
	}
});

test('a mint in progress is still there after the tab is left and reopened', async () => {
	const backend = assetsBackend();
	let r = await mountAssets(backend, 'demo-fresh');
	try {
		await r.view('Create');
		await describe(r, { name: 'BUSD', decimals: 2, amount: '1000000' });
		assert.match(r.test('mint-cost').textContent, /2,772 sats/);
		await click(r.test('mint-submit'));
		await settle(50);
		assert.equal(r.test('mint-timeline').getAttribute('data-state'), 'broadcast');
		assert.equal(backend.posted('/mint').length, 1);
	} finally {
		await r.unmount();
	}

	// Another page, another day: the tab is mounted from nothing.
	r = await mountAssets(backend, 'demo-fresh');
	try {
		const items = r.tests('asset-progress-item');
		assert.equal(items.length, 1, 'Holdings has it under In progress');
		assert.equal(items[0].getAttribute('data-kind'), 'mint');
		assert.match(items[0].textContent, /Minting BUSD/);

		await r.view('Create');
		assert.ok(r.test('mint-timeline'), 'and Create still shows it, not an empty form');
		assert.equal(r.test('mint-name'), null);

		await r.pass(6000 + 2 * 5000);
		assert.equal(r.test('mint-timeline').getAttribute('data-state'), 'confirming');
		assert.equal(r.$('[data-testid="conf-meter"]').getAttribute('aria-label'), '3 of 6 confirmations');

		await r.pass(MINT_DONE_MS);
		assert.equal(r.test('mint-timeline').getAttribute('data-state'), 'complete');
		await click(r.test('mint-view-holdings'));
		await settle(450);
		const row = r.$('[data-testid^="asset-row-"]');
		assert.match(row.textContent, /BUSD/);
		assert.match(row.textContent, /1,000,000\.00/);
		assert.equal(r.test('asset-progress'), null, 'and it is no longer in progress');
		assert.equal(backend.posted('/mint').length, 1, 'none of which minted it again');
	} finally {
		await r.unmount();
	}
});

test('a half-described asset survives a reload, and can be discarded', async () => {
	const backend = assetsBackend();
	let r = await mountAssets(backend, 'demo-fresh');
	try {
		await r.view('Create');
		await describe(r, { name: 'Club Points', amount: '5000' });
		await click(r.test('mint-add-another'));
		await describe(r, { name: 'Founders Pass', amount: '25' });
	} finally {
		await r.unmount();
	}
	assert.ok(sessionStorage.getItem('beignet-asset-draft-demo-fresh'), 'kept in this browser tab, per wallet');
	assert.equal(backend.posted('/mint').length, 0, 'and nothing about it has reached the wallet');

	r = await mountAssets(backend, 'demo-fresh');
	try {
		await r.view('Create');
		assert.match(r.test('mint-draft-note').textContent, /Picked up where you left off: 2 assets waiting to be minted\./);
		assert.equal(r.test('mint-name').value, 'Founders Pass');
		assert.equal(r.test('mint-amount').value, '25');
		assert.deepEqual(r.tests('mint-batch-item').map((li) => li.querySelector('.mint-batch-name').textContent), ['5,000 Club Points']);
		assert.equal(r.test('mint-submit').textContent, 'Create 2 assets');

		await click(r.test('mint-draft-discard'));
		await settle(50);
		assert.equal(r.test('mint-draft-note'), null);
		assert.equal(r.test('mint-name').value, '');
		assert.equal(r.tests('mint-batch-item').length, 0);
		assert.equal(sessionStorage.getItem('beignet-asset-draft-demo-fresh'), null);
	} finally {
		await r.unmount();
	}

	// Another wallet's tab is another tab: it is not handed this one's draft.
	sessionStorage.setItem('beignet-asset-draft-demo-fresh', JSON.stringify({ form: { name: 'Mine' }, batch: [] }));
	r = await mountAssets(backend, 'demo-witness');
	try {
		await r.view('Create');
		assert.equal(r.test('mint-draft-note'), null);
		assert.equal(r.test('mint-name').value, '');
	} finally {
		await r.unmount();
	}
});

test('a draft keeps what was typed and which mint is being watched, and nothing else', () => {
	assert.equal(draftOf(EMPTY_CREATE), null, 'an untouched form is not worth keeping');
	const form = { ...EMPTY_SEEDLING, name: 'BUSD', text: '100', units: '100' };
	assert.deepEqual(draftOf({ ...EMPTY_CREATE, form }), { form, batch: [], feeRate: '', mintedRowId: null });
	assert.deepEqual(draftOf({ ...EMPTY_CREATE, minted: { rowId: 'row-1', row: { id: 'row-1', state: 'broadcast' } } }), {
		form: EMPTY_SEEDLING,
		batch: [],
		feeRate: '',
		mintedRowId: 'row-1'
	});

	assert.equal(createFromDraft(null), EMPTY_CREATE);
	assert.equal(createFromDraft('nonsense'), EMPTY_CREATE);
	const back = createFromDraft({ form: { name: 'BUSD' }, batch: [{ name: 'Points', text: '5', units: '5' }, null, 7], feeRate: 12, mintedRowId: 'row-1' });
	assert.deepEqual(back.form, { ...EMPTY_SEEDLING, name: 'BUSD' }, 'a field a stored draft lacks takes its starting value');
	assert.deepEqual(back.batch, [{ ...EMPTY_SEEDLING, name: 'Points', text: '5', units: '5' }], 'and what is not an asset is left out');
	assert.equal(back.feeRate, '');
	assert.deepEqual(back.minted, { rowId: 'row-1', row: null });
	assert.equal(back.restored, 2);
	assert.equal(createFromDraft({ form: {}, batch: [] }).restored, 0);
});

test('a draft that cannot be read costs nothing but the draft', async () => {
	sessionStorage.setItem('beignet-asset-draft-demo-fresh', '{not json');
	const r = await mountAssets(assetsBackend(), 'demo-fresh');
	try {
		await r.view('Create');
		assert.equal(r.test('mint-draft-note'), null);
		assert.equal(r.test('mint-name').value, '');
	} finally {
		await r.unmount();
	}
});

test('the backup is asked for when assets changed since the last one', async () => {
	const backend = assetsBackend();
	const asked = [];
	const listen = (e) => asked.push(e.detail.mode);
	window.addEventListener(BACKUP_EVENT, listen);
	const r = await mountAssets(backend, 'demo-main');
	try {
		const warnings = r.tests('asset-warning');
		assert.deepEqual(warnings.map((w) => w.getAttribute('data-code')), ['BACKUP_STALE']);
		assert.equal(warnings[0].getAttribute('role'), 'status', 'a reminder, not an alarm');
		assert.match(warnings[0].textContent, /Your assets changed since the backup 3 days ago/);
		await click(r.test('asset-backup-now'));
		assert.deepEqual(asked, ['export'], 'the button opens the backup dialog the header opens');
	} finally {
		window.removeEventListener(BACKUP_EVENT, listen);
		await r.unmount();
	}

	// One whose backup is current is told so, quietly, under its holdings.
	const saved = await mountAssets(backend, 'demo-savings');
	try {
		assert.deepEqual(saved.tests('asset-warning'), []);
		assert.match(saved.test('assets-backed-up').textContent, /2 hours ago/);
	} finally {
		await saved.unmount();
	}
});

test('an on-chain only wallet is shown no Lightning for its assets', async () => {
	const backend = assetsBackend();
	const r = await mountAssets(backend, 'demo-savings', { at: {} });
	try {
		assert.doesNotMatch(r.test('asset-limits-holdings').textContent, /Lightning/);
		// Its seeded mint, found part way through its confirmations.
		const items = r.tests('asset-progress-item');
		assert.equal(items.length, 1);
		assert.match(items[0].textContent, /Minting Silver Ounce: 2 of 6 confirmations/);

		await follow(r.$('[data-testid^="asset-row-"]'));
		assert.ok(r.test('asset-detail'));
		assert.equal(r.test('asset-action-open-channel'), null);
		assert.doesNotMatch(r.test('asset-detail').textContent, /Lightning|channel/i);
		assert.ok(r.test('asset-action-send') && r.test('asset-action-receive') && r.test('asset-action-burn'), 'everything on-chain is still there');
	} finally {
		await r.unmount();
	}
});

test('Lightning for assets stays out of sight until the app says it is there', async () => {
	const backend = assetsBackend();
	// The same wallet, with a funded asset channel, under an app that has not
	// switched asset channels on.
	const off = await mountAssets(backend, 'demo-main', { at: {}, config: { assetsAvailable: true, assetChannelsAvailable: false } });
	try {
		await follow(off.$('[data-testid^="asset-row-"]'));
		assert.ok(off.test('asset-detail'));
		assert.equal(off.test('asset-action-open-channel'), null);
		assert.doesNotMatch(off.test('asset-detail').textContent, /lightning ready/);
	} finally {
		await off.unmount();
	}

	const on = await mountAssets(backend, 'demo-main', { at: {} });
	try {
		await follow(on.$('[data-testid^="asset-row-"]'));
		assert.match(on.test('asset-detail').textContent, /lightning ready/);
		await click(on.test('asset-action-open-channel'));
		const [to, options] = on.moves.at(-1);
		assert.equal(to, 'channels', 'opening a channel is the Channels tab\'s work, and it is told which asset');
		assert.equal(options.state.openAsset, on.test('asset-detail').getAttribute('data-key'));
	} finally {
		await on.unmount();
	}
});

test('what was typed into a view is still there after a look at another', async () => {
	const r = await mountAssets(assetsBackend(), 'demo-main');
	try {
		await r.view('Send');
		await type(r.test('asset-send-input'), 'tapbc1qqqsqq');
		await r.view('Receive');
		await click(r.$('[data-testid^="asset-chip-"]'));
		await type(r.test('asset-receive-amount'), '250');
		await r.view('Holdings');
		await r.view('Send');
		assert.equal(r.test('asset-send-input').value, 'tapbc1qqqsqq');
		await r.view('Receive');
		assert.equal(r.test('asset-receive-amount').value, '250');
		assert.equal(r.$('[data-testid^="asset-chip-"]').getAttribute('aria-checked'), 'true');
	} finally {
		await r.unmount();
	}
});

test('a late proof can be asked for again from the list', async () => {
	const backend = assetsBackend();
	const r = await mountAssets(backend, 'demo-testnet');
	try {
		const items = r.tests('asset-progress-item');
		assert.deepEqual(items.map((li) => li.getAttribute('data-state')).sort(), ['confirming', 'proofs']);
		const late = r.test('asset-proof-late');
		assert.match(late.textContent, /testnet\.universe\.lightning\.finance:10029/);
		assert.match(late.textContent, /The asset is not lost: the wallet keeps asking/);
		await click(r.test('asset-proof-retry'));
		await settle(50);
		assert.deepEqual(backend.posted('/proofs/retry').map((c) => typeof c.body.id), ['string']);
		assert.deepEqual(r.toasts(), ['Asking the proof server again']);

		await r.pass(4000);
		assert.equal(r.test('asset-proof-late'), null, 'and when it comes, the note goes');
		// A balance that changes counts up to its new figure.
		await settle(900);
		const tusd = r.$$('[data-testid^="asset-row-"]').find((a) => a.querySelector('.asset-name').textContent === 'tUSD');
		assert.match(tusd.textContent, /5,125\.00/, 'and the 125.00 that was waiting on it is held');
	} finally {
		await r.unmount();
	}
});

/** A wallet whose assets host answers /status with `status`, and nothing else. */
const stubApi = (status) => ({
	get: async (path) => {
		if (path.startsWith('/x/assets/status')) {
			if (status instanceof Error) throw status;
			return status;
		}
		if (path === '/fees/estimates') return { fast: 18, normal: 7, slow: 2 };
		throw Object.assign(new Error('not asked for'), { code: 'NOT_FOUND', status: 404 });
	},
	post: async () => {
		throw Object.assign(new Error('not asked for'), { code: 'NOT_FOUND', status: 404 });
	}
});

/** A wallet's record with what the manager says of its assets host. */
const recordOf = (assets) => ({ id: 'w1', network: 'mainnet', assets: { enabled: true, universe: null, ...assets } });

/** An error as the API layer hands one on: the host's own code, and the status. */
const refused = (code, message, status = 503) => Object.assign(new Error(message), { code, status });

test('a host that is starting says so quietly, and the page carries on when it is up', async () => {
	const backend = assetsBackend();
	backend.mock.setHost('demo-main', 'starting');
	const r = await mountAssets(backend, 'demo-main');
	try {
		const card = r.test('assets-starting');
		assert.equal(card.getAttribute('role'), 'status', 'said, not sounded as an alarm');
		assert.match(card.textContent, /Assets are starting/);
		assert.match(card.textContent, /checking its proofs \(3 of 12\)/);
		assert.equal(r.test('assets-tab').getAttribute('data-host'), 'starting');
		assert.equal(r.$('.assets-bar'), null, 'with no views offered to something that cannot answer them');
		assert.equal(r.test('asset-warning'), null, 'and no warnings about a wallet that has not been read yet');
		assert.equal(r.$('.skeleton'), null, 'nor a placeholder for figures that are not being fetched');
		assert.deepEqual(r.toasts(), []);
		assert.deepEqual(
			[...new Set(backend.asked('demo-main').filter((c) => c.includes('/x/assets')))],
			['GET /x/assets/status'],
			'nothing but the status is asked of a host that is not ready'
		);

		backend.mock.setHost('demo-main', null);
		await r.refresh();
		await settle(60);
		assert.equal(r.test('assets-starting'), null);
		assert.ok(r.$('.assets-bar'), 'the views, without a reload');
		assert.ok(r.test('asset-rows'));
	} finally {
		await r.unmount();
	}

	// A host that does not count its proofs gets the sentence without a count.
	const bare = await mountAssets(null, 'w1', { api: stubApi({ ready: false, phase: 'starting' }) });
	try {
		assert.match(bare.test('assets-starting').textContent, /The wallet is checking its proofs\. /);
		assert.equal(bare.$('.asset-notice-bar'), null);
	} finally {
		await bare.unmount();
	}
});

test('a host that could not start is one calm card: the reason, and that the bitcoin is unaffected', async () => {
	const backend = assetsBackend();
	backend.mock.setHost('demo-main', 'failed');
	const r = await mountAssets(backend, 'demo-main', { at: {} });
	try {
		const card = r.test('assets-unavailable');
		assert.match(card.textContent, /Assets are unavailable on this wallet right now/);
		assert.match(card.textContent, /The bitcoin wallet is unaffected/);
		assert.equal(
			r.test('assets-unavailable-reason').textContent,
			'The proof store could not be opened: its file is from a newer version of the app.',
			"the host's own sentence, ended like one"
		);
		assert.equal(r.tests('assets-unavailable').length, 1, 'one card');
		assert.equal(r.test('assets-tab').getAttribute('data-host'), 'unavailable');
		assert.equal(r.$('.assets-bar'), null);
		assert.equal(r.test('asset-warning'), null, 'no row of warnings above it');
		assert.equal(r.$('.skeleton'), null, 'no placeholder left waiting');
		assert.equal(r.$('.error-note'), null, 'and nothing in red');
		assert.deepEqual(r.toasts(), [], 'nor a toast');
		assert.equal(r.test('assets-unavailable-settings'), null, 'the setting is offered only to a wallet with a server of its own');

		// However long it is left open, it stays the one card.
		await r.refresh();
		await r.refresh();
		assert.equal(r.tests('assets-unavailable').length, 1);
		assert.deepEqual(r.toasts(), []);
		assert.deepEqual([...new Set(backend.asked('demo-main').filter((c) => c.includes('/x/assets')))], ['GET /x/assets/status']);

		await click(r.test('assets-unavailable-logs'));
		assert.deepEqual(r.moves.at(-1), ['logs', {}], 'the Logs tab, where the detail is');
	} finally {
		await r.unmount();
	}
});

test('every way the wallet has of saying the host is not there shows the same card', async () => {
	// The record says it failed, before the wallet has answered anything.
	const never = { get: () => new Promise(() => {}), post: () => new Promise(() => {}) };
	const early = await mountAssets(null, 'w1', {
		api: never,
		rec: recordOf({ phase: 'failed', error: 'The assets database is locked' })
	});
	try {
		assert.equal(early.test('assets-unavailable-reason').textContent, 'The assets database is locked.');
		assert.equal(early.test('assets-loading'), null, 'without waiting on a request that may never answer');
	} finally {
		await early.unmount();
	}

	// The engine loaded no assets module: the status route itself refuses.
	const unloaded = await mountAssets(null, 'w1', {
		api: stubApi(refused('EXTENSION_UNAVAILABLE', 'Extension "assets" is not available')),
		rec: recordOf({ phase: 'failed', error: 'The assets module could not be loaded' })
	});
	try {
		assert.equal(unloaded.test('assets-unavailable-reason').textContent, 'The assets module could not be loaded.');
		assert.equal(unloaded.test('assets-unreadable'), null);
	} finally {
		await unloaded.unmount();
	}

	// The same refusal with nothing in the record: the route's word is the reason.
	const bare = await mountAssets(null, 'w1', { api: stubApi(refused('ASSETS_UNAVAILABLE', 'The assets database is locked')) });
	try {
		assert.equal(bare.test('assets-unavailable-reason').textContent, 'The assets database is locked.');
	} finally {
		await bare.unmount();
	}

	// A status that says failed and gives no reason.
	const silent = await mountAssets(null, 'w1', { api: stubApi({ ready: false, phase: 'failed', error: null }) });
	try {
		assert.equal(silent.test('assets-unavailable-reason').textContent, 'The wallet gave no reason.');
	} finally {
		await silent.unmount();
	}

	// A wallet with a proof server of its own is offered that setting from the card.
	const custom = await mountAssets(null, 'w1', {
		api: stubApi({ ready: false, phase: 'failed', error: 'The proof server address could not be read' }),
		rec: recordOf({ phase: 'failed', universe: { courier: 'universerpc://u.example.com:10029', rest: 'https://u.example.com' } })
	});
	try {
		await click(custom.test('assets-unavailable-settings'));
		assert.ok(custom.test('asset-settings'), 'the dialog, though the views are not there');
		assert.equal(custom.test('asset-settings-host').value, 'u.example.com');
	} finally {
		await custom.unmount();
	}

	// Anything else that stops the wallet answering is not this card.
	const other = await mountAssets(null, 'w1', { api: stubApi(refused('NOT_RUNNING', 'Wallet is not running', 409)) });
	try {
		assert.match(other.test('assets-unreadable').textContent, /Assets could not be read from the wallet\./);
		assert.equal(other.test('assets-unavailable'), null);
	} finally {
		await other.unmount();
	}
});

test('a host that goes away under an open tab takes the views with it, and brings them back', async () => {
	const backend = assetsBackend();
	const r = await mountAssets(backend, 'demo-main');
	try {
		assert.ok(r.test('asset-rows'));

		// The wallet is being restarted: a brief wait, not a failure.
		backend.mock.setHost('demo-main', 'restarting');
		await r.refresh();
		const waiting = r.test('assets-restarting');
		assert.equal(waiting.getAttribute('role'), 'status');
		assert.match(waiting.textContent, /The wallet is restarting/);
		assert.equal(r.test('assets-unavailable'), null, 'not called unavailable');
		assert.equal(r.$('.assets-bar'), null);
		assert.equal(r.test('asset-warning'), null);
		assert.deepEqual(r.toasts(), []);

		// It comes back without its assets module.
		backend.mock.setHost('demo-main', 'unloaded');
		await r.refresh();
		assert.ok(r.test('assets-unavailable'), 'the last good status is not believed over a route that says gone');
		assert.equal(r.test('asset-rows'), null);

		backend.mock.setHost('demo-main', null);
		await r.refresh();
		await settle(60);
		assert.equal(r.test('assets-unavailable'), null);
		assert.ok(r.test('asset-rows'), 'and the holdings are back when it is');
	} finally {
		await r.unmount();
	}
});

test('with the proof server away, the warning stays and Send and Receive say what will wait', async () => {
	const backend = assetsBackend();
	backend.mock.setProofServer('demo-main', true);
	const r = await mountAssets(backend, 'demo-main');
	try {
		const warning = () => r.tests('asset-warning').find((w) => w.getAttribute('data-code') === 'PROOF_SERVER_DOWN');
		assert.match(warning().textContent, /universe\.lightning\.finance:10029\) is not answering/);
		assert.equal(r.test('asset-send-waits'), null, 'Holdings has nothing waiting to explain');

		await r.view('Send');
		assert.ok(warning(), 'the warning is still above the view');
		const send = r.test('asset-send-waits');
		assert.equal(send.getAttribute('role'), 'status');
		assert.match(send.textContent, /a send still goes out and confirms/);
		assert.match(send.textContent, /delivered when the server is back/);

		await r.view('Receive');
		assert.ok(warning());
		const receive = r.test('asset-receive-waits');
		assert.match(receive.textContent, /an address can still be made and paid/);
		assert.match(receive.textContent, /Nothing is lost while it waits/);

		// And when it answers again, both lines go with the warning.
		backend.mock.setProofServer('demo-main', false);
		await r.refresh();
		assert.equal(warning(), undefined);
		assert.equal(r.test('asset-receive-waits'), null);
		await r.view('Send');
		assert.equal(r.test('asset-send-waits'), null);
	} finally {
		await r.unmount();
	}
});

test('a send whose proof the proof server refused says who answered, what it means, and offers it again', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-main', 'send-refused'), true);
	assert.equal(backend.mock.seed('demo-main', 'send-refused'), false, 'once');
	const r = await mountAssets(backend, 'demo-main', { at: {} });
	try {
		const item = () => r.tests('asset-progress-item').find((li) => li.querySelector('[data-testid="asset-proof-undelivered"]'));
		assert.equal(item().getAttribute('data-kind'), 'send');
		assert.equal(item().getAttribute('data-state'), 'proofs');
		assert.ok(!item().classList.contains('failed'), 'a wait, not a failure');

		const note = item().querySelector('[data-testid="asset-proof-undelivered"]');
		assert.equal(note.getAttribute('data-code'), 'PROOF_REFUSED');
		assert.equal(note.getAttribute('role'), 'alert');
		assert.ok(note.classList.contains('error-note'), 'the recipient is waiting on it, so it is said in red');
		assert.match(note.textContent, /universe\.lightning\.finance:10029 answered and did not take this transfer's proof, so the recipient does not have the asset yet/);
		assert.match(note.textContent, /Nothing is lost: this wallet keeps the proof and offers it again/);
		// The timeline carries the server's own reason, and does not call it unreachable.
		assert.match(item().textContent, /did not take the proof: invalid split commitment proof \(HTTP 500\)/);
		assert.doesNotMatch(item().textContent, /is not answering/);

		const rowId = (await backend.api('demo-main').get('/x/assets/activity')).rows.find((x) => x.kind === 'send' && x.failure?.code === 'PROOF_REFUSED').id;
		await click(note.querySelector('[data-testid="asset-proof-retry"]'));
		await settle();
		assert.deepEqual(backend.posted('/proofs/retry', 'demo-main').map((c) => c.body), [{ id: rowId }]);
		await r.refresh();
		assert.equal(r.test('asset-proof-undelivered'), null, 'taken the second time, and the note goes');
	} finally {
		await r.unmount();
	}
});

test('a mint whose proof the proof server has not taken reads as created, never as failed', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-testnet', 'proof-refused'), true);
	const r = await mountAssets(backend, 'demo-testnet', { at: {} });
	try {
		const item = () => r.tests('asset-progress-item').find((li) => li.getAttribute('data-kind') === 'mint');
		assert.equal(item().getAttribute('data-state'), 'complete');
		assert.ok(!item().classList.contains('failed'));
		assert.equal(item().querySelector('.error-note'), null);
		assert.match(item().querySelector('.progress-title').textContent, /^Minted .*tUSD: the proof server has not taken its proof yet$/);

		const note = item().querySelector('[data-testid="asset-proof-unpublished"]');
		assert.equal(note.getAttribute('role'), 'status');
		assert.ok(note.classList.contains('info-note'), 'said in blue, not in red');
		assert.match(note.textContent, /tUSD is created and in your holdings/);
		assert.match(note.textContent, /testnet\.universe\.lightning\.finance:10029/);
		assert.match(note.textContent, /may not be able to verify it until it has/);
		assert.match(note.textContent, /The wallet keeps trying/);
		// Its timeline is a finished one.
		assert.ok([...item().querySelectorAll('li[data-step]')].every((li) => li.getAttribute('data-state') === 'done'));

		// The same on the asset's own page.
		const tusd = r.$$('.asset-row').find((a) => /tUSD/.test(a.textContent));
		await follow(tusd);
		assert.match(r.test('asset-proof-unpublished').textContent, /created and in your holdings/);

		const rowId = (await backend.api('demo-testnet').get('/x/assets/activity')).rows.find((x) => x.kind === 'mint').id;
		await click(r.test('asset-proof-retry'));
		await settle();
		assert.deepEqual(backend.posted('/proofs/retry', 'demo-testnet').map((c) => c.body), [{ id: rowId }]);
		await r.refresh();
		assert.equal(r.test('asset-proof-unpublished'), null, 'taken, so there is nothing left to say');
	} finally {
		await r.unmount();
	}
});

test('a stuck transaction can be broadcast again, and a refusal is said in the wallet\'s words', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-main', 'stuck'), true);
	const r = await mountAssets(backend, 'demo-main');
	try {
		const stuck = () => r.tests('asset-warning').find((w) => w.getAttribute('data-code') === 'STUCK');
		assert.match(stuck().textContent, /has waited 2 hours for its first block/);
		assert.match(stuck().textContent, /cannot be fee-bumped yet/);
		const button = stuck().querySelector('[data-testid="asset-rebroadcast"]');
		assert.equal(button.textContent, 'Broadcast again');

		const row = (await backend.api('demo-main').get('/x/assets/activity')).rows.find((x) => x.stuck);
		await click(button);
		await settle();
		assert.deepEqual(backend.posted('/transfers/rebroadcast', 'demo-main').map((c) => c.body), [{ id: row.id }]);
		assert.ok(r.toasts().some((t) => /Broadcast again/.test(t)));
		await r.refresh();
		assert.equal(stuck(), undefined, 'an hour is counted again from here');
	} finally {
		await r.unmount();
	}

	// The network not taking it is said as the wallet said it.
	const second = assetsBackend();
	second.mock.seed('demo-main', 'stuck');
	const real = second.api('demo-main');
	const api = {
		...real,
		post: (path, body, options) =>
			path === '/x/assets/transfers/rebroadcast'
				? Promise.reject(Object.assign(new Error('The network did not take the transaction: mempool min fee not met'), { code: 'BROADCAST_FAILED', status: 502 }))
				: real.post(path, body, options)
	};
	const r2 = await mountAssets(second, 'demo-main', { api });
	try {
		await click(r2.test('asset-rebroadcast'));
		await settle();
		assert.ok(r2.toasts().some((t) => /The network did not take the transaction: mempool min fee not met\./.test(t)));
		assert.ok(!r2.toasts().some((t) => /BROADCAST_FAILED/.test(t)));
		assert.ok(r2.test('asset-rebroadcast'), 'still stuck, so still offered');
	} finally {
		await r2.unmount();
	}
});

test('an address the wallet has stopped checking says so, and can be checked by hand', async () => {
	const backend = assetsBackend();
	assert.equal(backend.mock.seed('demo-testnet', 'unwatched'), true);
	const rows = async () => (await backend.api('demo-testnet').get('/x/assets/activity')).rows;
	const old = (await rows()).find((x) => x.watching === false);
	assert.equal(old.state, 'waiting');
	assert.ok((await rows()).filter((x) => x.id !== old.id).every((x) => x.watching === null || x.watching === true));

	const r = await mountAssets(backend, 'demo-testnet');
	try {
		await r.view('Receive');
		const line = () => r.tests('asset-receive-row').find((tr) => tr.getAttribute('data-state') === 'waiting');
		assert.match(line().textContent, /not checked/);
		await click(line());
		await settle();
		const note = r.test('asset-not-watched');
		assert.match(note.textContent, /This address is no longer checked automatically/);
		assert.equal(note.querySelector('[data-testid="asset-check-now"]').textContent, 'Check now');

		await click(r.test('asset-check-now'));
		await settle();
		assert.deepEqual(backend.posted('/addresses/check', 'demo-testnet').map((c) => c.body), [{ id: old.id }]);
		assert.ok(r.toasts().some((t) => /A payment to that address was found/.test(t)));
		await r.refresh();
		assert.equal(r.test('asset-not-watched'), null);
		assert.equal((await rows()).find((x) => x.id === old.id).watching, null, 'paid, so there is nothing to watch for');
	} finally {
		await r.unmount();
	}
});

test('the demo answers as the wallet does: version 1 addresses, one open preview, a test that names no network', async () => {
	const backend = assetsBackend();
	const main = backend.api('demo-main');
	const held = (await main.get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');

	const made = await backend.api('demo-witness').post('/x/assets/addresses', { key: held.key, amount: '10000' });
	assert.equal(made.address.version, 1);
	assert.match(made.address.courier, /^universerpc:\/\//);
	assert.equal(made.row.watching, true, 'a new address is looked at by itself');

	// Preparing a burn drops the open send preview: there is one per wallet.
	const send = await main.post('/x/assets/send/prepare', { address: made.address.encoded });
	await main.post('/x/assets/burn/prepare', { key: held.key, amount: '100' });
	await assert.rejects(main.post('/x/assets/send/commit', { previewId: send.previewId }), (e) => e.code === 'PREVIEW_EXPIRED');

	const tested = await main.post('/x/assets/proof-server/test', { rest: 'https://universe.lightning.finance' });
	assert.equal(tested.reachable, true);
	assert.equal(tested.network, null);
});
