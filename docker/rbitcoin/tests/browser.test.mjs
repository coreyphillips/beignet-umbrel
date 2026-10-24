// Install Playwright outside the repository and set PLAYWRIGHT_MODULE if needed.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../web/html/', import.meta.url));
const server = createServer(async (request, response) => {
  const path = request.url === '/' ? '/index.html' : request.url;
  if (!/^\/[a-z.-]+$/.test(path)) { response.writeHead(404).end(); return; }
  try {
    const contents = await readFile(root + path);
    response.setHeader('Content-Type', path.endsWith('.mjs') ? 'application/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(contents);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, colorScheme: 'light' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let mode = 'sync', blocks = 850420, reads = 0, failSave = false, revision = 'initial';
  const started = Math.floor(Date.now() / 1000) - 184200;
  const defaults = { maxOutbound: 16, maxInbound: 125, mempoolSize: 300, logLevel: 'info' };
  let saved = { ...defaults };
  const json = value => ({ contentType: 'application/json', body: JSON.stringify(value) });
  await page.route('**/config.json', route => route.fulfill(json({ lan: 'umbrel.local:50011', internal: 'beignet-rbitcoin_node_1:50001', appVersion: 'preview' })));
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') {
      if (failSave) return route.fulfill({ status: 409, ...json({ error: 'Settings changed in another window. Reload settings before saving.' }) });
      const payload = route.request().postDataJSON();
      assert.equal(payload.revision, revision);
      saved = payload.settings; revision = 'saved';
    }
    await route.fulfill(json({ saved, defaults, revision, lastLaunched: defaults, restartRequired: JSON.stringify(saved) !== JSON.stringify(defaults) }));
  });
  await page.route('**/node/readyz', route => route.fulfill({ status: mode === 'offline' ? 502 : mode === 'sync' || mode === 'index' ? 503 : 200, body: 'status' }));
  await page.route('**/node/progress', route => route.fulfill(json(mode === 'index' ? { phase: 'sh-index', stage: 'merge', percent: 42, eta_secs: 180 } : { phase: mode === 'sync' ? 'catch-up' : 'ready' })));
  await page.route('**/node/metrics', route => {
    if (mode === 'missing') return route.fulfill({ status: 404, body: '' });
    reads++; blocks += 62;
    return route.fulfill({ contentType: 'text/plain', body: `rbitcoin_blocks ${blocks}\nrbitcoin_headers ${blocks}\nrbitcoin_tip_time_seconds 1723200000\nprocess_start_time_seconds ${started}\nprocess_resident_memory_bytes 1623456789\nrbitcoin_connections{direction="in"} 8\nrbitcoin_connections{direction="out"} 16\nrbitcoin_peers{network="ipv4"} 18\nrbitcoin_peers{network="ipv6"} 5\nrbitcoin_peers{network="onion"} 1\nrbitcoin_peers{network="i2p"} 0\nrbitcoin_peers{network="cjdns"} 0\nrbitcoin_network_receive_bytes_total ${9000000000 + reads * 700000}\nrbitcoin_network_transmit_bytes_total ${10000000 + reads * 8000}\nrbitcoin_mempool_transactions 1284\nrbitcoin_mempool_bytes 18000000\nrbitcoin_mempool_max_weight 300000000\nrbitcoin_mempool_min_fee_sat_per_vb 1.2\n` });
  });
  await page.goto(origin);
  await page.getByText('Sync in progress', { exact: true }).waitFor();
  assert.equal(await page.locator('#peer-count').textContent(), '24');
  assert.equal(await page.locator('#mempool-percent').textContent(), '24.0% used');
  for (let i = 0; i < 6; i++) { await page.locator('#refresh').click(); await page.waitForTimeout(80); }
  assert.ok(await page.locator('#height-chart svg').count());
  assert.ok(await page.locator('#traffic-chart svg').count());
  assert.match(await page.locator('#sync-label').textContent(), /estimated/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/overview-desktop.png`, fullPage: true, animations: 'disabled' });

  await page.getByRole('link', { name: /Settings/ }).click();
  await page.locator('#max-outbound').fill('8');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Restart needed', { exact: true }).waitFor();
  assert.equal(saved.maxOutbound, 8);
  assert.match(await page.locator('#active-maxOutbound').textContent(), /16/);
  await page.getByRole('button', { name: 'Restore defaults', exact: true }).click();
  assert.equal(await page.locator('#max-outbound').inputValue(), '16');
  assert.equal(saved.maxOutbound, 8, 'restore does not save before review');
  failSave = true;
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Settings changed in another window. Reload settings before saving.').waitFor();
  assert.equal(await page.locator('#max-outbound').inputValue(), '16', 'conflict preserves the draft');
  failSave = false;
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('No unsaved changes', { exact: true }).waitFor();
  await page.locator('#theme').selectOption('dark');
  await page.locator('#refresh-interval').selectOption('30');
  await page.locator('#settings-window').selectOption('60');
  await page.reload();
  await page.locator('#node-fields:not([disabled])').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  assert.equal(await page.locator('#refresh-interval').inputValue(), '30');
  assert.equal(await page.locator('#settings-window').inputValue(), '60');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/settings-dark.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: 'Reset display preferences' }).click();
  assert.equal(await page.locator('#theme').inputValue(), 'system');

  await page.getByRole('link', { name: 'Connect a wallet', exact: true }).first().click();
  assert.equal(await page.locator('#lan').inputValue(), 'umbrel.local:50011');
  await page.locator('[data-copy="lan"]').click();
  await page.locator('#toast:not([hidden])').waitFor();
  assert.match(await page.locator('#toast').textContent(), /copied|selected/);
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/connections-mobile.png`, fullPage: true, animations: 'disabled' });
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  mode = 'ready'; await page.locator('#refresh').click();
  await page.getByText('Node is ready', { exact: true }).waitFor();
  assert.equal(await page.locator('#sync-percent').textContent(), '100.0%');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/overview-mobile.png`, fullPage: true, animations: 'disabled' });
  mode = 'offline'; await page.locator('#refresh').click();
  await page.getByText('Not answering', { exact: true }).waitFor();
  assert.equal(await page.locator('#block-height').textContent(), 'Unavailable');
  assert.equal(await page.locator('#sync-percent').textContent(), 'n/a');
  assert.match(await page.locator('#connection-alert').textContent(), /Historical charts/);
  mode = 'index'; await page.locator('#refresh').click();
  await page.getByText('42.0%', { exact: true }).waitFor();
  assert.equal(await page.locator('#sync-label').textContent(), 'current stage');
  mode = 'missing'; await page.locator('#refresh').click();
  await page.getByText('Node is ready', { exact: true }).waitFor();
  assert.equal(await page.locator('#mempool-count').textContent(), 'Unavailable');
  assert.equal(await page.locator('#connection-alert').isVisible(), true);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of ['overview', 'connections', 'settings']) {
      await page.evaluate(view => { location.hash = view; }, view);
      await page.waitForTimeout(50);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width} on ${view}`);
    }
  }
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: live states, charts, settings saves/conflicts, preferences, copy, and responsive layouts.');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
