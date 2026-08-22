/**
 * Run with: npm test (from manager/ui).
 *
 * The reduction of the daemon's four-layer recovery status to the one line
 * the dashboard shows, pinned case by case against the wire contract of
 * beignet 0.9.2 (GET /recovery/status).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeRecovery, restoreProgress, channelOutcome, capsuleOffer, RESTORE_STEPS } from './recovery.js';

const node = (extra = {}) => ({
	gate: 'confirmed',
	durability: 'quorum',
	startupRepairPending: false,
	lastDurableSequence: '0',
	awaitingDurabilityCount: 0,
	fenced: false,
	backfillLost: false,
	channels: [],
	...extra
});

test('no status at all (a 404 from an older engine) is seed only, and not an alarm', () => {
	const d = describeRecovery(null, {});
	assert.equal(d.tier, 'Seed only');
	assert.equal(d.degraded, false);
	assert.equal(d.tone, 'yellow', 'a Lightning wallet with no backup is worth a yellow');
	assert.equal(describeRecovery(null, { onchainOnly: true }).tone, 'muted');
	assert.equal(describeRecovery({ state: 'unsupported' }, {}).tier, 'Seed only');
});

test('disabled reads as seed only with the consequence named', () => {
	const d = describeRecovery({ mode: 'off', state: 'disabled', node: null, guardians: [] }, {});
	assert.equal(d.tier, 'Seed only (channels close on restore)');
	assert.equal(d.degraded, false);
});

test('peer storage says what it does and what it cannot do yet', () => {
	const d = describeRecovery(
		{ mode: 'peer-storage', state: 'running', node: node({ durability: 'local', gate: 'disabled' }) },
		{}
	);
	assert.equal(d.tier, 'Checkpoints via peer storage');
	assert.match(d.detail, /recovery from the newest checkpoint/);
	assert.equal(d.degraded, false);
});

test('the guardian tiers carry the durable sequence untouched', () => {
	const big = '18446744073709551617'; // past Number's exact range, a string on the wire
	const q = describeRecovery(
		{ mode: 'quorum', state: 'running', node: node({ lastDurableSequence: big }) },
		{}
	);
	assert.equal(q.tier, `Continuity: quorum, durable to seq ${big}`);
	assert.equal(q.tone, 'green');
	const a = describeRecovery(
		{ mode: 'async-remote', state: 'running', node: node({ durability: 'async-remote', lastDurableSequence: '42' }) },
		{}
	);
	assert.equal(a.tier, 'Guardians (async), durable to seq 42');
	assert.equal(a.degraded, false);
});

test('channels waiting on receipts are mentioned, not alarmed about', () => {
	const d = describeRecovery(
		{ mode: 'quorum', state: 'running', node: node({ awaitingDurabilityCount: 2 }) },
		{}
	);
	assert.match(d.detail, /2 channels waiting on guardian receipts/);
	assert.equal(d.degraded, false);
});

test('state running with a quarantined gate is a degraded wait, not running', () => {
	const d = describeRecovery({ mode: 'quorum', state: 'running', node: node({ gate: 'quarantined' }) }, {});
	assert.equal(d.tier, 'Waiting for guardians to confirm');
	assert.equal(d.degraded, true);
	assert.equal(d.tone, 'yellow');
	const r = describeRecovery(
		{ mode: 'async-remote', state: 'running', node: node({ startupRepairPending: true }) },
		{}
	);
	assert.equal(r.degraded, true);
});

test('fenced wins over everything else and is red', () => {
	for (const status of [
		{ mode: 'quorum', state: 'fenced', node: node({ fenced: true, gate: 'fenced' }) },
		{ mode: 'quorum', state: 'running', node: node({ fenced: true }) },
		{ mode: 'quorum', state: 'running', node: node({ gate: 'fenced' }) }
	]) {
		const d = describeRecovery(status, {});
		assert.match(d.tier, /Another device took over/);
		assert.equal(d.tone, 'red');
		assert.equal(d.degraded, true);
	}
});

test('backfill lost is its own red state, distinct from fenced', () => {
	const d = describeRecovery({ mode: 'quorum', state: 'running', node: node({ backfillLost: true }) }, {});
	assert.equal(d.tier, 'Recovery journal broken');
	assert.equal(d.tone, 'red');
	assert.equal(d.degraded, true);
});

test('restore required and restoring are yellow and degraded', () => {
	const r = describeRecovery(
		{ mode: 'quorum', state: 'restore-required', node: null, restore: { inProgress: false } },
		{}
	);
	assert.equal(r.tier, 'Restore required');
	assert.equal(r.degraded, true);
	const p = describeRecovery(
		{
			mode: 'quorum',
			state: 'restoring',
			node: null,
			restore: { inProgress: true, lastEvent: { type: 'frames:downloaded', detail: '3 records through sequence 7' } }
		},
		{}
	);
	assert.equal(p.tier, 'Restoring');
	assert.equal(p.detail, '3 records through sequence 7');
});

test('every per-channel status has an owner-facing outcome and the closing ones are never errors', () => {
	assert.equal(channelOutcome('active').kind, 'resumed');
	for (const s of ['reestablishing', 'replay_required', 'quarantined']) {
		assert.equal(channelOutcome(s).kind, 'pending', s);
	}
	for (const s of ['local_data_loss', 'state_uncertain', 'force_closing']) {
		const o = channelOutcome(s);
		assert.equal(o.kind, 'closing', s);
		assert.equal(o.label, 'closing safely, funds return on-chain');
	}
});

test('restore progress follows the order of the latest event, not the events seen', () => {
	const ready = restoreProgress({ mode: 'quorum', state: 'restore-required', node: null, restore: { inProgress: false } });
	assert.equal(ready.phase, 'ready');
	assert.ok(ready.steps.every((s) => !s.done && !s.current));

	const mid = restoreProgress({
		mode: 'quorum',
		state: 'restoring',
		node: null,
		restore: { inProgress: true, lastEvent: { type: 'frames:downloaded', detail: '3 records through sequence 7' } }
	});
	assert.equal(mid.phase, 'restoring');
	assert.deepEqual(
		mid.steps.map((s) => (s.done ? 'done' : s.current ? 'current' : 'todo')),
		['done', 'done', 'done', 'current', 'todo', 'todo']
	);
	assert.equal(mid.steps[3].detail, '3 records through sequence 7');

	const retry = restoreProgress({
		mode: 'quorum',
		state: 'restoring',
		node: null,
		restore: { inProgress: true, lastEvent: { type: 'epoch:cas-retry', detail: 'attempt 2 collected 1 of 2 certificates' } }
	});
	assert.equal(retry.steps[2].current, true, 'a CAS retry keeps the ownership step current');
	assert.match(retry.steps[2].detail, /attempt 2/);

	const begun = restoreProgress({ mode: 'quorum', state: 'restoring', node: null, restore: { inProgress: true } });
	assert.equal(begun.steps[0].current, true, 'no event yet means the first step is under way');
	assert.equal(RESTORE_STEPS.length, 6);
});

test('a restore is never complete while a channel is still reconciling or the gate is shut', () => {
	const ch = (status, i) => ({ channelId: String(i).repeat(64), status, awaitingDurability: false });
	const mixed = restoreProgress({
		mode: 'quorum',
		state: 'running',
		node: node({ channels: [ch('active', 1), ch('reestablishing', 2), ch('local_data_loss', 3)] })
	});
	assert.equal(mixed.phase, 'channels');
	assert.ok(mixed.steps.every((s) => s.done), 'the node is up, so every restore step is behind us');
	assert.deepEqual(
		{ total: mixed.channels.total, resumed: mixed.channels.resumed, closing: mixed.channels.closing, pending: mixed.channels.pending },
		{ total: 3, resumed: 1, closing: 1, pending: 1 }
	);
	assert.equal(mixed.complete, false);

	const settled = restoreProgress({
		mode: 'quorum',
		state: 'running',
		node: node({ channels: [ch('active', 1), ch('force_closing', 2)] })
	});
	assert.equal(settled.complete, true, 'a channel closing safely is a landed outcome');

	const shut = restoreProgress({
		mode: 'quorum',
		state: 'running',
		node: node({ gate: 'quarantined', channels: [ch('active', 1)] })
	});
	assert.equal(shut.complete, false, 'the gate decides too');

	const fenced = restoreProgress({ mode: 'quorum', state: 'fenced', node: node({ fenced: true, gate: 'fenced' }) });
	assert.equal(fenced.phase, 'fenced');
	assert.equal(fenced.complete, false);
});

test('a database replaced by a checkpoint restore reads as restarting, yellow', () => {
	const d = describeRecovery({ mode: 'peer-storage', state: 'restart-required', node: null, capsules: { candidates: 1, best: null } }, {});
	assert.equal(d.tier, 'Restarting on restored state');
	assert.equal(d.degraded, true);
	assert.equal(d.tone, 'yellow');
});

test('a capsule is offered only to a peer-storage wallet with nothing to lose', () => {
	const best = { writerEpoch: '1', latestSequence: '412', inline: true, channelCount: 2, guardians: [], fromPeer: '02' + 'a'.repeat(64), receivedAt: 1 };
	const status = { mode: 'peer-storage', state: 'running', node: node({ durability: 'local', gate: 'disabled' }), capsules: { candidates: 2, best } };
	const offer = capsuleOffer(status, { openChannelCount: 0, channelCount: 0 });
	assert.deepEqual(
		{ channelCount: offer.channelCount, sequence: offer.sequence, inline: offer.inline, candidates: offer.candidates },
		{ channelCount: 2, sequence: '412', inline: true, candidates: 2 }
	);
	assert.equal(capsuleOffer(status, { openChannelCount: 1, channelCount: 3 }), null, 'a wallet with channels is not a restore target');
	assert.equal(capsuleOffer({ ...status, capsules: { candidates: 0, best: null } }, { openChannelCount: 0 }), null);
	assert.equal(capsuleOffer({ ...status, mode: 'quorum' }, { openChannelCount: 0 }), null, 'guardian modes restore through the guardians');
	assert.equal(capsuleOffer({ mode: 'peer-storage', state: 'running', node: null }, { openChannelCount: 0 }), null, 'an engine without the capsules key offers nothing');
});
