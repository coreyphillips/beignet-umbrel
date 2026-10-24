import { snapshot, rate, chainProgress, syncPace, chartPaths, displayDefaults, displaySettings } from './model.mjs';

const $ = id => document.getElementById(id);
const set = (id, value) => { $(id).textContent = value; };
const count = value => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : 'Unavailable';
const bytes = value => {
  if (!Number.isFinite(value)) return 'Unavailable';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.max(0, Math.min(4, Math.floor(Math.log2(Math.max(1, value)) / 10)));
  return `${(value / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
};
const duration = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return 'Unavailable';
  const mins = Math.floor(seconds / 60), hours = Math.floor(mins / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours) return `${hours}h ${mins % 60}m`;
  return mins ? `${mins}m` : '< 1m';
};
const date = seconds => Number.isFinite(seconds) && seconds > 0 ?
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Block time unavailable';
let preferences = { ...displayDefaults };
try { preferences = displaySettings(JSON.parse(localStorage.getItem('rbitcoin.dashboard'))); } catch {}
let history = [], previous = null, latest = null, lastSuccess = null;
let timer, busy = false, pendingRefresh = false, settings = null, dirty = false, saving = false, loadingSettings = false;
let toastTimer;
function toast(message) {
  set('toast', message); $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
}
async function request(url, options = {}) {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
    // Consume the body before clearing the timeout, including stalled responses.
    const text = await response.text();
    return { status: response.status, ok: response.ok, text };
  } finally { clearTimeout(timeout); }
}
function applyPreferences(save = false) {
  if (preferences.theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preferences.theme;
  $('theme').value = preferences.theme;
  $('refresh-interval').value = preferences.interval;
  $('history-window').value = $('settings-window').value = preferences.window;
  if (save) {
    try { localStorage.setItem('rbitcoin.dashboard', JSON.stringify(preferences)); set('display-message', 'Preferences saved in this browser'); }
    catch { set('display-message', 'Applied for this visit. Browser storage is unavailable.'); }
  }
  renderCharts();
}
function stat(id, value) { set(id, value); $(id).dataset.missing = value === 'Unavailable'; }
function showMetrics(sample) {
  stat('block-height', count(sample?.blocks));
  set('tip-date', sample ? `Tip: ${date(sample.tipTime)}` : 'Waiting for chain data');
  const peers = sample?.inbound !== null && sample?.outbound !== null && sample ? sample.inbound + sample.outbound : null;
  stat('peer-count', count(peers));
  set('peer-detail', peers === null ? 'Inbound + outbound unavailable' : `${count(sample.inbound)} inbound · ${count(sample.outbound)} outbound`);
  stat('mempool-count', count(sample?.transactions));
  stat('uptime', sample?.started ? duration(Date.now() / 1000 - sample.started) : 'Unavailable');
  set('memory', sample?.memory != null ? `${bytes(sample.memory)} memory in use` : 'Memory usage unavailable');
  set('download-rate', sample?.download != null ? `${bytes(sample.download)}/s` : 'Measuring rate');
  set('upload-rate', sample?.upload != null ? `↑ ${bytes(sample.upload)}/s` : 'Upload unavailable');
  set('traffic-total', sample?.received != null ? `${bytes(sample.received)} received since startup` : 'P2P data received unavailable');
  const networks = $('peer-networks'); networks.replaceChildren();
  const total = sample ? Object.values(sample.networks).reduce((sum, n) => sum + (n || 0), 0) : 0;
  for (const [name, label] of Object.entries({ ipv4: 'IPv4', ipv6: 'IPv6', onion: 'Tor', i2p: 'I2P', cjdns: 'CJDNS' })) {
    const n = sample?.networks[name];
    const row = document.createElement('div'); row.className = 'peer-row';
    const title = document.createElement('span'); title.textContent = label;
    const track = document.createElement('div'); track.className = 'peer-track'; track.setAttribute('aria-hidden', 'true');
    const fill = document.createElement('div'); fill.className = 'peer-fill'; fill.style.width = `${total ? (n || 0) / total * 100 : 0}%`; track.append(fill);
    const value = document.createElement('strong'); value.textContent = n == null ? 'n/a' : count(n);
    row.append(title, track, value); networks.append(row);
  }
  const capacity = sample?.maxWeight > 0 ? sample.maxWeight / 4 : null;
  const used = sample?.vbytes;
  const percent = capacity && used != null ? Math.max(0, Math.min(100, used / capacity * 100)) : null;
  set('mempool-percent', percent === null ? 'Unavailable' : `${percent.toFixed(1)}% used`);
  set('mempool-capacity', percent === null ? 'Mempool metrics are not available yet.' : `${count(used)} / ${count(capacity)} virtual bytes`);
  set('min-fee', sample?.minFee != null ? `${sample.minFee.toLocaleString(undefined, { maximumFractionDigits: 3 })} sat/vB` : 'Unavailable');
  $('capacity-blocks').replaceChildren(...Array.from({ length: 24 }, (_, i) => {
    const block = document.createElement('span');
    if (percent !== null && i < Math.ceil(percent / 100 * 24)) block.className = 'filled';
    return block;
  }));
}
function drawChart(id, key, label, floorZero) {
  const target = $(id), samples = history.filter(s => s.t >= Date.now() - preferences.window * 60_000);
  const { paths, min, max } = chartPaths(samples, key, { floorZero });
  target.replaceChildren();
  if (samples.filter(s => Number.isFinite(s[key])).length < 2) {
    const empty = document.createElement('div'); empty.className = 'chart-empty';
    empty.textContent = 'Collecting live samples...'; target.append(empty); return;
  }
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 600 130'); svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', `${label}. ${samples.filter(s => Number.isFinite(s[key])).length} samples. Range ${min.toFixed(1)} to ${max.toFixed(1)}. Last ${preferences.window} minutes.`);
  for (const y of [4, 65, 126]) {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', '0'); line.setAttribute('x2', '600'); line.setAttribute('y1', y); line.setAttribute('y2', y); line.setAttribute('class', 'gridline'); svg.append(line);
  }
  for (const path of paths) {
    const line = document.createElementNS(ns, 'path'); line.setAttribute('class', 'series'); line.setAttribute('d', path); svg.append(line);
  }
  const axis = document.createElement('div'); axis.className = 'chart-axis'; axis.setAttribute('aria-hidden', 'true');
  const format = value => key === 'download' ? `${bytes(value)}/s` : count(value);
  for (const value of [max, min]) {
    const tick = document.createElement('span'); tick.textContent = format(value); axis.append(tick);
  }
  target.append(axis);
  target.append(svg);
}
function renderCharts() {
  drawChart('height-chart', 'blocks', 'Block height', false);
  drawChart('traffic-chart', 'download', 'Download bytes per second', true);
  const visible = history.filter(s => s.t >= Date.now() - preferences.window * 60_000 && s.blocks !== null);
  set('height-range', visible.length ? `${count(visible[0].blocks)} → ${count(visible.at(-1).blocks)} blocks` : 'Collecting samples');
}
function renderStatus(ready, progress, sample) {
  $('health-badge').dataset.tone = ready ? 'ok' : 'warn';
  set('health-badge', ready ? 'Node is ready' : 'Sync in progress');
  const stagePercent = typeof progress?.percent === 'number' && Number.isFinite(progress.percent) ? Math.min(100, Math.max(0, progress.percent)) : null;
  const chain = chainProgress(sample, ready);
  const percent = ready ? 100 : stagePercent ?? chain?.percent;
  $('sync-ring').setAttribute('stroke-dasharray', `${percent ?? 0} 100`);
  set('sync-percent', percent == null ? '...' : `${percent.toFixed(1)}%`);
  set('sync-label', ready ? 'ready for wallets' : stagePercent != null ? 'current stage' : chain?.estimated ? 'estimated progress' : 'chain progress');
  const phase = [progress?.phase, progress?.stage].filter(v => typeof v === 'string').join(' · ');
  const pace = chain && syncPace(history, chain.total);
  set('chain-pace', pace ? `${pace.blocksPerSecond.toFixed(1)} blocks/s` : ready ? 'Following the tip' : 'Measuring pace');
  if (ready) {
    set('sync-title', 'In sync. In your hands.');
    set('sync-detail', 'Your node is following the chain tip and ready to serve your wallets.');
    set('sync-eta', sample?.tipTime ? `Latest block: ${date(sample.tipTime)}. Your node independently validates new blocks.` : 'Wallets can connect now.');
  } else if (stagePercent != null) {
    set('sync-title', 'Preparing your node.');
    set('sync-detail', `${phase || 'Indexing'} · ${stagePercent.toFixed(1)}% complete`);
    set('sync-eta', Number.isFinite(progress.eta_secs) ? `About ${duration(progress.eta_secs)} remaining in this stage. Wallets can connect once the node is ready.` : 'Building or checking indexes. Wallets can connect once the node is ready.');
  } else {
    set('sync-title', 'Catching up with Bitcoin.');
    set('sync-detail', chain ? `Validated ${count(sample.blocks)} of ${chain.estimated ? 'about ' : ''}${count(chain.estimated ? Math.round(chain.total / 1000) * 1000 : chain.total)} blocks. ${chain.estimated ? 'Total estimated from block times.' : 'Target reported by node headers.'}` : `${phase || 'Starting up'}. Waiting for chain metrics.`);
    set('sync-eta', pace ? `About ${duration(pace.remaining)} at the observed pace. Early estimates are optimistic as blocks grow heavier.` : 'Initial sync can take a day or more. A pace estimate appears after at least one minute of progress.');
  }
  // A percentage describes an index stage, not chain validation completion.
  $('step-chain').dataset.state = ready || stagePercent !== null ? 'done' : 'active';
  $('step-index').dataset.state = ready ? 'done' : stagePercent !== null ? 'active' : '';
  $('step-ready').dataset.state = ready ? 'done' : '';
  set('wallet-readiness', ready ? 'Ready to connect. Electrum is available for your wallets.' : 'Sync in progress. Wallet connections become available after initial sync and indexing.');
}
function unavailable(message) {
  $('health-badge').dataset.tone = 'bad'; set('health-badge', 'Not answering');
  set('sync-title', 'Waiting for your node.');
  set('sync-detail', 'The node may be starting, restarting, or offline.');
  set('sync-eta', 'Give it a minute after an install or update. If this continues, check the app logs in Umbrel. This build requires x86_64 hardware.');
  set('sync-percent', 'n/a'); set('sync-label', 'status unavailable'); $('sync-ring').setAttribute('stroke-dasharray', '0 100');
  set('chain-pace', 'Status unavailable');
  for (const id of ['step-chain', 'step-index', 'step-ready']) $(id).dataset.state = '';
  set('wallet-readiness', 'The node is not answering. Check its status before connecting a wallet.');
  $('connection-alert').hidden = false; set('connection-alert', message);
  showMetrics(null); previous = null; latest = null;
}
async function poll() {
  clearTimeout(timer);
  if (busy) { pendingRefresh = true; return; }
  busy = true; $('refresh').disabled = true;
  const results = await Promise.allSettled(['/node/readyz', '/node/progress', '/node/metrics'].map(url => request(url)));
  const [readyResult, progressResult, metricsResult] = results;
  const ready = readyResult.status === 'fulfilled' ? readyResult.value : null;
  try {
    if (!ready || ![200, 503].includes(ready.status)) {
      unavailable('Live status is unavailable. Historical charts below are retained from this visit.');
      history.push({ t: Date.now(), blocks: null, download: null, started: null });
    } else {
      let progress = null;
      if (progressResult.status === 'fulfilled' && progressResult.value.ok) {
        try { progress = JSON.parse(progressResult.value.text); } catch {}
      }
      let sample = metricsResult.status === 'fulfilled' && metricsResult.value.ok ? snapshot(metricsResult.value.text) : null;
      if (sample && Object.entries(sample).every(([key, value]) => ['t', 'networks'].includes(key) || value === null)) sample = null;
      $('connection-alert').hidden = sample !== null;
      if (!sample) set('connection-alert', 'Node status is available, but metrics are unavailable. Charts will resume when metrics return.');
      if (sample) {
        sample.download = rate(sample, previous, 'received'); sample.upload = rate(sample, previous, 'sent');
        history.push(sample); previous = sample;
      } else { history.push({ t: Date.now(), blocks: null, download: null, started: null }); previous = null; }
      latest = sample; lastSuccess = Date.now();
      showMetrics(sample); renderStatus(ready.status === 200, progress, sample);
    }
    history = history.filter(s => s.t >= Date.now() - 60 * 60_000).slice(-725);
    renderCharts();
    set('freshness', latest ? `Updated ${new Date(lastSuccess).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : 'Live metrics unavailable');
  } finally {
    busy = false; $('refresh').disabled = false;
    timer = setTimeout(poll, pendingRefresh ? 0 : preferences.interval * 1000); pendingRefresh = false;
  }
}

