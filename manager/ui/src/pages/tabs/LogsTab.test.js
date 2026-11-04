/**
 * Run with: npm test (from manager/ui).
 *
 * The Logs tab keeps its red card for real failures. Peer warnings and
 * payments a channel turned away (the 2026-11-04 field log: Core Lightning
 * gossip warnings every day, and forwards one drained channel kept refusing)
 * fold into a quiet Warnings card under the log, one entry per repeat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { render, settle } from '../../../test/render.mjs';
import { ToastProvider } from '../../components/Toast.jsx';
import LogsTab from './LogsTab.jsx';

const ZERO = '0'.repeat(64);
const CH = 'e1a1be904fae800d67a3546605eae48cdc8c84fc5a7e29a2ce7f4df31da1eccd';
const T0 = Date.parse('2026-11-04T08:00:00Z');

const ERRORS = [
	...[1, 2, 3].map((i) => ({
		code: 'CHANNEL_ERROR',
		message: 'Insufficient balance for HTLC',
		channelId: CH,
		timestamp: T0 + i * 60_000
	})),
	{ code: 'CHANNEL_ERROR', message: 'Remote warning: Unknown UTXO 504311x1993x0', channelId: ZERO, timestamp: T0 + 4 * 60_000 },
	{ code: 'CHANNEL_ERROR', message: 'Remote warning: Unknown UTXO 504311x1993x0', channelId: ZERO, timestamp: T0 + 5 * 60_000 },
	{ code: 'CHANNEL_ERROR', message: 'Remote error: invalid update', channelId: CH, timestamp: T0 + 6 * 60_000 }
];

const LINES = [
	'[2026-11-04T13:31:58.837Z] node error [CHANNEL_ERROR] Remote warning: Unknown UTXO 504311x1993x0',
	'[2026-11-04T08:21:29.791Z] node error [CHANNEL_ERROR] Insufficient balance for HTLC',
	'[2026-11-04T08:30:00.000Z] node error [CHANNEL_ERROR] Remote error: invalid update'
];

function stubManager() {
	globalThis.fetch = async (url) => {
		const result = /\/errors/.test(url) ? ERRORS : /\/logs$/.test(url) ? LINES : null;
		return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
	};
}

async function mount() {
	stubManager();
	return render(
		(props) => createElement(ToastProvider, null, createElement(LogsTab, props)),
		{ id: 'w1', tick: 0 }
	);
}

test('real failures stay red; warnings and turned-away payments fold into a quiet card', async () => {
	const view = await mount();
	try {
		await settle(50);
		const red = view.$$('.error-note');
		assert.equal(red.length, 1, 'only the real failure is a red box');
		assert.match(red[0].textContent, /invalid update/);

		const warnings = view.$$('.node-warning');
		assert.equal(warnings.length, 2, 'five reports, two distinct warnings');
		const [utxo, balance] = warnings.map((w) => w.textContent.replace(/\s+/g, ' '));
		assert.match(utxo, /A peer sent a warning: "Unknown UTXO 504311x1993x0"/);
		assert.match(utxo, /2 times since/);
		assert.doesNotMatch(utxo, /channel 000000/, 'the all-zero id names no channel');
		assert.match(balance, /turned away/);
		assert.match(balance, /3 times since/);
		assert.match(balance, /channel e1a1be…a1eccd/, 'names the channel that turned it away');

		const lines = view.$$('.log-line');
		assert.deepEqual(
			lines.map((l) => l.className),
			['log-line warn', 'log-line warn', 'log-line error'],
			'warning lines are tinted as warnings, not errors'
		);

		// The Warnings card comes after the log itself.
		const cards = view.$$('.card');
		const logIdx = cards.findIndex((c) => c.querySelector('.log-body'));
		const warnIdx = cards.findIndex((c) => c.querySelector('.node-warning'));
		assert.ok(logIdx >= 0 && warnIdx > logIdx, 'warnings sit under the log');
	} finally {
		await view.unmount();
	}
});
