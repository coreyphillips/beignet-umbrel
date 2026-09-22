/**
 * Run with: npm test (from manager/ui).
 *
 * The "?" that holds an explanation. What matters: the text is always there
 * for a screen reader but out of sight until asked for, it shows on focus and
 * on a click, it goes on Escape without taking a dialog with it, and a "?"
 * inside a checkbox row never ticks the box.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { blur, focus, render } from '../../test/render.mjs';
import { Help } from './ui.jsx';

// A real click is cancelable, which is what lets the "?" stop a label from
// passing it on to its checkbox; the harness's click() is not.
async function press(element) {
	await act(async () => {
		element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true, cancelable: true }));
	});
}

async function key(element, name) {
	await act(async () => {
		element.dispatchEvent(new globalThis.window.KeyboardEvent('keydown', { key: name, bubbles: true }));
	});
}

const popover = () => document.querySelector('.help-pop');

test('the text is in the page for a screen reader, hidden, and described by the "?"', async () => {
	const r = await render(Help, { children: 'Why this matters.' });
	try {
		const trigger = r.$('.help-btn');
		const text = document.getElementById(trigger.getAttribute('aria-describedby'));
		assert.equal(text.textContent, 'Why this matters.');
		assert.equal(text.hidden, true);
		assert.equal(trigger.getAttribute('aria-expanded'), 'false');
		assert.equal(popover(), null, 'nothing is shown until it is asked for');
	} finally {
		await r.unmount();
	}
});

test('focus shows it, blur and Escape put it away, and Escape stops there', async () => {
	const r = await render(Help, { children: 'Why this matters.' });
	let reachedDialog = 0;
	const dialogEscape = (e) => e.key === 'Escape' && reachedDialog++;
	window.addEventListener('keydown', dialogEscape);
	try {
		const trigger = r.$('.help-btn');
		await focus(trigger);
		assert.equal(popover()?.textContent, 'Why this matters.');
		assert.equal(trigger.getAttribute('aria-expanded'), 'true');
		await blur(trigger);
		assert.equal(popover(), null);

		await focus(trigger);
		await key(trigger, 'Escape');
		assert.equal(popover(), null);
		assert.equal(reachedDialog, 0, 'a modal around it would have closed too');
	} finally {
		window.removeEventListener('keydown', dialogEscape);
		await r.unmount();
	}
});

test('a click pins it and a second click puts it away; Enter does the same', async () => {
	const r = await render(Help, { children: 'Why this matters.' });
	try {
		const trigger = r.$('.help-btn');
		await press(trigger);
		assert.ok(popover());
		await press(trigger);
		assert.equal(popover(), null);
		await key(trigger, 'Enter');
		assert.ok(popover());
		await key(trigger, 'Enter');
		assert.equal(popover(), null);
	} finally {
		await r.unmount();
	}
});

test('a "?" inside a checkbox row explains the box without ticking it', async () => {
	let changes = 0;
	const Row = () =>
		createElement(
			'label',
			{ className: 'checkbox field' },
			createElement('input', { type: 'checkbox', onChange: () => changes++ }),
			'Serve as a guardian',
			createElement(Help, null, 'What serving means.')
		);
	const r = await render(Row, {});
	try {
		await press(r.$('.help-btn'));
		assert.equal(changes, 0);
		assert.equal(r.$('input').checked, false);
		assert.ok(popover());
		await press(r.$('label'));
		assert.equal(changes, 1, 'the rest of the row still ticks the box');
	} finally {
		await r.unmount();
	}
});
