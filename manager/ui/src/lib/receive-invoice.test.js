/**
 * Run with: npm test (from manager/ui).
 *
 * The one place a Lightning invoice's kind is chosen, shared by the Receive
 * tab and LNURL withdrawals. What is pinned here is the part only a
 * withdrawal reaches: called with nothing read yet, it reads the channels
 * and the primary's connection itself, and still lands on the invoice the
 * Receive tab would have shown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReceiveInvoice, JIT_INVOICE_EXPIRY_SECS } from './receive-invoice.js';
import { INBOUND_HEADROOM_SATS } from './lfbw.js';

const PRIMARY = '03' + 'b'.repeat(64);
const HOME = { channelId: 'h'.repeat(64), peerPubkey: PRIMARY, state: 'NORMAL', htlcUsable: true, remoteBalanceSats: 50_000 };
const LFBW = { lfbw: { enabled: true, setup: 'ready', mode: 'external', primaryPubkey: PRIMARY } };

function stubApi({ channels = [HOME], peers = [{ pubkey: PRIMARY, state: 'ready' }] } = {}) {
	const calls = [];
	return {
		calls,
		get: async (path) => {
			calls.push(['GET', path]);
			if (path === '/channels') return channels;
			if (path === '/peers') return peers;
			return null;
		},
		post: async (path, body) => {
			calls.push(['POST', path, body]);
			if (path === '/jit/invoice') return { bolt11: 'lnbc1jit', paymentHash: 'j'.repeat(64), flatFeeSat: 210, feePpm: 1000 };
			return { bolt11: 'lnbc1plain', paymentHash: 'p'.repeat(64) };
		}
	};
}

test('an ordinary wallet gets a plain invoice and nothing else is read', async () => {
	const api = stubApi();
	const r = await createReceiveInvoice({ api, rec: { network: 'mainnet' }, amountSats: 1000, description: 'x' });
	assert.equal(r.invoice.bolt11, 'lnbc1plain');
	assert.equal(r.jit, null);
	assert.deepEqual(api.calls, [['POST', '/invoice/create', { description: 'x', amountSats: 1000 }]]);
});

test('a lightning-first wallet whose channel covers the amount gets a plain invoice', async () => {
	const api = stubApi();
	const r = await createReceiveInvoice({ api, rec: LFBW, amountSats: 40_000, description: 'x' });
	assert.equal(r.invoice.bolt11, 'lnbc1plain');
	assert.ok(api.calls.some(([, p]) => p === '/channels'), 'the channels were read for the decision');
});

test('above what the channel covers, the primary is asked for a just-in-time invoice', async () => {
	const api = stubApi();
	const r = await createReceiveInvoice({ api, rec: LFBW, amountSats: 80_000, description: 'Withdrawal' });
	assert.equal(r.invoice.bolt11, 'lnbc1jit');
	assert.deepEqual(r.jit, { flatFeeSat: 210, feePpm: 1000 });
	const asked = api.calls.find(([, p]) => p === '/jit/invoice');
	assert.deepEqual(asked[2], {
		lspPubkey: PRIMARY,
		amountSats: 80_000,
		description: 'Withdrawal',
		targetRemainingInboundSat: INBOUND_HEADROOM_SATS,
		expirySecs: JIT_INVOICE_EXPIRY_SECS
	});
});

test('a primary that is not connected is refused rather than minted against', async () => {
	const api = stubApi({ peers: [] });
	await assert.rejects(
		createReceiveInvoice({ api, rec: LFBW, amountSats: 80_000, description: 'x' }),
		/primary node is not connected/
	);
	assert.ok(!api.calls.some(([m]) => m === 'POST'), 'no invoice was made');
});

test('an internal primary that is stopped is refused, read through getWallet', async () => {
	const api = stubApi();
	const rec = { lfbw: { ...LFBW.lfbw, mode: 'internal', primaryWalletId: 'w-primary' } };
	await assert.rejects(
		createReceiveInvoice({ api, rec, amountSats: 80_000, description: 'x', getWallet: async () => ({ status: 'stopped' }) }),
		/primary node is not running/
	);
});
