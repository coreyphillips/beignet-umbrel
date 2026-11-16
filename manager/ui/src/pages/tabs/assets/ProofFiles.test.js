/**
 * Run with: npm test (from manager/ui).
 *
 * A proof handed over as a file. A transfer is complete for the recipient
 * once they hold its proof, and a proof server is only the usual way it gets
 * there. When a server will not carry one, the sender saves the file and
 * the recipient imports it. What is pinned here is that both ends are
 * offered that where they are stuck, that a file is never taken without
 * the wallet being asked, and that a refusal is a sentence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { assetsBackend, follow, mountAssets } from '../../../../test/assets-backend.mjs';
import { click, settle } from '../../../../test/render.mjs';

test.beforeEach(() => sessionStorage.clear());

/** What the page hands the browser to download, instead of a download. */
function downloads(t) {
	const saved = [];
	const blobs = new Map();
	const create = URL.createObjectURL;
	const revoke = URL.revokeObjectURL;
	const press = window.HTMLAnchorElement.prototype.click;
	URL.createObjectURL = (blob) => {
		const url = `blob:test-${blobs.size + 1}`;
		blobs.set(url, blob);
		return url;
	};
	URL.revokeObjectURL = () => {};
	window.HTMLAnchorElement.prototype.click = function () {
		if (this.download) saved.push({ name: this.download, blob: blobs.get(this.getAttribute('href')) });
		else press.call(this);
	};
	t.after(() => {
		URL.createObjectURL = create;
		URL.revokeObjectURL = revoke;
		window.HTMLAnchorElement.prototype.click = press;
	});
	return saved;
}

/** Pick `file` in a file input, as the browser's chooser would. */
async function choose(input, file) {
	Object.defineProperty(input, 'files', { value: [file], configurable: true });
	await act(async () => {
		input.dispatchEvent(new window.Event('change', { bubbles: true }));
	});
	await settle(60);
}

const fileOf = (out) => new File([Buffer.from(out.file, 'base64')], out.fileName);
const lastToast = (r) => r.toasts().at(-1);

// A send between two demo wallets: a block at 6 s, the proof due at 10 s.
// The receive is six blocks deep 14 s after it was paid.
const SEND_AT_PROOFS_MS = 10_500;
const RECEIVE_DEEP_MS = 4_000;

/** demo-main pays an address demo-witness made, while demo-witness's proof server is away. */
async function paidWithNoServer(backend, amount = '10000') {
	const main = backend.api('demo-main');
	const witness = backend.api('demo-witness');
	const held = (await main.get('/x/assets/balances')).assets.find((a) => a.name === 'BUSD');
	backend.mock.setProofServer('demo-witness', true);
	const made = await witness.post('/x/assets/addresses', { key: held.key, amount });
	const preview = await main.post('/x/assets/send/prepare', { address: made.address.encoded });
	const sent = await main.post('/x/assets/send/commit', { previewId: preview.previewId });
	return { main, witness, held, made, sent: sent.row };
}

