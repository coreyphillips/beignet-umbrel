import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMetrics, snapshot, rate, chainProgress, syncPace, chartPaths, displaySettings } from '../web/html/model.mjs';

test('Prometheus parser handles labels, zero, missing and invalid numbers', () => {
  const get = parseMetrics('# HELP hello\nrbitcoin_blocks 0\nrbitcoin_connections{direction="out"} 16\nrbitcoin_connections{direction="in"} 0\nprocess_resident_memory_bytes 2.5e6\nbad NaN\ninfinite +Inf\n');
  assert.equal(get('rbitcoin_blocks'), 0);
  assert.equal(get('rbitcoin_connections', { direction: 'in' }), 0);
  assert.equal(get('rbitcoin_connections', { direction: 'out' }), 16);
  assert.equal(get('process_resident_memory_bytes'), 2500000);
  assert.equal(get('missing'), null);
  assert.equal(get('bad'), null);
  assert.equal(get('infinite'), null);
});

test('snapshots distinguish absent metrics from an empty mempool or no peers', () => {
  const sample = snapshot('rbitcoin_mempool_transactions 0\nrbitcoin_peers{network="ipv4"} 0');
  assert.equal(sample.transactions, 0);
  assert.equal(sample.networks.ipv4, 0);
  assert.equal(sample.networks.onion, null);
  assert.equal(sample.blocks, null);
});

test('network rate ignores first sample, reset counters, process restarts and missing values', () => {
  const first = { t: 1000, received: 1000, started: 5 };
  const last = { t: 6000, received: 6000, started: 5 };
  assert.equal(rate(last, first, 'received'), 1000);
  assert.equal(rate(last, null, 'received'), null);
  assert.equal(rate({ ...last, started: 6 }, first, 'received'), null);
  assert.equal(rate({ ...last, received: 0 }, first, 'received'), null);
  assert.equal(rate({ ...last, received: null }, first, 'received'), null);
});

test('sync estimates are never readiness and real header targets take precedence', () => {
  const now = 1800000000000;
  assert.equal(chainProgress({ blocks: 0, headers: 0, tipTime: 1231006505 }, false, now), null);
  assert.equal(chainProgress({ blocks: 100, headers: 200 }, false, now).percent, 50);
  const estimated = chainProgress({ blocks: 100, headers: 100, tipTime: now / 1000 - 6000 }, false, now);
  assert.equal(estimated.total, 110);
  assert.equal(estimated.estimated, true);
  assert.equal(chainProgress({ blocks: 100, headers: 100, tipTime: now / 1000 + 10 }, false, now).percent, 99.9);
  assert.equal(chainProgress(null, true).percent, 100);
});

test('pace waits for a minute and resets after gaps, restarts or rollback', () => {
  const history = [{ t: 0, blocks: 100, started: 1 }, { t: 60000, blocks: 160, started: 1 }];
  assert.deepEqual(syncPace(history, 200), { blocksPerSecond: 1, remaining: 40 });
  assert.equal(syncPace(history.slice(0, 1), 200), null);
  for (const change of [{ blocks: null }, { blocks: 90 }, { started: 2 }]) {
    assert.equal(syncPace([...history, { t: 65000, blocks: 165, started: 1, ...change }], 200), null);
  }
});

test('charts use actual elapsed time and break paths across missing observations', () => {
  const result = chartPaths([{ t: 0, value: 1 }, { t: 10, value: 2 }, { t: 50, value: null }, { t: 100, value: 5 }], 'value');
  assert.equal(result.paths.length, 2);
  assert.match(result.paths[0], /L60\.0,/);
  assert.match(result.paths[1], /^M600\.0,/);
  assert.ok(!result.paths.join('').includes('NaN'));
  assert.deepEqual(chartPaths([], 'value').paths, []);
  assert.ok(!chartPaths([{ t: 1, value: 0 }, { t: 2, value: 0 }], 'value').paths[0].includes('NaN'));
});

test('invalid stored preferences fall back to supported defaults', () => {
  assert.deepEqual(displaySettings({ theme: 'unrecognized', interval: 0, window: Infinity }), { theme: 'system', interval: 5, window: 15 });
  assert.deepEqual(displaySettings({ theme: 'dark', interval: 30, window: 60 }), { theme: 'dark', interval: 30, window: 60 });
});
