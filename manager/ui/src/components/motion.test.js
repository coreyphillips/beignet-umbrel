import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, useState } from 'react';
import { render, click } from '../../test/render.mjs';
import { Reveal, Switch } from './motion.jsx';
import { Modal } from './ui.jsx';

function Toggle({ persist }) {
	const [open, setOpen] = useState(false);
	return h(
		'div',
		null,
		h('button', { onClick: () => setOpen((o) => !o) }, 'toggle'),
		h(Reveal, { open, persist }, h('p', null, 'inside'))
	);
}

test('a Reveal mounts its content on open and drops it on close, in the same act', async () => {
	const r = await render(Toggle);
	assert.equal(r.$('p'), null);
	await click(r.$('button'));
	assert.equal(r.$('p').textContent, 'inside');
	await click(r.$('button'));
	assert.equal(r.$('p'), null);
	await r.unmount();
});

test('a persistent Reveal keeps its content mounted while closed', async () => {
	const r = await render(Toggle, { persist: true });
	assert.equal(r.$('p').textContent, 'inside');
	assert.equal(r.$('[aria-hidden="true"] p').textContent, 'inside');
	await click(r.$('button'));
	assert.equal(r.$('[aria-hidden="true"]'), null);
	await r.unmount();
});

function Views() {
	const [v, setV] = useState('a');
	return h(
		'div',
		null,
		h('button', { onClick: () => setV('b') }, 'go'),
		h(Switch, { value: v }, h('span', { 'data-view': v }, v))
	);
}

test('a Switch remounts its content when the value changes', async () => {
	const r = await render(Views);
	assert.equal(r.$('[data-view]').textContent, 'a');
	await click(r.$('button'));
	assert.equal(r.$('[data-view]').textContent, 'b');
	await r.unmount();
});

function Stack() {
	const [outer, setOuter] = useState(true);
	const [inner, setInner] = useState(true);
	return h(
		'div',
		null,
		outer && h(Modal, { title: 'Outer', onClose: () => setOuter(false) }, h('p', null, 'outer body')),
		inner && h(Modal, { title: 'Inner', onClose: () => setInner(false) }, h('p', null, 'inner body'))
	);
}

const escape = () =>
	act(async () => {
		window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	});

test('Escape closes only the dialog on top of the stack', async () => {
	const r = await render(Stack);
	assert.equal(r.$$('[role="dialog"]').length, 2);
	await escape();
	assert.equal(r.$$('[role="dialog"]').length, 1);
	assert.match(r.text(), /outer body/);
	assert.doesNotMatch(r.text(), /inner body/);
	await escape();
	assert.equal(r.$$('[role="dialog"]').length, 0);
	await r.unmount();
});

function Named() {
	return h(Modal, { title: 'Settings', onClose: () => {} }, h('p', null, 'body'));
}

test('a dialog names itself, locks the page and its close control carries no text', async () => {
	const r = await render(Named);
	const dialog = r.$('[role="dialog"]');
	assert.equal(dialog.getAttribute('aria-modal'), 'true');
	assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Settings');
	assert.equal(r.$('button[aria-label="Close"]').textContent, '');
	assert.equal(document.body.style.overflow, 'hidden');
	await r.unmount();
	assert.equal(document.body.style.overflow, '');
});
