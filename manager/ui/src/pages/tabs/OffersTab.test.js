/**
 * Run with: npm test (from manager/ui).
 *
 * The bug pinned here: creating an offer toasted "Offer created", cleared the
 * form, and threw the response away. That response is the only place daemons
 * through 0.7.5 return the encoded offer (GET /offers omits it), so the offer
 * existed but nothing on screen could show or copy it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle, type } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import OffersTab from './OffersTab.jsx';

const LNO = 'lno1' + 'q'.repeat(90);
const ID = 'ab'.repeat(32);

/** A daemon that records what it was asked, and answers plausibly. */
function stubApi({ offers = [], delError } = {}) {
	const calls = [];
	const live = [...offers];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/offers') return live;
			return null;
		},
		del: async (path) => {
			calls.push(['DELETE', path]);
			if (delError) throw new Error(delError);
			const id = new URLSearchParams(path.split('?')[1] || '').get('offerId');
			const i = live.findIndex((o) => o.offerId === id);
			if (i !== -1) live.splice(i, 1);
			return { removed: true };
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/offer/create') {
				return {
					offerId: ID,
					description: body.description,
					amountSats: body.amountSats ?? null,
					encoded: LNO
				};
			}
			throw new Error(`unexpected POST ${path}`);
		}
	};
}

async function mountOffers(api) {
	return render(ToastProvider, {
		children: createElement(OffersTab, { id: 'w1', api, tick: 0, bump: () => {} })
	});
}

test('the created offer is on screen, from the create response alone', async () => {
	// The list answers in the daemon-0.7.5 shape, with no encoded string, so
	// whatever the card shows can only have come from the create response.
	const api = stubApi({ offers: [] });
	const view = await mountOffers(api);

	await type(view.$('input[placeholder="Donations"]'), 'Coffee fund');
	await type(view.$('input[placeholder="any amount"]'), '2500');
	const btn = view.$$('button').find((b) => b.textContent.trim() === 'Create offer');
	assert.ok(btn && !btn.disabled, 'Create offer is live');
	await click(btn);
	await settle(50);

	const posted = api.calls.find(([m, p]) => m === 'POST' && p === '/offer/create');
	assert.ok(posted, '/offer/create was called');
	assert.equal(posted[2].description, 'Coffee fund');
	assert.equal(posted[2].amountSats, 2500);
	assert.ok(view.text().includes(LNO), 'the encoded offer is visible and copyable');
	assert.ok(view.$('.qr svg'), 'and offered as a QR code');
	await view.unmount();
});

test('a listed offer shows its encoded form when the daemon provides one', async () => {
	const other = 'ef'.repeat(32);
	const api = stubApi({
		offers: [
			{ offerId: ID, description: 'Dues', amountSats: 21000, encoded: LNO },
			{ offerId: other, description: 'Old daemon row', amountSats: null }
		]
	});
	const view = await mountOffers(api);
	assert.ok(view.text().includes(LNO), 'the encoded offer is the copyable cell');
	assert.ok(view.text().includes('efefef…efefef'), 'a row without one falls back to the short id');
	await view.unmount();
});

test('deleting an offer asks first, and says what it costs', async () => {
	const api = stubApi({
		offers: [{ offerId: ID, description: 'Dues', amountSats: 21000, encoded: LNO }]
	});
	const view = await mountOffers(api);
	await settle(50);

	const del = view.$$('button').find((b) => b.textContent.trim() === 'Delete');
	assert.ok(del, 'each offer row offers a delete');
	await click(del);
	await settle(50);

	// The cost of deleting is not that the row goes away, it is that a code other
	// people hold stops working, and that has to be said before it happens.
	assert.match(view.text(), /no longer pay it/i);
	assert.match(view.text(), /Dues/);
	assert.ok(
		!api.calls.some(([m]) => m === 'DELETE'),
		'and nothing was deleted just by asking'
	);

	await click(view.$$('button').find((b) => b.textContent.trim() === 'Cancel'));
	await settle(50);
	assert.ok(!api.calls.some(([m]) => m === 'DELETE'), 'cancel really cancels');
	await view.unmount();
});

test('confirming the delete removes the offer by id', async () => {
	const other = 'ef'.repeat(32);
	const api = stubApi({
		offers: [
			{ offerId: ID, description: 'Dues', amountSats: 21000, encoded: LNO },
			{ offerId: other, description: 'Keep me', amountSats: null, encoded: LNO }
		]
	});
	const view = await mountOffers(api);
	await settle(50);

	await click(view.$$('button').find((b) => b.textContent.trim() === 'Delete'));
	await settle(50);
	await click(view.$$('button').find((b) => b.textContent.trim() === 'Delete offer'));
	await settle(150);

	const sent = api.calls.find(([m]) => m === 'DELETE');
	assert.ok(sent, 'the daemon was asked to remove it');
	assert.equal(sent[1], `/offer?offerId=${ID}`, 'by id, in the query string');
	assert.match(view.text(), /Keep me/, 'the other offer is untouched');
	await view.unmount();
});

test("a daemon that refuses the delete is quoted, not second-guessed", async () => {
	// beignet before 0.8.0 has no DELETE /offer at all.
	const api = stubApi({
		offers: [{ offerId: ID, description: 'Dues', amountSats: 21000, encoded: LNO }],
		delError: 'Not found'
	});
	const view = await mountOffers(api);
	await settle(50);

	await click(view.$$('button').find((b) => b.textContent.trim() === 'Delete'));
	await settle(50);
	await click(view.$$('button').find((b) => b.textContent.trim() === 'Delete offer'));
	await settle(150);

	assert.match(view.text(), /Not found/, 'the refusal is shown');
	assert.match(view.text(), /Dues/, 'and the offer is still listed');
	await view.unmount();
});