function nodeValues() {
  const data = new FormData($('node-settings'));
  return { maxOutbound: Number(data.get('maxOutbound')), maxInbound: Number(data.get('maxInbound')), mempoolSize: Number(data.get('mempoolSize')), logLevel: data.get('logLevel') };
}
function updateDirty() {
  dirty = settings && Object.keys(settings.saved).some(key => nodeValues()[key] !== settings.saved[key]);
  $('save-node').disabled = !dirty || saving;
  set('dirty-state', dirty ? 'Unsaved changes' : 'No unsaved changes');
}
function message(text, error = false) {
  $('settings-message').hidden = !text; set('settings-message', text);
  $('settings-message').className = `notice${error ? ' error' : ''}`;
}
function fillSettings(data) {
  settings = data;
  for (const [key, value] of Object.entries(data.saved)) {
    $('node-settings').elements.namedItem(key).value = value;
    set(`active-${key}`, data.lastLaunched ? `At last node launch: ${data.lastLaunched[key]}` : 'Not yet recorded at node launch');
  }
  $('node-fields').disabled = false;
  $('settings-dot').hidden = !data.restartRequired;
  set('settings-state', data.restartRequired ? 'Restart needed' : 'Saved');
  message(data.restartRequired ? 'Saved defaults differ from the last node launch. Restart the rbitcoin app in Umbrel to apply them. Explicit compose flags take precedence.' : 'Saved defaults match the last node launch. Live health is shown on Overview.');
  updateDirty();
}
async function loadSettings() {
  if (saving || loadingSettings) return;
  loadingSettings = true; $('reload-settings').disabled = true;
  $('node-fields').disabled = true;
  try {
    const response = await request('/api/settings');
    if (!response.ok) {
      let detail; try { detail = JSON.parse(response.text).error; } catch {}
      throw new Error(detail || 'Node settings are unavailable. Check the settings service, then reload.');
    }
    fillSettings(JSON.parse(response.text));
  } catch (error) { message(error.message, true); if (!settings) set('settings-state', 'Unavailable'); }
  finally { loadingSettings = false; $('reload-settings').disabled = false; $('node-fields').disabled = !settings; }
}
$('node-settings').addEventListener('input', updateDirty);
$('node-settings').addEventListener('change', updateDirty);
$('node-settings').addEventListener('submit', async event => {
  event.preventDefault(); if (!settings || saving || !$('node-settings').reportValidity()) return;
  const values = nodeValues(); saving = true;
  $('node-fields').disabled = true; $('reload-settings').disabled = true; set('save-node', 'Saving...');
  try {
    const response = await request('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'rbitcoin-dashboard' }, body: JSON.stringify({ settings: values, revision: settings.revision }) });
    let data; try { data = JSON.parse(response.text); } catch { throw new Error('The settings service did not respond. Your edits are still here. Try again.'); }
    if (!response.ok) throw new Error(data.error || 'Settings could not be saved.');
    fillSettings(data); toast(data.restartRequired ? 'Settings saved. Restart the app in Umbrel to apply.' : 'Settings saved.');
  } catch (error) { message(error.message, true); }
  finally { saving = false; $('node-fields').disabled = false; $('reload-settings').disabled = false; set('save-node', 'Save changes'); updateDirty(); }
});
$('restore-node').addEventListener('click', () => {
  if (!settings) return;
  for (const [key, value] of Object.entries(settings.defaults)) $('node-settings').elements.namedItem(key).value = value;
  updateDirty(); message('Default values are ready to review. Choose Save changes to keep them.');
});
$('reload-settings').addEventListener('click', () => {
  if (dirty && !window.confirm('Discard your unsaved edits and reload saved node settings?')) return;
  loadSettings();
});
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
function navigate() {
  const page = ['overview', 'connections', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
  for (const section of document.querySelectorAll('.page')) section.hidden = section.id !== page;
  for (const link of document.querySelectorAll('.navigation>a')) {
    if (link.hash === `#${page}`) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (page === 'settings' && !dirty) loadSettings();
}
window.addEventListener('hashchange', navigate);
for (const [id, key] of [['theme', 'theme'], ['refresh-interval', 'interval'], ['history-window', 'window'], ['settings-window', 'window']]) {
  $(id).addEventListener('change', () => {
    preferences[key] = key === 'theme' ? $(id).value : Number($(id).value); applyPreferences(true);
    if (key === 'interval') { clearTimeout(timer); if (!busy) timer = setTimeout(poll, preferences.interval * 1000); }
  });
}
$('restore-display').addEventListener('click', () => { preferences = { ...displayDefaults }; applyPreferences(true); clearTimeout(timer); if (!busy) timer = setTimeout(poll, preferences.interval * 1000); });
$('refresh').addEventListener('click', poll);
for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    const input = $(button.dataset.copy);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(input.value);
      else { input.focus(); input.select(); if (!document.execCommand('copy')) throw new Error('clipboard'); button.focus(); }
      toast('Server address copied');
    } catch { input.focus(); input.select(); toast('Address selected. Use your device’s Copy command.'); }
  });
}
applyPreferences(); navigate(); showMetrics(null);
request('/config.json').then(response => {
  if (!response.ok) throw new Error('config');
  const data = JSON.parse(response.text);
  for (const id of ['lan', 'internal']) if (typeof data[id] === 'string') {
    $(id).value = data[id]; document.querySelector(`[data-copy="${id}"]`).disabled = false;
  }
  set('app-version', data.appVersion || 'unavailable');
}).catch(() => { for (const id of ['lan', 'internal']) $(id).value = 'Address unavailable'; });
loadSettings(); poll();
