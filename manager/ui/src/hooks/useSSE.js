import { useEffect, useRef } from 'react';

/**
 * Subscribes to a wallet's SSE event stream. Calls onEvent(name, data) for each
 * named beignet event (payment:*, invoice:settled, channel:*, peer:*,
 * node:ready). Reconnects
 * automatically via the browser's EventSource. The proxy injects the bearer
 * token, so no auth handling is needed here.
 */
export function useSSE(url, onEvent) {
	const handler = useRef(onEvent);
	handler.current = onEvent;

	useEffect(() => {
		if (!url) return () => {};
		if (url.startsWith('demo:')) {
			// Demo mode: the mock event bus stands in for the SSE stream.
			let unsub = () => {};
			let alive = true;
			import('../mock/mockApi.js').then(({ mockEvents }) => {
				if (alive) unsub = mockEvents.subscribe(url.slice(5), (name, data) => handler.current && handler.current(name, data));
			});
			return () => {
				alive = false;
				unsub();
			};
		}
		const names = [
			'payment:received',
			'payment:sent',
			'payment:failed',
			// Fires alongside payment:received when the settled receive is an
			// invoice this wallet issued, carrying the bolt11 and the hash the
			// Receive tab matches its on-screen invoice against.
			'invoice:settled',
			// On-chain arrivals and confirmations (beignet 0.8.2+), carrying the
			// same shape /transactions answers with. Older daemons never send
			// them, and the receive watcher's poll covers the gap.
			'transaction:received',
			'transaction:confirmed',
			'channel:ready',
			'channel:closed',
			'peer:connect',
			'peer:disconnect',
			'node:ready',
			// Channel backup (the Recovery Protocol, beignet 0.9.1+). Named
			// events, so each must be listed or EventSource never delivers it.
			// guardian_unreachable is spelled with an underscore on the wire.
			'recovery:durable',
			'recovery:fenced',
			'recovery:backfill-lost',
			'recovery:guardian_unreachable',
			'recovery:restore-progress',
			'recovery:restored'
		];
		let es;
		try {
			es = new EventSource(url);
		} catch (_) {
			return () => {};
		}
		const listeners = names.map((name) => {
			const fn = (ev) => {
				let data = null;
				try {
					data = ev.data ? JSON.parse(ev.data) : null;
				} catch (_) {
					/* ignore */
				}
				handler.current && handler.current(name, data);
			};
			es.addEventListener(name, fn);
			return [name, fn];
		});
		return () => {
			listeners.forEach(([name, fn]) => es.removeEventListener(name, fn));
			es.close();
		};
	}, [url]);
}
