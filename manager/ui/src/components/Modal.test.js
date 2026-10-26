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
