/**
 * What a component test needs before it can run: a DOM, and a way to load JSX.
 *
 * Registered with `node --import`, which puts both in place before the first
 * test file is loaded. Loaded by nothing else, so nothing here reaches a build.
 *
 * The dashboard is a Vite app and node is not Vite, so the two things Vite does
 * for the browser have to be done here: transform the JSX, and answer for the
 * handful of import forms node has no opinion about (`.jsx` without the
 * extension, and `import.meta.env`).
 */
import { register } from 'node:module';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
	url: 'http://localhost/',
	pretendToBeVisual: true
});

// The globals React and the components reach for. Copied rather than proxied,
// because react-dom checks for several of these by name at import time.
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// node defines these two as getters on the global, so they are replaced rather
// than assigned to.
Object.defineProperty(globalThis, 'navigator', {
	value: dom.window.navigator,
	configurable: true
});
Object.defineProperty(globalThis, 'location', {
	value: dom.window.location,
	configurable: true
});
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.Event = dom.window.Event;
globalThis.MouseEvent = dom.window.MouseEvent;
globalThis.KeyboardEvent = dom.window.KeyboardEvent;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.sessionStorage = dom.window.sessionStorage;
globalThis.localStorage = dom.window.localStorage;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame;
globalThis.matchMedia =
	dom.window.matchMedia ||
	(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
dom.window.matchMedia = globalThis.matchMedia;
// React's own signal that it is running against a DOM rather than a server.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

register('./jsx-loader.mjs', import.meta.url);
