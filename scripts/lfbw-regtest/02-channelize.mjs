import { api, w, btc, mine, waitFor, check, log, fund, sleep } from './lib.mjs';
const ids = JSON.parse(process.argv[2]);
const { P, L1, Pnode } = ids;
const homeOf = async () => (await w(L1, '/channels')).find((c) => c.peerPubkey === Pnode && c.state !== 'CLOSED');
const before = await homeOf();
log('home before', before.capacitySats, 'local', before.localBalanceSats);
// 50k unconfirmed: nothing moves.
const { txid } = await fund(L1, 50000, { confirm: false });
await waitFor('L1 sees 50k unconfirmed', async () => (await w(L1, '/balance')).onchain >= 50000);
await sleep(8000);
const mid = await homeOf();
const utxos = await w(L1, '/utxos');
check('nothing moves at 0 conf', mid.capacitySats === before.capacitySats && mid.state === 'NORMAL', `utxo heights ${JSON.stringify(utxos.map((u) => u.height))}`);
mine(1);
const after = await waitFor('splice-in after one confirmation', async () => { const h = await homeOf(); return h && h.capacitySats > before.capacitySats ? h : null; }, { timeoutMs: 120000 });
check('home channel grew by about 50k', after.capacitySats >= before.capacitySats + 40000, `cap ${before.capacitySats} -> ${after.capacitySats} state ${after.state}`);
const l1logs = await api(`/wallets/${L1}/logs`);
check('manager logged the splice', l1logs.some((l) => /lightning-first: splicing/.test(l)), l1logs.filter((l) => /lightning-first/.test(l)).slice(-3).join(' | '));
await waitFor('splice locks (usable, no longer SPLICING)', async () => { const h = await homeOf(); return h && h.state === 'NORMAL' && (h.htlcUsable ?? true) ? h : null; }, { timeoutMs: 120000 });
const bal = await w(L1, '/balance');
check('on-chain balance drained into the channel', bal.onchain < 5000, `onchain ${bal.onchain}`);
// 10k confirmed: below the floor, stays.
await fund(L1, 10000);
await waitFor('L1 sees 10k', async () => (await w(L1, '/balance')).onchain >= 10000);
await sleep(8000);
const still = await homeOf();
check('10k stays on-chain below the floor', still.capacitySats === after.capacitySats && (await w(L1, '/balance')).onchain >= 10000);
// Restart L1: trust re-applied, no second starting channel.
await api(`/wallets/${L1}/stop`, { method: 'POST' });
await api(`/wallets/${L1}/start`, { method: 'POST' });
await waitFor('L1 back and ready', async () => { const r = await api(`/wallets/${L1}`); return r.healthy && r.lfbw.setup === 'ready' ? r : null; }, { timeoutMs: 120000 });
await sleep(3000);
const chans = await w(L1, '/channels');
check('still one channel with P after restart', chans.filter((c) => c.peerPubkey === Pnode && c.state !== 'CLOSED').length === 1, JSON.stringify(chans.map((c) => [c.state, c.capacitySats])));
const trust = await w(L1, '/trusted-peers');
check('trust re-applied after restart', trust.some((t) => t.pubkey === Pnode));
console.log(JSON.stringify(ids));
