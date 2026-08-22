/**
 * Rendering a card and driving it, without a browser.
 *
 * These are controlled inputs, so an edit is the onChange the component gave
 * them, called with the shape React hands it. That is what a keystroke amounts
 * to here, and it exercises the same code path a real one would.
 */
import { act } from 'react';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

/** Mount a component, returning the container and a way to unmount it. */
export async function render(type, props) {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(createElement(type, props));
	});
	// Mount-time work (the wallet list, the first poll of each endpoint) lands
	// here rather than in the middle of whatever the test does next.
	await settle(0);
	return {
		container,
		// Debounces and quotes in flight are let land before the card goes, so a
		// state update never arrives after the test that caused it has finished.
		unmount: async () => {
			await settle(400);
			await act(() => root.unmount());
		},
		$: (selector) => container.querySelector(selector),
		$$: (selector) => [...container.querySelectorAll(selector)],
		text: () => container.textContent.replace(/\s+/g, ' ').trim()
	};
}

/** Let effects, debounces and settled promises run. */
export async function settle(ms = 0) {
	await act(async () => {
		await new Promise((r) => setTimeout(r, ms));
	});
}

/** Type or paste into a controlled field. */
export async function type(element, value) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			element instanceof globalThis.window.HTMLTextAreaElement
				? globalThis.window.HTMLTextAreaElement.prototype
				: globalThis.window.HTMLInputElement.prototype,
			'value'
		).set;
		setter.call(element, value);
		element.dispatchEvent(new globalThis.window.Event('input', { bubbles: true }));
	});
}

/** Put the caret in a field, which some of them react to. */
export async function focus(element) {
	await act(async () => {
		element.focus();
	});
}

export async function blur(element) {
	await act(async () => {
		element.blur();
	});
}

export async function click(element) {
	await act(async () => {
		element.dispatchEvent(new globalThis.window.MouseEvent('click', { bubbles: true }));
	});
}

/** Pick an option in a controlled select. */
export async function select(element, value) {
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			globalThis.window.HTMLSelectElement.prototype,
			'value'
		).set;
		setter.call(element, value);
		element.dispatchEvent(new globalThis.window.Event('change', { bubbles: true }));
	});
}
