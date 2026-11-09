import { INBOUND_HEADROOM_SATS, planInvoice } from './lfbw.js';

// A JIT invoice's lifetime, and with it the intent the primary holds open.
// The primary holds an intent open for as long as the invoice lives and
// allows a few per wallet, so an unpaid invoice must not hold its slot for an
// hour (beignet #674).
export const JIT_INVOICE_EXPIRY_SECS = 15 * 60;

/** A peer the daemon reports as up, in any of the shapes its versions use. */
export function isConnectedPeer(p) {
	return p.state === 'connected' || p.state === 'ready' || p.connected === true;
}

/**
 * A Lightning invoice made the way the Receive tab makes one: a plain invoice,
 * or for a lightning-first wallet whose home channel cannot take the amount,
 * a just-in-time one the primary provides the capacity for. The one place the
 * choice is made, so an LNURL withdrawal gets the invoice the Receive tab
 * would have shown.
 *
 * `primaryConnected` is read from /peers when the caller has not already.
 * `getWallet` looks up a sibling wallet (manager.getWallet), for an internal
 * primary's running state. Returns `{ invoice, jit }`, `jit` being the fee
 * the primary quoted or null.
 */
export async function createReceiveInvoice({ api, rec, channels, primaryConnected, amountSats, description, getWallet }) {
	const body = { description };
	if (amountSats) body.amountSats = amountSats;
	const lf = rec?.lfbw;
	if (lf?.enabled) {
		// Provision inbound first when the home channel cannot take the
		// amount: the invoice is payable through a channel the primary funds
		// the moment the payment arrives (a zero-conf open, or a splice of the
		// home channel), minus the fee it quotes.
		let primaryRunning = true;
		if (lf.mode === 'internal' && lf.primaryWalletId && getWallet) {
			primaryRunning = await getWallet(lf.primaryWalletId)
				.then((w) => w.status === 'running')
				.catch(() => true);
		}
		let connected = primaryConnected;
		if (connected === undefined) {
			const peers = await api.get('/peers').catch(() => null);
			connected = !peers || peers.filter(isConnectedPeer).some((p) => p.pubkey === lf.primaryPubkey);
		}
		const decided = planInvoice({
			wantedSats: body.amountSats || 0,
			channels: channels || (await api.get('/channels').catch(() => [])),
			primaryPubkey: lf.primaryPubkey,
			setup: lf.setup,
			primaryRunning,
			primaryConnected: connected
		});
		if (decided.kind === 'refuse') {
			throw new Error(
				decided.code === 'PRIMARY_DOWN'
					? decided.reason === 'not-connected'
						? 'Your primary node is not connected, and this invoice needs it to provide inbound capacity. Wait for it to reconnect, or ask for an amount the channel already covers.'
						: 'Your primary node is not running, and this invoice needs it to provide inbound capacity. Start it, or ask for an amount the channel already covers.'
					: 'The link to your primary node is not set up yet. Retry setup from the Overview tab.'
			);
		}
		if (decided.kind === 'jit') {
			const r = await api.post('/jit/invoice', {
				lspPubkey: lf.primaryPubkey,
				...(body.amountSats ? { amountSats: body.amountSats } : {}),
				description: body.description,
				targetRemainingInboundSat: INBOUND_HEADROOM_SATS,
				expirySecs: JIT_INVOICE_EXPIRY_SECS
			});
			return { invoice: r, jit: { flatFeeSat: r.flatFeeSat || 0, feePpm: r.feePpm || 0 } };
		}
	}
	return { invoice: await api.post('/invoice/create', body), jit: null };
}
