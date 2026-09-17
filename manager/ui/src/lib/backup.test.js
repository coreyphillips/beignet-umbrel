/**
 * Run with: npm test (from manager/ui).
 *
 * How the wallet list says when this box was last taken off it. The reminder
 * is the point: a wallet created or edited since the last archive is one whose
 * settings, API token and guardians exist in exactly one place.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { backupStamp, backupSummary, timeAgo } from './backup.js';

const NOW = Date.parse('2026-09-17T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('a stamp reads as a span, and no stamp reads as nothing', () => {
	assert.equal(timeAgo(ago(10000), NOW), 'just now');
	assert.equal(timeAgo(ago(20 * MINUTE), NOW), '20 minutes ago');
	assert.equal(timeAgo(ago(5 * HOUR), NOW), '5 hours ago');
	assert.equal(timeAgo(ago(3 * DAY), NOW), '3 days ago');
	assert.equal(timeAgo(null, NOW), null);
	assert.equal(timeAgo('not a date', NOW), null);
});

test('a wallet says whether it is in the last archive', () => {
	assert.equal(backupStamp({ lastBackupAt: null, backupStale: true }), 'never backed up');
	assert.match(backupStamp({ lastBackupAt: ago(2 * DAY), backupStale: false }), /^backed up \d+ days ago$/);
	assert.match(
		backupStamp({ lastBackupAt: ago(2 * DAY), backupStale: true }),
		/^changed since the backup \d+ days ago$/
	);
});

test('the list says when the box was last backed up, and how much has changed since', () => {
	const fresh = [{ backupStale: false }, { backupStale: false }];
	assert.deepEqual(backupSummary(fresh, ago(DAY), NOW), { stale: 0, text: 'Backed up 24 hours ago.' });

	const one = backupSummary([{ backupStale: true }, { backupStale: false }], ago(3 * DAY), NOW);
	assert.equal(one.stale, 1);
	assert.match(one.text, /Backed up 3 days ago, but 1 wallet has been created or edited since\./);

	const two = backupSummary([{ backupStale: true }, { backupStale: true }], ago(3 * DAY), NOW);
	assert.match(two.text, /2 wallets have been created or edited since/);

	// Never backed up: the sentence has to carry why it matters, because this
	// is the state a box sits in until someone is told.
	const never = backupSummary([{ backupStale: true }], null, NOW);
	assert.equal(never.stale, 1);
	assert.match(never.text, /No backup of this box yet\./);
	assert.match(never.text, /API token/);
});
