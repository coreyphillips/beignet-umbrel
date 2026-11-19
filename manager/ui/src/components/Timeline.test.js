/**
 * Run with: npm test (from manager/ui).
 *
 * The progress pieces: the timeline, the confirmation meter, the countdown
 * and the QR code that can be enlarged. Each says in words what it shows in
 * colour or shape, because a step that is only green, or a bar that is only
 * shorter, tells a screen reader nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { click, render, settle } from '../../test/render.mjs';
import { ToastProvider } from './Toast.jsx';
import { ConfirmationMeter, Countdown, QR, QRZoom, Timeline } from './ui.jsx';

const STEPS = [
	{ key: 'broadcast', label: 'Broadcast', state: 'done', detail: null, at: 1_800_000_000_000 },
	{ key: 'confirmed', label: 'Confirmed', state: 'current', detail: 'Waiting for a block.' },
	{ key: 'proof', label: 'Proof delivered', state: 'pending', detail: null },
	{ key: 'complete', label: 'Complete', state: 'pending', detail: null }
];

test('a timeline says each step and its state in words, and marks the current one', async () => {
	const r = await render(Timeline, { label: 'Send progress', steps: STEPS, live: 'Sending 100.00 BUSD: waiting for a block', testId: 'tl' });
	try {
		const list = r.$('[data-testid="tl"]');
		assert.equal(list.tagName, 'OL', 'the steps are in order, and the markup says so');
		assert.equal(list.getAttribute('aria-label'), 'Send progress');
		const items = r.$$('li');
		assert.deepEqual(items.map((li) => li.getAttribute('data-state')), ['done', 'current', 'pending', 'pending']);
		assert.deepEqual(items.map((li) => li.getAttribute('aria-current')), [null, 'step', null, null]);
		assert.deepEqual(
			items.map((li) => li.querySelector('.tl-label').textContent),
			['Broadcast, done', 'Confirmed, in progress', 'Proof delivered, not started', 'Complete, not started']
		);
		// The glyph repeats the state for the eye and is kept from being read twice.
		assert.deepEqual(items.map((li) => li.querySelector('.tl-mark').getAttribute('aria-hidden')), ['true', 'true', 'true', 'true']);
		assert.equal(items[1].querySelector('.tl-detail').textContent, 'Waiting for a block.');
		assert.ok(items[0].querySelector('time').getAttribute('dateTime').startsWith('2027-'), 'a finished step carries when');
		assert.equal(items[1].querySelector('time'), null);
		const live = r.$('[role="status"]');
		assert.equal(live.getAttribute('aria-live'), 'polite');
		assert.equal(live.textContent, 'Sending 100.00 BUSD: waiting for a block', 'a change is announced as one sentence, not the list again');
	} finally {
		await r.unmount();
	}
});

test('a failed step is marked failed, and a compact timeline announces nothing by itself', async () => {
	const steps = [
		{ key: 'prepared', label: 'Prepared', state: 'failed', detail: 'Nothing was spent.' },
		{ key: 'broadcast', label: 'Broadcast', state: 'pending', detail: null }
	];
	const r = await render(Timeline, { label: 'Mint progress', steps, compact: true });
	try {
		assert.ok(r.$('ol').classList.contains('compact'));
		assert.equal(r.$('li').getAttribute('data-state'), 'failed');
		assert.equal(r.$('.tl-label').textContent, 'Prepared, failed');
		assert.equal(r.$('[role="status"]'), null, 'ten items in a list do not each get a live region');
	} finally {
		await r.unmount();
	}
});

test('the confirmation meter is a picture of a number that is also said', async () => {
	const r = await render(ConfirmationMeter, { have: 2, need: 6 });
	try {
		const meter = r.$('[data-testid="conf-meter"]');
		assert.equal(meter.getAttribute('role'), 'img');
		assert.equal(meter.getAttribute('aria-label'), '2 of 6 confirmations');
		assert.equal(r.$$('.conf-seg').length, 6);
		assert.equal(r.$$('.conf-seg.on').length, 2);
	} finally {
		await r.unmount();
	}
	const over = await render(ConfirmationMeter, { have: 9, need: 1 });
	try {
		assert.equal(over.$('[data-testid="conf-meter"]').getAttribute('aria-label'), '1 of 1 confirmations', 'never more than were needed');
		assert.equal(over.$$('.conf-seg').length, 1, 'one segment on regtest');
	} finally {
		await over.unmount();
	}
});

test('a countdown shows the seconds left and says so sparingly', async () => {
	let expired = 0;
	const r = await render(Countdown, { until: Date.now() + 45_000, total: 60, label: 'Price holds', onExpire: () => expired++ });
	try {
		const left = Number(r.$('[data-testid="countdown"]').getAttribute('data-left'));
		assert.ok(left === 45 || left === 44, `about 45 seconds left, got ${left}`);
		assert.match(r.$('.countdown-clock').textContent, /^0:4[45]$/);
		assert.equal(r.$('[role="status"]').textContent, 'Price holds: about 1 minute', 'said once at the start, not every second');
		assert.equal(expired, 0);
	} finally {
		await r.unmount();
	}
	const gone = await render(Countdown, { until: Date.now() - 1000, total: 60, label: 'Price holds', onExpire: () => expired++ });
	try {
		await settle(20);
		assert.equal(gone.$('[data-testid="countdown"]').getAttribute('data-left'), '0');
		assert.equal(gone.$('[role="status"]').textContent, 'Price holds: expired');
		assert.equal(expired, 1, 'and the caller is told, once');
	} finally {
		await gone.unmount();
	}
});

test('a QR code is named for what it holds, and can be enlarged in a dialog', async () => {
	const address = `tapbc1${'q'.repeat(80)}`;
	const code = await render(QR, { value: address, title: 'Taproot Assets address for 250.00 BUSD', caps: true, fluid: true });
	try {
		const qr = code.$('.qr');
		assert.equal(qr.getAttribute('role'), 'img');
		assert.equal(qr.getAttribute('aria-label'), 'Taproot Assets address for 250.00 BUSD');
		assert.ok(qr.classList.contains('fluid'));
	} finally {
		await code.unmount();
	}

	const r = await render(ToastProvider, { children: createElement(QRZoom, { value: address, title: 'Taproot Assets address for 250.00 BUSD', caps: true }) });
	try {
		assert.equal(document.querySelector('[data-testid="qr-zoom"]'), null);
		await click(r.$('[data-testid="qr-zoom-open"]'));
		await settle(0);
		// Through a portal, so a card's backdrop filter cannot clip it.
		const zoom = document.querySelector('[data-testid="qr-zoom"]');
		assert.ok(zoom, 'the enlarged code is on the page');
		assert.equal(r.$('[data-testid="qr-zoom"]'), null, 'and not inside the card that holds the button');
		const dialog = zoom.closest('[role="dialog"]');
		assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Taproot Assets address for 250.00 BUSD');
		await act(async () => {
			window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		});
		await settle(250);
		assert.equal(document.querySelector('[data-testid="qr-zoom"]'), null);
	} finally {
		await r.unmount();
	}
});
