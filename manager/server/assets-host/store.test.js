'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { memoryStorage, hostRows } = require('./store');

// The fake has to behave as the engine's view does where the host could come
// to depend on it. docs/EXTENSIONS.md in the engine is the reference.

test('the storage fake undoes every write of a transaction that throws', () => {
	const { storage } = memoryStorage();
	storage.set('a', '1');
	assert.throws(() =>
		storage.transaction(() => {
			storage.set('a', '2');
			storage.set('b', '3');
			throw new Error('no');
		})
	);
	assert.equal(storage.get('a'), '1');
	assert.equal(storage.get('b'), null);
});

test('the storage fake refuses a transaction inside another before its callback runs, as the engine does', () => {
	const { storage } = memoryStorage();
	let ran = false;
	assert.throws(
		() =>
			storage.transaction(() => {
				storage.set('outer', '1');
				storage.transaction(() => {
					ran = true;
				});
			}),
		/cannot be opened inside another transaction/
	);
	assert.equal(ran, false);
	// The outer transaction threw with it, so its write is gone too.
	assert.equal(storage.get('outer'), null);
	// And the next one opens as usual.
	storage.transaction(() => storage.set('later', '1'));
	assert.equal(storage.get('later'), '1');
});

test('host rows write through one transaction and cannot nest either', () => {
	const { storage } = memoryStorage();
	const rows = hostRows(storage);
	assert.throws(() => rows.tx(() => rows.tx(() => {})), /cannot be opened inside another transaction/);
});
