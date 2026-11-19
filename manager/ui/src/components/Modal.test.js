/**
 * Run with: npm test (from manager/ui).
 *
 * The dialog shell. A dialog can open over another one (the recovery phrase
 * over Edit wallet), and each press of Escape puts away only the one in
 * front. One dialog on its own still goes on Escape and on a press of the
 * backdrop, and not on a press inside its box.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, Fragment, useState } from 'react';
import { render, settle } from '../../test/render.mjs';
import { Modal } from './ui.jsx';

const escape = () =>
	act(async () => {
		window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	});

const press = (element) =>
	act(async () => {
		element.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
	});

// Longer than the exit animation, after which onClose fires.
const closed = () => settle(250);

function Dialogs({ names, log }) {
	const [open, setOpen] = useState(names);
	return createElement(
		Fragment,
		null,
		open.map((name) =>
			createElement(
				Modal,
				{
					key: name,
					title: name,
					onClose: () => {
						log.push(name);
						setOpen((o) => o.filter((n) => n !== name));
					}
				},
				`${name} body`
			)
		)
	);
}

test('with two dialogs open, each Escape closes only the one in front', async () => {
	const log = [];
	const r = await render(Dialogs, { names: ['Edit wallet', 'Recovery phrase'], log });
	try {
		await escape();
		await closed();
		assert.deepEqual(log, ['Recovery phrase']);
		assert.match(r.text(), /Edit wallet body/);

		await escape();
		await closed();
		assert.deepEqual(log, ['Recovery phrase', 'Edit wallet']);
		assert.equal(r.$('.modal'), null);
	} finally {
		await r.unmount();
	}
});

test('a single dialog closes on a backdrop press, and not on a press inside it', async () => {
	const log = [];
	const r = await render(Dialogs, { names: ['Delete offer'], log });
	try {
		await press(r.$('.modal-body'));
		await closed();
		assert.deepEqual(log, []);

		await press(r.$('.modal'));
		await closed();
		assert.deepEqual(log, ['Delete offer']);
		assert.equal(r.$('.modal'), null);
	} finally {
		await r.unmount();
	}
});

/* ------------------------------------------------------------ as a dialog */

const tab = (shift = false) =>
	act(async () => {
		window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true }));
	});

/** A page with a button that opens a dialog holding two fields. */
function Opener() {
	const [open, setOpen] = useState(false);
	return createElement(
		Fragment,
		null,
		createElement('button', { type: 'button', id: 'opener', onClick: () => setOpen(true) }, 'Burn'),
		createElement('input', { id: 'behind', 'aria-label': 'Behind the dialog' }),
		open &&
			createElement(
				Modal,
				{ title: 'Burn BUSD', onClose: () => setOpen(false) },
				createElement('input', { id: 'first', 'aria-label': 'Amount' }),
				createElement('button', { type: 'button', id: 'last' }, 'Burn 100.00 BUSD')
			)
	);
}

test('a dialog is named by its title and keeps Tab inside it', async () => {
	const r = await render(Opener, {});
	try {
		const opener = r.$('#opener');
		await act(async () => {
			opener.focus();
			opener.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
		});
		await settle(0);

		const box = r.$('.modal-box');
		assert.equal(box.getAttribute('role'), 'dialog');
		assert.equal(box.getAttribute('aria-modal'), 'true');
		assert.equal(document.getElementById(box.getAttribute('aria-labelledby')).textContent, 'Burn BUSD', 'its name is its title');
		assert.equal(document.activeElement, box, 'focus is moved into the dialog when it opens');

		// The dialog's stops, in order: Close, the field, the button.
		const close = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Close');
		const last = r.$('#last');
		await tab();
		assert.equal(document.activeElement, close, 'Tab from the dialog itself lands on its first stop');
		await act(async () => last.focus());
		await tab();
		assert.equal(document.activeElement, close, 'Tab from the last stop wraps to the first');
		await tab(true);
		assert.equal(document.activeElement, last, 'and Shift+Tab from the first wraps to the last');

		// Focus that got out is brought back, not left on the page behind.
		await act(async () => r.$('#behind').focus());
		await tab();
		assert.equal(document.activeElement, close);

		await escape();
		await closed();
		assert.equal(r.$('.modal'), null);
		assert.equal(document.activeElement, opener, 'focus goes back to what opened it');
	} finally {
		await r.unmount();
	}
});

test('a field that asked for focus keeps it when the dialog opens', async () => {
	function Asked() {
		return createElement(Modal, { title: 'Send', onClose: () => {} }, createElement('input', { id: 'wanted', autoFocus: true }));
	}
	const r = await render(Asked, {});
	try {
		assert.equal(document.activeElement, r.$('#wanted'));
	} finally {
		await r.unmount();
	}
});
