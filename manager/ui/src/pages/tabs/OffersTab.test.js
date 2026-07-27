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
function stubApi({ offers = [] } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/offers') return offers;
			return null;
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
