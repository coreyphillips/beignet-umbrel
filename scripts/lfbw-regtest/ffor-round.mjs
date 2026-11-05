// The offline-receive round the two FFOR scenarios share: a receiver R with
// an open channel to a settlement peer S, and a payer X that can route to
// S. R pre-signs a two-voucher book on the channel, hands out the first
// invoice, stops; X pays it while R is down; R starts, and the manager's
// return credits the voucher.
//
// The book has one of two profiles. A plain book is retired by the return:
// the manager's recover closes it cooperatively. A concurrent book (the
// manager's default since beignet 0.25.0, whenever the engine offers it)
// outlives the return: recover syncs it with S, which redeems the settled
// voucher and leaves the book ACTIVE with its unused slot, and the round
// then closes it on purpose.
import { api, w, chainTip, waitFor, check, log, sleep, PRIMARY_LOCAL_HOST, listenPortOf, mine } from './lib.mjs';

export const VOUCHER_SATS = 50000;
const FEE_BASE_MSAT = 1000;
const FEE_PPM = 100;

export const channelWith = async (id, peerNode) =>
	(await w(id, '/channels')).find((c) => c.peerPubkey === peerNode && !/CLOSED|CLOSING/.test(c.state)) || null;

/** Connect `from` to sibling `to` over loopback and open a channel, confirmed and NORMAL on both sides. */
export async function openSiblingChannel(from, to, sats) {
	const toRec = await api(`/wallets/${to}`);
	const fromRec = await api(`/wallets/${from}`);
	const existing = await channelWith(from, toRec.nodeId);
	if (existing && existing.state === 'NORMAL') return existing;
	const open = await w(from, '/channel/connect-and-open', {
		method: 'POST',
		body: { pubkey: toRec.nodeId, host: PRIMARY_LOCAL_HOST, port: await listenPortOf(to), amountSats: sats }
	});
	log(`  ${fromRec.name} -> ${toRec.name} open`, open.state || JSON.stringify(open).slice(0, 80));
	await sleep(4000);
	await mine(6);
	await waitFor(`${fromRec.name} -> ${toRec.name} channel NORMAL on both sides`, async () => {
		const a = await channelWith(from, toRec.nodeId);
		const b = await channelWith(to, fromRec.nodeId);
		return a && b && a.state === 'NORMAL' && b.state === 'NORMAL' && (a.htlcUsable ?? true) && (b.htlcUsable ?? true) ? a : null;
	}, { timeoutMs: 180000, everyMs: 3000 });
	return channelWith(from, toRec.nodeId);
}

export const epochOn = async (id, channelId, role = 'R') =>
	(await w(id, '/ffor/epochs')).find((e) => e.channelId === channelId && e.role === role) || null;

/**
 * The round. `R`, `S`, `X` are wallet ids; `label` names the scenario in
 * the PASS lines; `concurrent` picks the book's profile, and is sent to the
 * manager either way so the round never depends on its default. Returns
 * what it observed for the caller's own checks.
 */
