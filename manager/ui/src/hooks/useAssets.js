import { useEffect, useMemo, useRef, useState } from 'react';
import { usePoll } from './usePoll.js';
import { assetsApi } from '../lib/assets-api.js';
import { isPending } from '../lib/asset-progress.js';

// How often each read is asked again with nothing prompting it. Every event
// on the wallet's stream re-asks at once (the `tick`), so these are the floor
// for a stream that has gone quiet, not the pace of the page.
const SUMMARY_MS = 10000;
const HOLDINGS_MS = 10000;
const ACTIVITY_BUSY_MS = 4000;
const ACTIVITY_IDLE_MS = 15000;

/** The assets routes for a wallet api, the same object between renders. */
export function useAssetsApi(api) {
	return useMemo(() => assetsApi(api), [api]);
}

/**
 * The summary the wallet page keeps for every tab: whether assets are up,
 * what is in progress, the proof server and the backup.
 *
 * `enabled` is false while the app has no assets host or the wallet is not
 * running, and then nothing is asked. A failure keeps the last answer: a
 * figure that is ten seconds old is better than a blank.
 */
export function useAssetSummary(api, enabled, tick) {
	const assets = useAssetsApi(api);
	const { data, error, loading } = usePoll(() => (enabled ? assets.status() : Promise.resolve(null)), SUMMARY_MS, [
		assets,
		enabled,
		tick
	]);
	return { status: enabled ? data : null, error: enabled ? error : null, loading: enabled && loading && !data };
}

/** What the wallet holds: { assets, btc }. */
export function useAssetBalances(api, tick, enabled = true) {
	const assets = useAssetsApi(api);
	const { data, error, loading, refresh } = usePoll(() => (enabled ? assets.balances() : Promise.resolve(null)), HOLDINGS_MS, [
		assets,
		enabled,
		tick
	]);
	return { balances: data, holdings: data?.assets || null, btc: data?.btc || null, error, loading: loading && !data, refresh };
}

/**
 * Asset activity, asked more often while something in it is still moving.
 *
 * A mint six confirmations from done should not sit on a fifteen second poll
 * when the event that would have refreshed it was missed, and a wallet with
 * nothing in flight should not be asked every four.
 */
export function useAssetActivity(api, tick, params, enabled = true) {
	const assets = useAssetsApi(api);
	const [busy, setBusy] = useState(false);
	const paramKey = JSON.stringify(params || {});
	const { data, error, loading, refresh } = usePoll(
		() => (enabled ? assets.activity(params) : Promise.resolve(null)),
		busy ? ACTIVITY_BUSY_MS : ACTIVITY_IDLE_MS,
		[assets, enabled, tick, paramKey]
	);
	const rows = data?.rows || null;
	const moving = !!rows && rows.some(isPending);
	useEffect(() => {
		setBusy(moving);
	}, [moving]);
	return { rows, nextBefore: data?.nextBefore ?? null, error, loading: loading && !data, refresh };
}

/** One asset in full, for its detail view. `missing` when the wallet does not hold it. */
export function useAssetDetail(api, key, tick) {
	const assets = useAssetsApi(api);
	const { data, error, loading } = usePoll(() => (key ? assets.asset(key) : Promise.resolve(null)), HOLDINGS_MS, [
		assets,
		key,
		tick
	]);
	const missing = !!error && (error.code === 'ASSET_NOT_FOUND' || error.status === 404);
	// A different asset's detail must not be shown under this one's key while
	// the new one loads.
	const fresh = data && (data.key === key || data.assetId === key || data.groupKey === key) ? data : null;
	return { asset: fresh, missing, error: missing ? null : error, loading: loading && !fresh };
}

/**
 * One row, kept current: the copy in hand, replaced by the same row from the
 * activity list or from an event whenever a newer one arrives.
 */
export function useLiveRow(initial, rows) {
	const [row, setRow] = useState(initial || null);
	const id = initial?.id || row?.id || null;
	const last = useRef(null);
	useEffect(() => {
		if (initial && initial.id !== last.current) {
			last.current = initial.id;
			setRow(initial);
		}
		if (!initial) {
			last.current = null;
			setRow(null);
		}
	}, [initial]);
	useEffect(() => {
		if (!id || !rows) return;
		const found = rows.find((r) => r.id === id);
		if (found) setRow(found);
	}, [id, rows]);
	return row;
}

const QUOTE_DELAY_MS = 250;

/**
 * Ask the wallet what something will cost, once the inputs have settled.
 *
 * The same manners as useQuote (a short wait, only the newest answer counts,
 * the last good answer stays on screen while the next is fetched), for a
 * question asked through lib/assets-api.js instead of by path.
 *
 * Returns { quote, error, pending }.
 */
export function useAssetQuote(ask, params, enabled = true) {
	const [state, setState] = useState({ quote: null, error: null, pending: false });
	const latest = useRef(0);
	const asker = useRef(ask);
	asker.current = ask;
	const key = enabled ? JSON.stringify(params) : null;
	useEffect(() => {
		const mine = ++latest.current;
		if (key === null) {
			setState({ quote: null, error: null, pending: false });
			return () => {};
		}
		setState((s) => ({ ...s, pending: true }));
		const timer = setTimeout(async () => {
			try {
				const quote = await asker.current(JSON.parse(key));
				if (latest.current === mine) setState({ quote, error: null, pending: false });
			} catch (error) {
				if (latest.current === mine) setState((s) => ({ quote: s.quote, error, pending: false }));
			}
		}, QUOTE_DELAY_MS);
		return () => clearTimeout(timer);
	}, [key]);
	return state;
}