test('a send the proof server refused offers its proof file, and can be settled by hand and unsettled', async (t) => {
	const saved = downloads(t);
	const backend = assetsBackend();
	backend.mock.seed('demo-main', 'send-refused');
	const main = backend.api('demo-main');
	const refused = (await main.get('/x/assets/activity')).rows.find((x) => x.kind === 'send' && x.failure?.code === 'PROOF_REFUSED');
	const r = await mountAssets(backend, 'demo-main', { at: {} });
	try {
		const note = () => r.test('asset-proof-undelivered');
		assert.match(note().textContent, /You can also save the proof file and give it to the recipient, who imports it on their Receive page\./);
		assert.deepEqual(
			[...note().querySelectorAll('button')].map((b) => b.textContent),
			['Offer it again now', 'Save the proof file', 'Mark as handed over']
		);
		const busy = (await main.get('/x/assets/status')).pending.sends;

		// Saving asks the wallet for the file and hands it to the browser. Nothing else changes.
		await click(r.test('asset-proof-save'));
		await settle(30);
		assert.deepEqual(backend.calls.filter((c) => c.route === '/x/assets/proofs/export').map((c) => c.query), [`id=${refused.id}`]);
		assert.equal(saved.length, 1);
		assert.match(saved[0].name, /^proof-[0-9a-f]{8}-[0-9a-f]{8}\.assetproof$/);
		const out = await main.get(`/x/assets/proofs/export?id=${refused.id}`);
		assert.deepEqual(Buffer.from(await saved[0].blob.arrayBuffer()), Buffer.from(out.file, 'base64'), 'the bytes the wallet gave, not their base64');
		assert.equal(lastToast(r), 'Proof file saved. Give it to the recipient to import on their Receive page.');
		assert.ok(note(), 'saving a file settles nothing by itself');

		// The sender's word that the recipient has it: the send is no longer something going on.
		await click(r.test('asset-proof-handed'));
		await settle(30);
		assert.deepEqual(backend.posted('/proofs/handed-over', 'demo-main').map((c) => c.body), [{ id: refused.id, handedOver: true }]);
		assert.equal(lastToast(r), 'Marked as handed over. The recipient has the asset once they import the file.');
		assert.equal(note(), null);
		assert.equal(r.tests('asset-progress-item').some((li) => li.getAttribute('data-kind') === 'send'), false, 'it left In progress');
		assert.equal((await main.get('/x/assets/status')).pending.sends, busy - 1, 'and the count beside the tab');

		// It is still there to look at, on the asset's page, saying what was done and how to take it back.
		await follow(r.$(`[data-testid="asset-row-${refused.assets[0].key.slice(0, 8)}"]`));
		const row = r.tests('asset-history-row').find((tr) => /handed over/.test(tr.textContent));
		assert.ok(row, 'the history says "handed over"');
		await click(row);
		await settle(50);
		const detail = r.test('asset-transfer-detail');
		const settled = detail.querySelector('[data-testid="asset-proof-handed-over"]');
		assert.equal(settled.getAttribute('role'), 'status');
		assert.ok(settled.classList.contains('info-note'), 'said calmly: nothing is wrong any more');
		assert.match(settled.textContent, /You marked this transfer's proof as handed over\. The recipient has the asset once they import the file\./);
		assert.match(settled.textContent, /still offers the proof to universe\.lightning\.finance:10029 from time to time/);
		assert.match(detail.textContent, /Proof handed over/);
		assert.match(detail.textContent, /Given to the recipient as a file\./);
		assert.match(detail.textContent, /Proof file/);

		await click(detail.querySelector('[data-testid="asset-proof-handed-undo"]'));
		await settle(30);
		assert.deepEqual(backend.posted('/proofs/handed-over', 'demo-main').at(-1).body, { id: refused.id, handedOver: false });
		assert.equal(r.test('asset-proof-handed-over'), null);
		assert.ok(r.test('asset-transfer-detail').querySelector('[data-testid="asset-proof-undelivered"]'), 'back to waiting on the server');
		assert.equal((await main.get('/x/assets/status')).pending.sends, busy);
	} finally {
		await r.unmount();
	}
});

test('a proof no server carried is saved by the sender and completes the receive when it is imported', async (t) => {
	const saved = downloads(t);
	const backend = assetsBackend();
	const { main, witness, held, made, sent } = await paidWithNoServer(backend);

	// The sender's side, under In progress: the server is away, and there is a file to give.
	backend.pass(SEND_AT_PROOFS_MS);
	const unsent = (await main.get('/x/assets/activity')).rows.find((x) => x.id === sent.id);
	assert.deepEqual([unsent.state, unsent.failure.code], ['proofs', 'COURIER_UNREACHABLE']);
	const sender = await mountAssets(backend, 'demo-main', { at: {} });
	let out;
	try {
		const note = sender.test('asset-proof-undelivered');
		assert.equal(note.getAttribute('data-code'), 'COURIER_UNREACHABLE');
		assert.ok(note.classList.contains('info-note'), 'a server that is away is said in blue');
		assert.match(note.textContent, /If it does not get through, save the proof file and give it to the recipient to import\./);
		await click(note.querySelector('[data-testid="asset-proof-save"]'));
		await settle(30);
		assert.equal(saved.length, 1);
		out = await main.get(`/x/assets/proofs/export?id=${sent.id}`);
		assert.deepEqual([out.address, out.txid], [made.address.encoded, sent.txid]);
	} finally {
		await sender.unmount();
	}

	// The recipient's side: confirmed, no proof, and the same file ends the wait.
	backend.pass(RECEIVE_DEEP_MS);
	const waiting = (await witness.get('/x/assets/activity')).rows.find((x) => x.id === made.row.id);
	assert.deepEqual([waiting.state, waiting.failure.code], ['proofs', 'PROOF_UNAVAILABLE']);
	const before = (await witness.get('/x/assets/balances')).assets.find((a) => a.key === held.key);
	assert.equal(before, undefined, 'nothing is held until the proof is');

	const r = await mountAssets(backend, 'demo-witness', { at: { view: 'receive' } });
	try {
		// Offered on the Receive page whether or not anything is waiting.
		const handover = r.test('asset-proof-handover');
		assert.match(handover.textContent, /A sender can give you the proof file of a payment to this wallet\./);
		assert.match(handover.textContent, /the wallet verifies it before it takes anything from it, and no proof server is needed/);
		assert.equal(r.test('asset-proof-import').textContent, 'Import a proof file');

		// And on the receive that is stuck, in its own note.
		await click(r.tests('asset-receive-row').find((tr) => tr.getAttribute('data-state') === 'proofs'));
		await settle(50);
		const late = r.test('asset-transfer-detail').querySelector('[data-testid="asset-proof-late"]');
		assert.match(late.textContent, /Or ask the sender for the proof file and import it here: no proof server is needed for that\./);
		assert.equal(late.querySelector('[data-testid="asset-proof-late-import"]').textContent, 'Import the proof file');

		await choose(late.querySelector('[data-testid="asset-proof-late-import-file"]'), new File([await saved[0].blob.arrayBuffer()], saved[0].name));
		assert.deepEqual(backend.posted('/proofs/import', 'demo-witness').map((c) => c.body), [{ file: out.file }]);
		assert.equal(lastToast(r), 'The proof checks out, and the asset is in your holdings.');
		assert.equal(r.test('asset-transfer-detail').getAttribute('data-state'), 'complete');
		assert.equal(r.test('asset-proof-late'), null);
		const after = (await witness.get('/x/assets/balances')).assets.find((a) => a.key === held.key);
		assert.equal(after.balance.onchain, '10000');

		// The same file again changes nothing, and says so.
		await choose(r.test('asset-proof-import-file'), fileOf(out));
		assert.equal(backend.posted('/proofs/import', 'demo-witness').length, 2);
		assert.equal(lastToast(r), 'This wallet already has that payment. Nothing changed.');
		assert.equal((await witness.get('/x/assets/balances')).assets.find((a) => a.key === held.key).balance.onchain, '10000', 'not credited twice');
	} finally {
		await r.unmount();
	}
});

test('a proof file imported before the payment is deep enough is kept, and said to be', async () => {
	const backend = assetsBackend();
	const { main, witness, made, sent } = await paidWithNoServer(backend);
	backend.pass(SEND_AT_PROOFS_MS);
	const out = await main.get(`/x/assets/proofs/export?id=${sent.id}`);
	const early = (await witness.get('/x/assets/activity')).rows.find((x) => x.id === made.row.id);
	assert.equal(early.state, 'confirming');

	const r = await mountAssets(backend, 'demo-witness', { at: { view: 'receive' } });
	try {
		await choose(r.test('asset-proof-import-file'), fileOf(out));
		assert.equal(lastToast(r), 'The proof file is kept. The asset arrives once its transaction is 6 blocks deep, with no proof server needed.');
		await r.pass(RECEIVE_DEEP_MS + 5_000);
		const done = (await witness.get('/x/assets/activity')).rows.find((x) => x.id === made.row.id);
		assert.equal(done.state, 'complete', 'the kept file finished it: the server is still away');
		assert.equal(backend.posted('/proofs/retry', 'demo-witness').length, 0);
	} finally {
		await r.unmount();
	}
});

test('a file that is not this payment\'s proof is refused in a sentence, and nothing is taken from it', async () => {
	const backend = assetsBackend();
	const { main, witness, held, sent } = await paidWithNoServer(backend);
	backend.pass(SEND_AT_PROOFS_MS + RECEIVE_DEEP_MS);
	const out = await main.get(`/x/assets/proofs/export?id=${sent.id}`);
	const holds = async (api) => ((await api.get('/x/assets/balances')).assets.find((a) => a.key === held.key) || { balance: { onchain: '0' } }).balance.onchain;

	const r = await mountAssets(backend, 'demo-witness', { at: { view: 'receive' } });
	try {
		const input = () => r.test('asset-proof-import-file');
		// Not a proof file at all.
		await choose(input(), new File(['holiday photo'], 'IMG_0412.jpg'));
		assert.equal(lastToast(r), 'That file is not a Taproot Assets proof file this wallet can read.');
		// Larger than any proof file the wallet takes: refused here, and the wallet is not sent it.
		const asked = backend.posted('/proofs/import', 'demo-witness').length;
		await choose(input(), { name: 'huge.assetproof', size: 4 * 1024 * 1024 + 1, arrayBuffer: async () => assert.fail('a file this large is not read') });
		assert.equal(lastToast(r), 'That file is larger than a proof file this wallet takes (4 MB).');
		assert.equal(backend.posted('/proofs/import', 'demo-witness').length, asked);
		assert.equal(await holds(witness), '0');
		assert.equal(input().value, '', 'the same file can be chosen again');
	} finally {
		await r.unmount();
	}

	// A real proof, of a payment to somebody else: the wallet that was not paid says so.
	const other = await mountAssets(backend, 'demo-savings', { at: { view: 'receive' } });
	try {
		await choose(other.test('asset-proof-import-file'), fileOf(out));
		assert.equal(lastToast(other), 'This proof is not for an address this wallet made. It has to be the file of a payment to this wallet.');
		assert.equal(await holds(backend.api('demo-savings')), '0');
	} finally {
		await other.unmount();
	}
});

test('a mint has no proof file to hand over, and a wallet whose assets are not up offers none', async () => {
	const backend = assetsBackend();
	const main = backend.api('demo-main');
	const mint = (await main.get('/x/assets/activity')).rows.find((x) => x.kind === 'mint');
	await assert.rejects(main.get(`/x/assets/proofs/export?id=${mint.id}`), (e) => e.code === 'NO_PROOF_FILE');
	await assert.rejects(main.post('/x/assets/proofs/handed-over', { id: mint.id }), (e) => e.code === 'NO_PROOF_FILE');

	backend.mock.seed('demo-main', 'send-refused');
	backend.mock.setHost('demo-main', 'starting');
	const r = await mountAssets(backend, 'demo-main', { at: {} });
	try {
		assert.ok(r.test('assets-starting'));
		assert.equal(r.test('asset-proof-save'), null);
		assert.equal(r.test('asset-proof-import'), null);
	} finally {
		await r.unmount();
	}
});
