'use strict';

/**
 * Run with: npm test (from manager/).
 *
 * A direct funding request works once, so when one lands on a wallet that
 * publishes its request under a pubky, the Paykit check comes within seconds
 * rather than at the next quarter hour. Only a wallet that keeps a published
 * request up to date is moved, a check already due sooner is left alone, and
 * a landing while a check runs makes the one after it come soon.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// config reads DATA_DIR once, at require time.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'beignet-paykit-watch-'));
process.env.DATA_DIR = DATA_DIR;

const { WalletManager } = require('./wallet-manager');

const ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const QUARTER_HOUR = 15 * 60 * 1000;
const SOON = 10 * 1000;

function box(paykit) {
	fs.writeFileSync(
		path.join(DATA_DIR, 'registry.json'),
		JSON.stringify([{ id: ID, name: 'Spending', network: 'regtest', port: 3101, running: true, paykit }])
	);
	const m = new WalletManager();
	m.settings.load();
	m.registry.load();
	const rt = m.runtimeState(ID);
	rt.status = 'running';
	rt.healthy = true;
	const checks = [];
	m._paykitCheck = async () => {
		checks.push(Date.now());
	};
	return { m, rt, checks };
}

const PUBLISHED = {
	pubky: 'uopciqnqm997k7o5dx7n4przj76ik9tuwjk4afacy7y6bt69ipey',
	publishedAt: Date.now() - 60_000,
	autoRefresh: true,
	df: { paymentHash: 'a'.repeat(64), expiresAt: Date.now() + 7 * 86_400_000 }
};

const dueIn = (rt) => rt.paykitNextAt - Date.now();

test('a direct funding landing moves the next check to within seconds', (t) => {
	const { m, rt } = box(PUBLISHED);
	t.after(() => m._stopPaykitWatch(rt));
	m._schedulePaykit(ID, rt, QUARTER_HOUR);
	m._paykitSoon(ID, rt);
	assert.ok(dueIn(rt) <= SOON && dueIn(rt) > SOON - 1000, `due in ${dueIn(rt)} ms`);
	assert.ok(rt.paykitTimer, 'one timer still holds the watch');
});

test('a check already due sooner is not pushed back', (t) => {
	const { m, rt } = box(PUBLISHED);
	t.after(() => m._stopPaykitWatch(rt));
	m._schedulePaykit(ID, rt, 2000);
	m._paykitSoon(ID, rt);
	assert.ok(dueIn(rt) <= 2000, `due in ${dueIn(rt)} ms`);
});

test('a wallet that does not keep a published request up to date is left alone', (t) => {
	for (const paykit of [
		{ ...PUBLISHED, autoRefresh: false },
		{ ...PUBLISHED, df: null },
		{ ...PUBLISHED, publishedAt: null },
		undefined
	]) {
		const { m, rt } = box(paykit);
		t.after(() => m._stopPaykitWatch(rt));
		m._schedulePaykit(ID, rt, QUARTER_HOUR);
		m._paykitSoon(ID, rt);
		assert.ok(dueIn(rt) > QUARTER_HOUR - 1000, `${JSON.stringify(paykit)}: due in ${dueIn(rt)} ms`);
	}
});

test('a landing while a check runs makes the next check come soon', async (t) => {
	const { m, rt, checks } = box(PUBLISHED);
	t.after(() => m._stopPaykitWatch(rt));
	let finish;
	m._paykitCheck = () =>
		new Promise((resolve) => {
			checks.push(Date.now());
			finish = resolve;
		});
	m._schedulePaykit(ID, rt, 0);
	while (!finish) await new Promise((r) => setImmediate(r));
	m._paykitSoon(ID, rt);
	finish();
	await new Promise((r) => setImmediate(r));
	assert.equal(checks.length, 1);
	assert.ok(rt.paykitTimer, 'the next check is scheduled');
	assert.ok(dueIn(rt) <= SOON && dueIn(rt) > SOON - 1000, `due in ${dueIn(rt)} ms`);
	assert.equal(rt.paykitSoon, false, 'and the flag is spent');
});
