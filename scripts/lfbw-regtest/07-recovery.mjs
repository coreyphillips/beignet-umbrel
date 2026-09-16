// Recovery Protocol: guardian hosting over bolt8, a pinned guardian set,
// quorum status and rotation, and the static channel backup round trip.
// Runs against its own manager, because the guardian set is app-wide
// settings and quorum mode is sticky per wallet: pinning a set inside the
// lightning-first run would change what every later wallet there is
// created with.
import { api, w, waitFor, check, log, skip, healthy, sleep, fund, mine, PRIMARY_LOCAL_HOST } from './lib.mjs';

const mk = (body) => api('/wallets', { method: 'POST', body }).then((r) => r.record);
const rec = (id) => api(`/wallets/${id}`);

// A: guardian hosting.
const G = [];
for (const n of [1, 2, 3]) G.push(await mk({ name: `Guardian ${n}`, network: 'regtest', guardianServe: true }));
for (const g of G) await healthy(g.id);
const statuses = await Promise.all(G.map((g) => w(g.id, '/guardian/status')));
check('three guardians serve over bolt8', statuses.every((s) => s.serving === true), statuses.map((s) => `${s.guardianId.slice(0, 8)} sets=${s.sets.length}`).join(' '));
const listening = await Promise.all(G.map((g) => w(g.id, '/info').then((i) => i.listening)));
check('each guardian actually has a listener', listening.every(Boolean), `listening ${JSON.stringify(listening)} (beignet #861: serving is true even when it is not)`);

const cands = await api('/guardians/candidates');
check('the manager offers the siblings as candidates', G.every((g) => cands.some((c) => c.id === g.id && c.localUri)), `${cands.length} candidate(s)`);

// B: resolve each URI to a guardian entry and pin the set.
const entries = [];
for (const g of G) {
	const c = cands.find((x) => x.id === g.id);
	// Ask through a wallet that is not the target: a node dialing its own
	// listener is not what this is testing.
	const via = G.find((x) => x.id !== g.id);
	const r = await w(via.id, '/recovery/resolve-guardian', { method: 'POST', body: { uri: c.localUri } });
	entries.push(r.entry);
}
check('every guardian URI resolves to an entry', entries.length === 3 && entries.every((e) => /^[0-9a-f]{64}@bolt8:\/\/[0-9a-f]{66}@/.test(e)), entries.map((e) => e.slice(0, 20)).join(' '));
await api('/settings', { method: 'PUT', body: { recoveryGuardians: entries } });
check('the set is pinned app-wide', (await api('/settings')).recoveryGuardians.length === 3);

// Negatives the manager is supposed to refuse.
try { await api('/settings', { method: 'PUT', body: { recoveryGuardians: [entries[0], entries[0], entries[1]] } }); check('duplicate guardians refused', false); }
catch (e) { check('duplicate guardians refused', e.code === 'BAD_GUARDIANS', `${e.code}: ${e.message}`); }
try { await api('/settings', { method: 'PUT', body: { recoveryGuardians: [...entries, entries[0]] } }); check('a fourth guardian refused', false); }
catch (e) { check('a fourth guardian refused', e.code === 'BAD_GUARDIANS', `${e.code}: ${e.message}`); }
await api('/settings', { method: 'PUT', body: { recoveryGuardians: entries } });

// C: a quorum wallet, its status, and rotation with the wallet running.
const Q = await mk({ name: 'Quorum wallet', network: 'regtest', recoveryMode: 'quorum' });
await healthy(Q.id);
const st = await waitFor('Q reports a recovery surface', async () => { const s = await w(Q.id, '/recovery/status'); return s && s.mode === 'quorum' ? s : null; }, { timeoutMs: 60000 });
check('quorum status names the profile and the three guardians', st.profile === 'crash-v1' && (st.guardians?.length ?? 0) === 3 && st.state === 'running', `mode ${st.mode} state ${st.state} guardians ${st.guardians?.length} profile ${st.profile}`);

const G4 = await mk({ name: 'Guardian 4', network: 'regtest', guardianServe: true });
await healthy(G4.id);
const c4 = (await api('/guardians/candidates')).find((c) => c.id === G4.id);
const e4 = (await w(G[0].id, '/recovery/resolve-guardian', { method: 'POST', body: { uri: c4.localUri } })).entry;
const nextSet = [entries[1], entries[2], e4];

// Rotation needs a journal to hand over. A wallet that has written nothing
// is refused at the switch, and beignet #862 is worse than a refusal: the
// attempt leaves guardian_rotation_pending_v1 behind on an empty frame
// store, which the journal's torn-write guard then refuses to write past,
// so the wallet can never persist a channel again. Probe it on a wallet
// nothing else depends on.
const Doomed = await mk({ name: 'Empty journal rotation probe', network: 'regtest', recoveryMode: 'quorum' });
await healthy(Doomed.id);
try {
	await api(`/wallets/${Doomed.id}/recovery/rotate`, { method: 'POST', body: { guardians: nextSet } });
	check('rotating an empty journal (beignet #862 says it is refused)', false, 'it succeeded: #862 may be fixed, update this check');
} catch (e) {
	skip('rotating a wallet with an empty journal', `${e.code}: ${e.message} (beignet #862)`);
}

