import { useEffect, useRef } from 'react';

/**
 * Subscribes to a wallet's SSE event stream. Calls onEvent(name, data) for each
 * named beignet event (payment:*, channel:*, peer:*, node:ready). Reconnects
 * automatically via the browser's EventSource. The proxy injects the bearer
 * token, so no auth handling is needed here.
 */
export function useSSE(url, onEvent) {
	const handler = useRef(onEvent);
	handler.current = onEvent;

	useEffect(() => {
		if (!url) return () => {};
		const names = [
			'payment:received',
			'payment:sent',
			'payment:failed',
			'channel:ready',
			'channel:closed',
			'peer:connect',
			'peer:disconnect',
			'node:ready'
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
