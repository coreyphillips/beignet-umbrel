'use strict';
// Adapt the shared acceptance sequence to the actual manager and packaged daemon.
let walletId;
exports.start = async ({ h }) => {
  const base = process.env.MANAGER_URL || 'http://127.0.0.1:39078';
  async function request({ path, method = 'GET', body }) {
    if (method === 'POST' && path.endsWith('/ffor/epoch/start')) path = `/api/wallets/${walletId}/ffor/epoch`;
    if (method === 'POST' && path.endsWith('/ffor/sync')) path = `/api/wallets/${walletId}/ffor/return`;
    const res = await fetch(base + path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw Object.assign(Error(data.error?.message || `HTTP ${res.status}`), data.error);
    if (path === '/api/wallets' && method === 'POST') {
      walletId = data.result.record.id;
      const until = Date.now() + 120000;
      for (;;) {
        const record = await request({ path: `/api/wallets/${walletId}` });
        if (record.healthy && record.lfbw?.setup === 'ready') break;
        if (Date.now() > until) throw Error('Receiver startup timed out');
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    // The manager and daemon return their authoritative state.
    return data.result;
  }
  const config = await request({ path: '/api/config' });
  if (config.engineVersion !== '0.25.0' || !config.concurrentOfflineReceiveAvailable) throw Error('Packaged concurrent daemon required');
  if (walletId) {
    await request({ path: `/api/wallets/${walletId}/start`, method: 'POST' });
    const until = Date.now() + 120000;
    while (!(await request({ path: `/api/wallets/${walletId}` })).healthy) {
      if (Date.now() > until) throw Error('Receiver restart timed out');
      await new Promise(resolve => setTimeout(resolve,500));
    }
  }
  h.primaryUri = `${h.primary.getInfo().nodeId}@127.0.0.1:${h.peerPort}`;
  h.electrum = { host:'127.0.0.1', port:60001, tls:false };
  const { EmbeddedWalletClient } = await import(require('node:path').join(process.env.BEIGNET_WALLET_CORE_DIR, 'src/index.js'));
  const core = new EmbeddedWalletClient({ runtime: { request }, ...(walletId ? { walletId } : {}) });
  // Match the dashboard's quote and creation requests. Its invoice history is
  // the daemon ledger, not the portable runtime's receive-request registry.
  const client = new Proxy(core, { get(target, name) {
    if (name === 'snapshot') return async () => {
      const get = route => request({ path: `/wallets/${walletId}/api${route}` });
      const [balance, liquidity, payments, channels] = await Promise.all(['/balance', '/liquidity', '/payments', '/channels'].map(get));
      return { balance: { totalSats: balance.onchain + balance.lightning + (balance.splicingSats || 0), availableSats: liquidity.sendableSats,
        reservedInboundSats: channels.reduce((sum, ch) => sum + (ch.ffor?.reservedInboundSats || 0), 0) },
        activity: payments.map(payment => ({ ...payment, status: payment.status.toLowerCase() })) };
    };
    if (name === 'quoteReceive') return async ({ amountSats, description, mode }) => {
      if (mode !== 'offline') throw Error('Explicit offline mode required');
      const peer = h.primary.getInfo().nodeId;
      const requestId = require('node:crypto').randomUUID();
      const quote = await request({ path: `/wallets/${walletId}/api/receive/quote?peer=${peer}&amountSats=${amountSats}&requestId=${requestId}` });
      return { quote, peer, requestId, amountSats, description };
    };
    if (name === 'receive') return async body => request({ path: `/wallets/${walletId}/api/receive/invoice`, method: 'POST', body: { ...body, expirySecs: 600 } });
    return typeof target[name] === 'function' ? target[name].bind(target) : target[name];
  } });
  return { request, client, engineVersion: config.engineVersion, offlineStatusPath: '/receive/status',
    identity: { manager: base, engine: config.engineVersion, walletId: walletId || null, startedAt: Date.now() },
    stop: async () => { if(walletId) await request({path:`/api/wallets/${walletId}/stop`,method:'POST'}); } };
};