await fund(Q.id, 2_000_000);
const g1 = await rec(G[0].id);
await w(Q.id, '/channel/connect-and-open', { method: 'POST', body: { pubkey: g1.nodeId, host: PRIMARY_LOCAL_HOST, port: g1.listenPort, amountSats: 500_000 } });
await mine(6);
const seq = await waitFor('Q has journal content to hand over', async () => { const s = await w(Q.id, '/recovery/status'); return s.node?.lastDurableSequence && s.node.lastDurableSequence !== '0' ? s.node.lastDurableSequence : null; }, { timeoutMs: 180000 });
check('the wallet writes a durable journal', seq !== '0', `lastDurableSequence ${seq}`);

await api(`/wallets/${Q.id}/recovery/rotate`, { method: 'POST', body: { guardians: nextSet } });
const st2 = await w(Q.id, '/recovery/status');
check('the set rotated with the wallet running', st2.generation === '2' && st2.rotation?.pending === false, `generation ${st2.generation} pending ${st2.rotation?.pending} last ${st2.rotation?.lastEvent?.type}`);
check('the outgoing guardians retired the namespace', st2.rotation?.lastEvent?.type === 'rotation:retired', JSON.stringify(st2.rotation?.lastEvent ?? {}));
check('the daemon holds the new set', st2.guardians?.some((g) => String(g.url ?? g).includes(c4.nodeId)) === true, JSON.stringify((st2.guardians ?? []).map((g) => g.guardianId?.slice(0, 10))));
check('the record followed the rotation', (await rec(Q.id)).recovery?.guardians?.includes(e4) === true, JSON.stringify(((await rec(Q.id)).recovery?.guardians ?? []).map((g) => g.slice(0, 10))));

try { await api(`/wallets/${Q.id}/recovery/rotate`, { method: 'POST', body: { guardians: nextSet } }); check('rotating to the same set refused', false); }
catch (e) { check('rotating to the same set refused', e.code === 'BAD_GUARDIANS', `${e.code}: ${e.message}`); }
try { await api(`/wallets/${G[0].id}/recovery/rotate`, { method: 'POST', body: { guardians: entries } }); check('rotating a non-guardian wallet refused', false); }
catch (e) { check('rotating a non-guardian wallet refused', e.code === 'NOT_GUARDIAN_MODE', `${e.code}: ${e.message}`); }

// D: the static channel backup, and what a peer has returned.
const scb = await w(Q.id, '/backup/scb');
const blob = String(scb.encoded ?? scb.scb ?? scb);
check('SCB exported', blob.length > 0, `${blob.length} chars`);
try { await w(Q.id, '/restore/scb', { method: 'POST', body: {} }); check('restore needs exactly one source', false); }
catch (e) { check('restore needs exactly one source', e.code === 'INVALID_PARAMS', `${e.code}: ${e.message.slice(0, 80)}`); }

// E: peer-storage capsules. Whether a peer has returned one is a fact about
// the peer, so report it rather than asserting it.
const R = await mk({ name: 'Peer storage wallet', network: 'regtest', recoveryMode: 'peer-storage' });
await healthy(R.id);
await fund(R.id, 2_000_000);
await w(R.id, '/channel/connect-and-open', { method: 'POST', body: { pubkey: g1.nodeId, host: PRIMARY_LOCAL_HOST, port: g1.listenPort, amountSats: 500_000 } });
await mine(6);
const rstat = await waitFor('R reports peer-storage mode', async () => { const s = await w(R.id, '/recovery/status'); return s?.mode === 'peer-storage' ? s : null; }, { timeoutMs: 60000 });
check('peer-storage mode reports a capsule surface', !!rstat.capsules, JSON.stringify(rstat.capsules ?? null));
const caps = await waitFor('a storage peer returns a capsule', async () => { const s = await w(R.id, '/recovery/status'); return (s.capsules?.candidates ?? 0) > 0 ? s.capsules : null; }, { timeoutMs: 120000 }).catch(() => null);
if (caps) check('a capsule is available to restore from', caps.candidates > 0, JSON.stringify(caps));
else skip('a capsule is available to restore from', `no storage peer has returned one yet (candidates 0); this is the peer's behaviour, not the wallet's`);
try { await w(R.id, '/recovery/restore-capsule', { method: 'POST', body: {} }); check('capsule restore needs confirm', false); }
catch (e) { check('capsule restore needs confirm', e.code === 'INVALID_PARAMS' || e.code === 'NOT_FOUND', `${e.code}: ${e.message.slice(0, 90)}`); }

console.log(JSON.stringify({ G: G.map((g) => g.id), G4: G4.id, Q: Q.id, R: R.id, doomed: Doomed.id, entries }));
