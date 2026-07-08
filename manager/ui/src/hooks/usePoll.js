import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Polls an async fetcher on an interval, with manual refresh and loading/error
 * state. `deps` re-creates the fetcher when they change.
 */
export function usePoll(fetcher, intervalMs, deps = []) {
	const [data, setData] = useState(null);
	const [error, setError] = useState(null);
	const [loading, setLoading] = useState(true);
	const savedFetcher = useRef(fetcher);
	savedFetcher.current = fetcher;

	const refresh = useCallback(async () => {
		try {
			const result = await savedFetcher.current();
			setData(result);
			setError(null);
		} catch (err) {
			setError(err);
		} finally {
			setLoading(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, deps);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		refresh();
		if (!intervalMs) return () => {};
		const t = setInterval(() => {
			if (alive) refresh();
		}, intervalMs);
		return () => {
			alive = false;
			clearInterval(t);
		};
	}, [refresh, intervalMs]);

	return { data, error, loading, refresh };
}