export async function offlineReceiveRound({ R, S, X, label, concurrent }) {
	if (typeof concurrent !== 'boolean') throw new Error('offlineReceiveRound needs concurrent: true or false');
	const Srec = await api(`/wallets/${S}`);
	const Rrec = await api(`/wallets/${R}`);
	const channel = await channelWith(R, Srec.nodeId);
	check(`${label}: R has an open channel to S with the book's worth on S's side`, !!channel && channel.remoteBalanceSats >= 2 * VOUCHER_SATS,
		channel ? JSON.stringify({ state: channel.state, local: channel.localBalanceSats, remote: channel.remoteBalanceSats }) : 'no channel');
	const localBefore = channel.localBalanceSats;
	const tip = await chainTip();
	const settlementDeadline = tip + 144;
	const voucherExpiry = settlementDeadline + 1008 + 144;

	// 1. The book, through the manager (which carries the settlement peer's
	// own policy as the fee terms and runs the setup to ACTIVE).
	const roundStart = Date.now();
	const started = await api(`/wallets/${R}/ffor/epoch`, {
		method: 'POST',
		body: {
			channelId: channel.channelId,
			voucherAmountsMsat: [String(VOUCHER_SATS * 1000), String(VOUCHER_SATS * 1000)],
			settlementDeadline,
			voucherExpiry,
			feeBaseMsat: FEE_BASE_MSAT,
			feeProportionalMillionths: FEE_PPM,
			concurrent
		}
	});
	log('  epoch setup ->', started.step, started.error || '');
	const active = await waitFor('epoch ACTIVE on R', async () => { const e = await epochOn(R, channel.channelId); return e && e.state === 'ACTIVE' ? e : null; }, { timeoutMs: 60000 });
	check(`${label}: epoch ACTIVE with two unissued slots`, active.slots.length === 2 && active.slots.every((s) => s.state === 'unissued'), JSON.stringify(active.slots.map((s) => s.state)));
	check(
		`${label}: the book is ${concurrent ? 'concurrent (version 2)' : 'plain'}, as asked`,
		concurrent ? active.concurrent === true && active.concurrentVersion === 2 : !active.concurrent,
		JSON.stringify({ concurrent: active.concurrent ?? null, concurrentVersion: active.concurrentVersion ?? null })
	);
	const settlements = await w(S, '/ffor/settlements');
	const sView = settlements.find((e) => e.epochId === active.epochId);
	check(`${label}: S lists the epoch under its settlements, ACTIVE`, !!sView && sView.state === 'ACTIVE' && sView.role === 'S', sView ? sView.state : JSON.stringify(settlements.map((e) => e.state)));
	// A scenario can run more than one round on the same channel, so only a
	// return for this book counts.
	const rRec = await api(`/wallets/${R}`);
	check(`${label}: R's record carries no return for this book yet`, !rRec.fforReturn || rRec.fforReturn.epoch?.epochId !== active.epochId);

	// 2. One invoice, then R goes away.
	const inv = await w(R, '/ffor/invoice', { method: 'POST', body: { channelId: channel.channelId, k: 1, description: `${label} voucher 1` } });
	check(`${label}: slot 1 invoice minted for exactly the voucher amount`, !!inv.bolt11 && inv.amountMsat === String(VOUCHER_SATS * 1000) && inv.k === 1, JSON.stringify({ k: inv.k, amountMsat: inv.amountMsat }));
	const exposed = await epochOn(R, channel.channelId);
	check(`${label}: slot 1 reads exposed, slot 2 unissued`, exposed.slots[0].state === 'exposed' && exposed.slots[1].state === 'unissued');
	// beignet 0.21.5: the view carries the invoice back on the exposed slot (#875).
	if ('bolt11' in exposed.slots[0]) {
		check(`${label}: the epoch view carries slot 1's invoice and none for slot 2`, exposed.slots[0].bolt11 === inv.bolt11 && !exposed.slots[1].bolt11);
	} else {
		log('  (engine predates #875: no bolt11 on the view)');
	}
	try {
		await w(R, '/ffor/invoice', { method: 'POST', body: { channelId: channel.channelId, k: 1 } });
		check(`${label}: a second invoice for the same slot is refused`, false);
	} catch (e) {
		check(`${label}: a second invoice for the same slot is refused`, e.code === 'FFOR_REFUSED', `${e.code}: ${e.message.slice(0, 80)}`);
	}
	const stoppedAt = Date.now();
	await api(`/wallets/${R}/stop`, { method: 'POST' });
	let downCode = null;
	try { await w(R, '/info'); } catch (e) { downCode = e.code; }
	check(`${label}: R is down (daemon answers NOT_RUNNING)`, downCode === 'NOT_RUNNING', String(downCode));
	await waitFor('S sees R away', async () => { const c = await channelWith(S, Rrec.nodeId); return c && c.state !== 'NORMAL' ? c : null; }, { timeoutMs: 60000 }).catch(() => log('  (S still reads NORMAL; the reestablish state is not exposed on this row)'));

	// 3. X pays the invoice while R is down.
	const paid = await w(X, '/invoice/pay-safe', { method: 'POST', body: { bolt11: inv.bolt11 } });
	check(`${label}: X's payment completed while R was down`, paid.status === 'COMPLETED', `${paid.status} ${paid.failureDescription || ''}`);
	const settledOnS = await waitFor('S marks slot 1 settled', async () => {
		const e = (await w(S, '/ffor/settlements')).find((x) => x.epochId === active.epochId);
		return e && e.slots[0].state === 'settled' ? e : null;
	}, { timeoutMs: 30000 });
	check(`${label}: S settled slot 1 and holds slot 2 unused`, settledOnS.slots[1].state === 'unused', JSON.stringify(settledOnS.slots.map((s) => s.state)));

	// 4. R returns; the manager reconciles. The record is read only once it
	// is newer than R's stop, so an earlier round's return is never taken for
	// this one.
	await api(`/wallets/${R}/start`, { method: 'POST' });
	const returned = await waitFor('R back and the manager reported a return', async () => {
		const r = await api(`/wallets/${R}`);
		return r.healthy && r.fforReturn && r.fforReturn.channelId === channel.channelId && r.fforReturn.at > stoppedAt ? r : null;
	}, { timeoutMs: 180000, everyMs: 2000 });
	const ret = returned.fforReturn;
	const seen = (e) => JSON.stringify({ state: e && e.state, slots: e && e.slots && e.slots.map((s) => s.state) });
	let closed;
	if (!concurrent) {
		check(`${label}: the return closed the epoch cooperatively`, ret.action === 'closed', JSON.stringify({ action: ret.action, error: ret.error, state: ret.epoch && ret.epoch.state }));
		closed = await waitFor('epoch CLOSED on R', async () => { const e = await epochOn(R, channel.channelId); return e && e.state === 'CLOSED' ? e : null; }, { timeoutMs: 60000 });
		check(`${label}: slot 1 settled and slot 2 unsettled after the close`, closed.slots[0].state === 'settled' && closed.slots[1].state === 'unsettled', seen(closed));
		check(`${label}: the return record carries the settled epoch`, ret.epoch.state === 'CLOSED' && ret.epoch.slots[0].state === 'settled', JSON.stringify({ state: ret.epoch.state, slots: ret.epoch.slots.map((s) => s.state), preimagesKnown: ret.preimagesKnown }));
	} else {
		check(`${label}: the return synced the book and left it ACTIVE`, ret.action === 'synced' && ret.outcome === 'synced' && ret.epoch && ret.epoch.state === 'ACTIVE' && ret.epoch.epochId === active.epochId, JSON.stringify({ action: ret.action, outcome: ret.outcome, error: ret.error, state: ret.epoch && ret.epoch.state }));
	}
	const after = await waitFor('R credited the voucher', async () => { const c = await channelWith(R, Srec.nodeId); return c && c.localBalanceSats >= localBefore + VOUCHER_SATS ? c : null; }, { timeoutMs: 60000 });
	check(`${label}: R's channel balance grew by the voucher`, after.localBalanceSats >= localBefore + VOUCHER_SATS, `local ${localBefore} -> ${after.localBalanceSats}`);
	const logs = await api(`/wallets/${R}/logs`);
	// A synced book's line is written from the recover answer, which can come
	// before the redeemed voucher resolves, so its count is not pinned here;
	// the record is checked once it has caught up, below.
	const returnLine = concurrent ? /ffor return .*: synced, [0-2] of 2 slots settled/ : /ffor return .*closed, 1 of 2 slots settled, 1 preimage known/;
	check(`${label}: the wallet log carries the return line`, logs.some((l) => returnLine.test(l)), logs.filter((l) => /ffor/.test(l)).slice(-2).join(' | '));
	if (concurrent) {
		// The synced book stays ACTIVE with slot 1 redeemed, and the return
		// record catches up with it on the slot's ffor event.
		const live = await waitFor('slot 1 redeemed on R, book still ACTIVE', async () => {
			const e = await epochOn(R, channel.channelId);
			return e && e.epochId === active.epochId && e.state === 'ACTIVE' && e.slots[0].state === 'redeemed' ? e : null;
		}, { timeoutMs: 30000 });
		check(`${label}: after the sync the book is still ACTIVE on R, slot 1 redeemed and slot 2 unissued`, live.slots[1].state === 'unissued', seen(live));
		const caughtUp = await waitFor('the return record shows slot 1 redeemed', async () => {
			const r = (await api(`/wallets/${R}`)).fforReturn;
			return r && r.epoch && r.epoch.epochId === active.epochId && r.epoch.slots[0].state === 'redeemed' ? r : null;
		}, { timeoutMs: 30000 });
		check(`${label}: the return record shows the redeemed voucher`, caughtUp.action === 'synced', seen(caughtUp.epoch));
		// A concurrent book closes once every slot is resolved; closed early,
		// it drains and keeps the open slot's reservation. So slot 2 is paid
		// too, with R up, and then the owner closes the book.
		const inv2 = await w(R, '/ffor/invoice', { method: 'POST', body: { channelId: channel.channelId, k: 2, description: `${label} voucher 2` } });
		const paid2 = await w(X, '/invoice/pay-safe', { method: 'POST', body: { bolt11: inv2.bolt11 } });
		check(`${label}: X paid slot 2 while R was up`, paid2.status === 'COMPLETED', `${paid2.status} ${paid2.failureDescription || ''}`);
		const both = await waitFor('both slots redeemed on R', async () => {
			await w(R, '/ffor/sync', { method: 'POST', body: { channelId: channel.channelId } }).catch(() => null);
			const e = await epochOn(R, channel.channelId);
			return e && e.slots.every((s) => s.state === 'redeemed') ? e : null;
		}, { timeoutMs: 60000 });
		check(`${label}: both vouchers redeemed and the book still ACTIVE`, both.state === 'ACTIVE', seen(both));
		await w(R, '/ffor/epoch/close', { method: 'POST', body: { channelId: channel.channelId } });
		closed = await waitFor('epoch CLOSED on R', async () => { const e = await epochOn(R, channel.channelId); return e && e.state === 'CLOSED' ? e : null; }, { timeoutMs: 60000 });
		check(`${label}: the owner's close ended the book with both slots redeemed`, closed.slots.every((s) => s.state === 'redeemed'), seen(closed));
		const kept = await waitFor('R credited both vouchers', async () => { const c = await channelWith(R, Srec.nodeId); return c && c.localBalanceSats >= localBefore + 2 * VOUCHER_SATS ? c : null; }, { timeoutMs: 60000 });
		check(`${label}: R's channel kept both vouchers through the close`, kept.localBalanceSats >= localBefore + 2 * VOUCHER_SATS, `local ${localBefore} -> ${kept.localBalanceSats}`);
	}
	// Only this round's entries: an earlier round on the channel left its own.
	// A plain book that the startup return closes before the manager's event
	// stream attaches leaves no DRAINING or CLOSED here (#282).
	const events = (await api(`/wallets/${R}/channel-events?channelId=${channel.channelId}`)).filter((e) => e.timestamp >= roundStart);
	check(`${label}: the channel history records the epoch's states`, events.some((e) => e.event === 'ffor:state' && e.state === 'ACTIVE') && events.some((e) => e.event === 'ffor:state' && e.state === 'CLOSED'), JSON.stringify(events.filter((e) => e.event.startsWith('ffor')).map((e) => e.state)));
	// beignet 0.21.5: the credited voucher's invoice reads PAID (#876).
	const rows = await w(R, '/invoices');
	const row = rows.find((i) => i.paymentHash === inv.paymentHash);
	check(`${label}: the voucher invoice reads PAID in the invoice list`, !!row && /PAID|COMPLETED/.test(row.status), row ? row.status : 'missing');
	const sClosed = await waitFor('S reads the epoch CLOSED', async () => {
		const e = (await w(S, '/ffor/settlements')).find((x) => x.epochId === active.epochId);
		return e && e.state === 'CLOSED' ? e : null;
	}, { timeoutMs: 30000 }).catch(() => null);
	check(`${label}: S reads the epoch CLOSED too`, !!sClosed, sClosed ? sClosed.state : 'not CLOSED on S');
	const final = await channelWith(R, Srec.nodeId);
	return { channel, epochId: active.epochId, invoice: inv, localBefore, localAfter: final ? final.localBalanceSats : after.localBalanceSats };
}
