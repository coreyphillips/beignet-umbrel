import { useCallback, useEffect, useRef } from 'react';
import { fmtSats } from '../lib/format.js';

// The safety net's cadence. The SSE stream announces a receive the moment it
// happens; this poll exists for the stream being dead without anyone knowing
// (a proxy that gave up on the idle connection, a laptop that slept through
// the retry, a tab restored from the cache), so it only has to be frequent
// enough that a missed receive still surfaces while its recipient is looking
// at the screen.
const POLL_MS = 10000;

/**
 * Watches a wallet for money arriving, on either rail, and reports each
 * receive exactly once.
 *
 * Two sources feed it. The SSE stream is handed in through the returned
 * `onEvent` by whoever owns the wallet's EventSource, and is instant when it
 * is alive. The hook's own poll of /payments and /transactions is slow but
 * cannot miss: a receive is a fact in those lists whether or not any event
 * about it was delivered. The two are reconciled by payment hash and txid, so
 * a receive the stream already announced is not announced again when the poll
 * finds it.
 *
 * Everything present at each source's first successful read is baseline:
 * history, not news. A payment seen as PENDING is remembered as pending, so a
 * hold invoice settling while someone watches is still news when it completes.
 *
 * `onReceive` is handed { rail: 'lightning' | 'onchain', amountSats,
 * paymentHash?, txid?, pending? }.
 */
export function useReceiveWatch(api, enabled, onReceive, intervalMs = POLL_MS) {
	const onReceiveRef = useRef(onReceive);
	onReceiveRef.current = onReceive;
	// The live event handler. Kept in a ref so the returned `onEvent` is stable
	// while the watcher's state (the seen sets) is remade whenever the wallet
	// changes: events for the old wallet must not mark hashes seen for the new.
	const handlerRef = useRef(() => {});

	useEffect(() => {
		handlerRef.current = () => {};
		if (!enabled || !api) return () => {};
		let alive = true;
		// paymentHash -> last status seen. A hash marked COMPLETED has been
		// announced (or was already settled at baseline) and never speaks again.
		const lnSeen = new Map();
		const txSeen = new Set();
		// Baseline is per source: /payments can answer while /transactions is
		// still failing, and one shared flag would then report every historical
		// transaction as news the moment the second source recovers.
		let lnBaselined = false;
		let txBaselined = false;

		const notify = (receive) => {
			if (alive) onReceiveRef.current?.(receive);
		};

		handlerRef.current = (name, data) => {
			if (name !== 'payment:received' && name !== 'invoice:settled') return;
			// Both events fire for a settled invoice, and the poll will list the
			// same payment shortly after either. The hash is what ties the three
			// tellings together as one receive.
			const hash = data?.paymentHash ?? null;
			if (hash) {
				if (lnSeen.get(hash) === 'COMPLETED') return;
				lnSeen.set(hash, 'COMPLETED');
			}
			notify({
				rail: 'lightning',
				amountSats: data?.amountSats ?? null,
				paymentHash: hash
			});
		};

		let inFlight = false;
		const sweep = async () => {
			if (inFlight) return;
			inFlight = true;
			let payments = null;
			let txs = null;
			try {
				payments = await api.get('/payments');
			} catch (_) {
				/* the next sweep asks again */
			}
			try {
				txs = await api.get('/transactions');
			} catch (_) {
				/* the next sweep asks again */
			}
			inFlight = false;
			if (!alive) return;
			const fresh = [];
			if (Array.isArray(payments)) {
				for (const p of payments) {
					if (p.direction !== 'INCOMING' || !p.paymentHash) continue;
					const prev = lnSeen.get(p.paymentHash);
					lnSeen.set(p.paymentHash, p.status);
					if (!lnBaselined) continue;
					if (p.status === 'COMPLETED' && prev !== 'COMPLETED') {
						fresh.push({
							rail: 'lightning',
							amountSats: p.amountSats ?? null,
							paymentHash: p.paymentHash
						});
					}
				}
				lnBaselined = true;
			}
			if (Array.isArray(txs)) {
				for (const t of txs) {
					if (t.type !== 'received' || !t.txid) continue;
					const isNew = !txSeen.has(t.txid);
					txSeen.add(t.txid);
					if (txBaselined && isNew) {
						fresh.push({
							rail: 'onchain',
							amountSats: Math.abs(t.valueSats ?? 0) || null,
							txid: t.txid,
							pending: !t.confirmed
						});
					}
				}
				txBaselined = true;
			}
			fresh.forEach(notify);
		};

		sweep();
		const timer = setInterval(sweep, intervalMs);
		return () => {
			alive = false;
			handlerRef.current = () => {};
			clearInterval(timer);
		};
	}, [api, enabled, intervalMs]);

	const onEvent = useCallback((name, data) => handlerRef.current(name, data), []);
	return { onEvent };
}

/** The words a receive is announced with, wherever it is announced. */
export function describeReceive(receive, walletName) {
	const who = walletName ? `${walletName} received` : 'Received';
	const amount = receive.amountSats != null ? ` ${fmtSats(receive.amountSats)}` : ' a payment';
	if (receive.rail === 'onchain') {
		return `${who}${amount} on-chain${receive.pending ? ', waiting for a block' : ''}`;
	}
	return `${who}${amount} over Lightning`;
}
