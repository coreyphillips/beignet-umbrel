/**
 * Run with: npm test (from manager/ui).
 *
 * Rotating a running wallet's guardians from the Edit dialog: the three
 * slots start as the pinned set, the button waits for a real change, a
 * Lightning address is resolved before the rotation runs, the manager gets
 * exactly three finished entries, and the dialog hears about it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { click, render, settle, type } from '../../test/render.mjs';
import { manager } from '../api.js';
import GuardianRotateFields from './GuardianRotateFields.jsx';

const G = (n) => `${String(n).repeat(64)}@https://g${n}.example/`;
const NODE = `${'02' + 'ab'.repeat(32)}@umbrel.local:9735`;
const PINNED = [G(1), G(2), G(3)];

function stub(name, fn) {
	const before = manager[name];
	manager[name] = fn;
	return () => {
		manager[name] = before;
	};
}

test('starts as the pinned set and only offers the button once a slot changes', async () => {
	const r = await render(GuardianRotateFields, { walletId: 'w1', pinned: PINNED });
	try {
		for (let i = 0; i < 3; i++) assert.equal(r.$(`[data-testid="rotate-guardian-${i}"]`).value, PINNED[i]);
		assert.equal(r.$('[data-testid="rotate-guardians"]').disabled, true);
		assert.match(r.text(), /retires the old set for good/);
		assert.match(r.text(), /A previous device still running on the old set stops itself/);
		await type(r.$('[data-testid="rotate-guardian-2"]'), G(4));
		assert.equal(r.$('[data-testid="rotate-guardians"]').disabled, false);
		assert.match(r.text(), /\(new\)/);
		// Emptying a slot takes the button away again: three are required.
		await type(r.$('[data-testid="rotate-guardian-2"]'), '');
		assert.equal(r.$('[data-testid="rotate-guardians"]').disabled, true);
	} finally {
		await r.unmount();
	}
});

test('resolves a Lightning address, sends three finished entries, and reports the generation', async () => {
	const calls = [];
	const restore = [
		stub('resolveGuardian', async (uri) => {
			calls.push(['resolve', uri]);
			return { guardianId: 'f'.repeat(64), url: `bolt8://${uri}`, entry: `${'f'.repeat(64)}@bolt8://${uri}` };
		}),
		stub('rotateGuardians', async (id, guardians) => {
			calls.push(['rotate', id, guardians]);
			return { generation: '2', retired: 3, record: {} };
		})
	];
	const rotated = [];
	const r = await render(GuardianRotateFields, { walletId: 'w1', pinned: PINNED, onRotated: (x) => rotated.push(x) });
	try {
		await type(r.$('[data-testid="rotate-guardian-1"]'), NODE);
		await click(r.$('[data-testid="rotate-guardians"]'));
		await settle(20);
		assert.deepEqual(calls[0], ['resolve', NODE]);
		assert.equal(calls[1][0], 'rotate');
		assert.equal(calls[1][1], 'w1');
		assert.deepEqual(calls[1][2], [G(1), `${'f'.repeat(64)}@bolt8://${NODE}`, G(3)]);
		assert.equal(rotated.length, 1);
		assert.equal(rotated[0].generation, '2');
		// The slots now show the set the wallet is on.
		assert.equal(r.$('[data-testid="rotate-guardian-1"]').value, `${'f'.repeat(64)}@bolt8://${NODE}`);
		assert.equal(r.$('[data-testid="rotate-guardians"]').disabled, true);
	} finally {
		restore.forEach((f) => f());
		await r.unmount();
	}
});

test('a refusal from the manager surfaces and leaves the slots as typed', async () => {
	const restore = stub('rotateGuardians', async () => {
		throw new Error('A rotation is already running');
	});
	const rotated = [];
	const r = await render(GuardianRotateFields, { walletId: 'w1', pinned: PINNED, onRotated: (x) => rotated.push(x) });
	try {
		await type(r.$('[data-testid="rotate-guardian-0"]'), G(5));
		await click(r.$('[data-testid="rotate-guardians"]'));
		await settle(20);
		assert.equal(rotated.length, 0);
		assert.equal(r.$('[data-testid="rotate-guardian-0"]').value, G(5));
		assert.equal(r.$('[data-testid="rotate-guardians"]').disabled, false);
	} finally {
		restore();
		await r.unmount();
	}
});
