// Use a disposable regtest manager. Exercises the ordinary dashboard endpoints.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, w, waitFor, fund, healthy } from './lib.mjs';
import { openSiblingChannel } from './ffor-round.mjs';
const config = await api('/config');
assert.equal(config.offlineReceiveAvailable, true, 'Install the companion automatic receive daemon API');
const mk = async (name, extra = {}) =>
	(await api('/wallets', { method: 'POST', body: { name, network: 'regtest', ...extra } })).record;
const P = await mk('Automatic receive primary', {
	ffor: {
		settle: { enabled: true },
		funding: { enabled: true, maxChannels: 5, maxChannelsPerPeer: 3, maxChannelSats: 500000, maxTotalSats: 2000000 }
	}
});
const X = await mk('Automatic receive payer');
try {
	await Promise.all([healthy(P.id), healthy(X.id)]);
	await fund(P.id, 5000000);
	await fund(X.id, 3000000);
	await waitFor(
		'primary and payer funded',
		async () => (await w(P.id, '/balance')).onchain >= 5000000 && (await w(X.id, '/balance')).onchain >= 3000000
	);
	const R = await mk('Automatic receiving wallet', {
		lfbw: { enabled: true, primaryWalletId: P.id, initialChannelSats: 0 }
	});
	try {
		await healthy(R.id);
		await waitFor('LFBW link ready', async () => (await api(`/wallets/${R.id}`)).lfbw.setup === 'ready');
		const primary = (await api(`/wallets/${P.id}`)).nodeId;
		await openSiblingChannel(X.id, P.id, 500000);
		const quote = await w(R.id, `/receive/quote?peer=${primary}&amountSats=20000`);
		const body = {
			peer: primary,
			amountSats: 20000,
			description: 'Automatic offline receive',
			requestId: randomUUID(),
			quote
		};
		const invoice = await w(R.id, '/receive/invoice', { method: 'POST', body });
		assert.equal(invoice.offlineReceive, true);
		assert.equal(invoice.amountSats, 20000);
		assert.equal((await w(R.id, '/receive/invoice', { method: 'POST', body })).bolt11, invoice.bolt11);
		await api(`/wallets/${R.id}/stop`, { method: 'POST' });
		await api(`/wallets/${R.id}/start`, { method: 'POST' });
		await healthy(R.id);
		await waitFor('unpaid request stays active after reopening', async () =>
			(await w(R.id, '/ffor/epochs')).some((e) => e.role === 'R' && e.state === 'ACTIVE')
		);
		await api(`/wallets/${R.id}/stop`, { method: 'POST' });
		const paid = await w(X.id, '/invoice/pay-safe', { method: 'POST', body: { bolt11: invoice.bolt11 } });
		assert.equal(paid.status, 'COMPLETED', JSON.stringify(paid));
		console.log('PASS payer completed with receiver daemon stopped');
		await api(`/wallets/${R.id}/start`, { method: 'POST' });
		await healthy(R.id);
		await waitFor('payment automatically credited', async () =>
			(await w(R.id, '/invoices')).some((i) => i.paymentHash === invoice.paymentHash && i.status === 'PAID')
		);
		const balance = await w(R.id, '/balance');
		assert.equal(balance.lightning, 20000);
		await api(`/wallets/${R.id}/stop`, { method: 'POST' });
		await api(`/wallets/${R.id}/start`, { method: 'POST' });
		await healthy(R.id);
		assert.equal((await w(R.id, '/balance')).lightning, 20000);
		assert.equal(
			(await w(R.id, '/invoices')).filter((i) => i.paymentHash === invoice.paymentHash && i.status === 'PAID').length,
			1
		);
		console.log('PASS unpaid preservation, idempotent creation, offline credit and duplicate-free restart');
	} finally {
		await api(`/wallets/${R.id}/stop`, { method: 'POST' });
	}
} finally {
	await api(`/wallets/${P.id}/stop`, { method: 'POST' });
	await api(`/wallets/${X.id}/stop`, { method: 'POST' });
}
