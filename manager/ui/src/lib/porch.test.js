import test from 'node:test';
import assert from 'node:assert/strict';
import { porchBody, porchRows, porchChanged, relayAdvice, readyUri } from './porch.js';

const rec = { porch: { enabled: true, via: 'default', relays: [{ url: 'wss://a.example', hasToken: true }, { url: 'wss://b.example', hasToken: false }] } };

test('a saved token is kept unless replaced or removed', () => {
	const rows = porchRows(rec);
	assert.deepEqual(porchBody(true, 'default', rows).relays, [{ url: 'wss://a.example' }, { url: 'wss://b.example' }]);
	rows[0].token = ' new ';
	rows[1].removeToken = true;
	assert.deepEqual(porchBody(true, 'tor', rows), {
		enabled: true,
		via: 'tor',
		relays: [{ url: 'wss://a.example', token: ' new ' }, { url: 'wss://b.example', token: null }]
	});
});

test('turning Porch off sends nothing a stray row could block', () => {
	assert.deepEqual(porchBody(false, 'tor', [{ url: 'not a url', token: 'x', removeToken: false }]), { enabled: false });
});

test('the restart note follows what changed', () => {
	assert.equal(porchChanged(rec, true, 'default', porchRows(rec)), false);
	assert.equal(porchChanged(rec, false, 'default', porchRows(rec)), true);
	const rows = porchRows(rec);
	rows[0].token = 'x';
	assert.equal(porchChanged(rec, true, 'default', rows), true);
});

test('the link handed out names a relay that reports ready', () => {
	const node = '02' + 'ab'.repeat(32);
	const status = {
		listening: true,
		relays: [{ relay: 'wss://a.example', state: 'refused' }, { relay: 'wss://b.example', state: 'ready' }],
		links: [{ default: true, uris: [`${node}@wss://a.example/v1/p/r1`, `${node}@wss://b.example/v1/p/r1`] }]
	};
	assert.equal(readyUri(status), `${node}@wss://b.example/v1/p/r1`);
	status.relays[1].state = 'unreachable';
	assert.equal(readyUri(status), null);
});

test('a refused relay points at the token', () => {
	assert.match(relayAdvice({ state: 'refused' }), /token/);
	assert.equal(relayAdvice({ state: 'ready' }), null);
});
