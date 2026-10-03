import test from 'node:test';
import assert from 'node:assert/strict';
import { irohBody } from './iroh.js';

test('blank and comma-only relay input select defaults; disabling ignores hidden text', () => {
	for (const text of ['', ' , , ']) assert.deepEqual(irohBody(true, text), { enabled: true, relays: null });
	assert.deepEqual(irohBody(true, ' https://one.example/, https://two.example/ '), { enabled: true, relays: ['https://one.example/', 'https://two.example/'] });
	assert.deepEqual(irohBody(false, 'invalid'), { enabled: false });
});
