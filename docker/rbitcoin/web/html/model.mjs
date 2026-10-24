// Pure transformations shared by the dashboard and its regression tests.
export function parseMetrics(text) {
  const samples = [];
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+([^\s]+)(?:\s+\d+)?\s*$/.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    const labels = {};
    for (const label of (match[2] || '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g)) {
      labels[label[1]] = label[2].replace(/\\([\\"])/g, '$1');
    }
    samples.push({ name: match[1], labels, value });
  }
  return (name, labels = {}) => samples.find(s => s.name === name &&
    Object.entries(labels).every(([key, value]) => s.labels[key] === value))?.value ?? null;
}

export function snapshot(text, now = Date.now()) {
  const get = parseMetrics(text);
  return {
    t: now, blocks: get('rbitcoin_blocks'), headers: get('rbitcoin_headers'),
    tipTime: get('rbitcoin_tip_time_seconds'), started: get('process_start_time_seconds'),
    memory: get('process_resident_memory_bytes'), inbound: get('rbitcoin_connections', { direction: 'in' }),
    outbound: get('rbitcoin_connections', { direction: 'out' }),
    received: get('rbitcoin_network_receive_bytes_total'), sent: get('rbitcoin_network_transmit_bytes_total'),
    transactions: get('rbitcoin_mempool_transactions'), vbytes: get('rbitcoin_mempool_bytes'),
    maxWeight: get('rbitcoin_mempool_max_weight'), minFee: get('rbitcoin_mempool_min_fee_sat_per_vb'),
    networks: Object.fromEntries(['ipv4', 'ipv6', 'onion', 'i2p', 'cjdns'].map(network =>
      [network, get('rbitcoin_peers', { network })])),
  };
}

export function rate(current, previous, key) {
  if (!previous || current[key] === null || previous[key] === null ||
      current.started !== previous.started || current.t <= previous.t || current[key] < previous[key]) return null;
  return (current[key] - previous[key]) / ((current.t - previous.t) / 1000);
}

export function chainProgress(sample, ready, now = Date.now()) {
  if (ready) return { percent: 100, total: sample?.blocks ?? null, estimated: false };
  if (!sample || sample.blocks === null) return null;
  let total = sample.headers, estimated = false;
  if (total === null || total <= sample.blocks + 6) {
    if (!sample.tipTime || sample.tipTime <= 1231006505) return null;
    total = sample.blocks + Math.max(0, Math.round((now / 1000 - sample.tipTime) / 600));
    estimated = true;
  }
  if (total <= 0) return null;
  return { total, estimated, percent: Math.max(0, Math.min(99.9, sample.blocks / total * 100)) };
}

export function syncPace(history, total) {
  const last = history.at(-1);
  if (!last || last.blocks === null) return null;
  // A gap, restart or reorganization starts a new pace window.
  let start = history.length - 1;
  while (start > 0) {
    const previous = history[start - 1], current = history[start];
    if (previous.blocks === null || previous.started !== last.started ||
        current.blocks < previous.blocks || last.t - previous.t > 15 * 60_000) break;
    start--;
  }
  const first = history[start], seconds = (last.t - first.t) / 1000;
  if (seconds < 60 || last.blocks <= first.blocks) return null;
  const blocksPerSecond = (last.blocks - first.blocks) / seconds;
  return { blocksPerSecond, remaining: Math.max(0, total - last.blocks) / blocksPerSecond };
}

export function chartPaths(samples, key, { width = 600, height = 130, floorZero = true } = {}) {
  const values = samples.map(s => s[key]).filter(Number.isFinite);
  if (!values.length || samples.length < 2) return { paths: [], min: 0, max: 0 };
  const min = floorZero ? 0 : Math.min(...values);
  const max = Math.max(...values, min + 1);
  const start = samples[0].t, duration = Math.max(1, samples.at(-1).t - start);
  const paths = [];
  let path = '';
  for (const sample of samples) {
    if (!Number.isFinite(sample[key])) {
      if (path) paths.push(path);
      path = '';
      continue;
    }
    const x = (sample.t - start) / duration * width;
    const y = height - (sample[key] - min) / (max - min) * (height - 8) - 4;
    path += `${path ? ' L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  if (path) paths.push(path);
  return { paths, min, max };
}

export const displayDefaults = { theme: 'system', interval: 5, window: 15 };
export function displaySettings(value) {
  return {
    theme: ['system', 'light', 'dark'].includes(value?.theme) ? value.theme : 'system',
    interval: [5, 10, 30].includes(value?.interval) ? value.interval : 5,
    window: [5, 15, 60].includes(value?.window) ? value.window : 15,
  };
}
