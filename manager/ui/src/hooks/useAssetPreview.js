import { useCallback, useEffect, useRef, useState } from 'react';
import { idempotencyKey } from '../lib/assets-api.js';

// Longer than a quote's debounce: a preview makes the wallet build a real
// transaction, so it waits until the fee slider has come to rest.
export const PREVIEW_DELAY_MS = 600;
// A preview is asked for again this long before it would expire, so the one
// on screen is never one the wallet has stopped honouring.
const RENEW_BEFORE_MS = 8000;

const EMPTY = { preview: null, error: null, pending: false };

/**
 * A prepared send or burn, kept current.
 *
 * Sending an asset is two steps on the wallet's side: prepare, which builds
 * the transaction and says exactly what it costs, and commit, which
 * broadcasts that same transaction. This hook holds the prepared one for a
 * form: asked for once the inputs settle, asked for again quietly before it
 * expires, and cancelled when the form is cleared or put away, so the wallet
 * is not left holding coins for a transaction nobody will send.
 *
 * `params` is what to prepare, `scope` the part of it that says what the
 * preview is about (the address, or the asset and amount). While only the
 * fee changes the last preview stays on screen until the new one lands;
 * when the scope changes it is dropped at once, because a preview for another
 * address is not a stale figure, it is a wrong one.
 *
 * Returns { preview, error, pending, refresh, consume }. `consume` is called
 * after a commit, so the preview that was just spent is not cancelled.
 */
export function useAssetPreview({ prepare, cancel, params, scope, enabled }) {
	const [state, setState] = useState(EMPTY);
	const [renewal, setRenewal] = useState(0);
	const seq = useRef(0);
	const open = useRef(null);
	const lastScope = useRef(null);
	const lastRenewal = useRef(0);
	const fns = useRef({ prepare, cancel });
	fns.current = { prepare, cancel };
	const key = enabled ? JSON.stringify(params) : null;

	const drop = useCallback(() => {
		const id = open.current;
		open.current = null;
		if (id) Promise.resolve(fns.current.cancel(id)).catch(() => {});
	}, []);

	useEffect(() => {
		if (key === null) {
			seq.current += 1;
			drop();
			lastScope.current = null;
			setState(EMPTY);
			return () => {};
		}
		const mine = ++seq.current;
		const sameScope = lastScope.current === scope;
		lastScope.current = scope;
		// A renewal is not an edit: nothing changed, so it does not wait.
		const renewing = renewal !== lastRenewal.current;
		lastRenewal.current = renewal;
		setState((s) => (sameScope ? { ...s, pending: true } : { preview: null, error: null, pending: true }));
		const timer = setTimeout(
			async () => {
				try {
					const preview = await fns.current.prepare(JSON.parse(key), idempotencyKey());
					if (seq.current !== mine) return;
					open.current = preview.previewId;
					setState({ preview, error: null, pending: false });
				} catch (error) {
					if (seq.current !== mine) return;
					open.current = null;
					setState({ preview: null, error, pending: false });
				}
			},
			renewing ? 0 : PREVIEW_DELAY_MS
		);
		return () => clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key, scope, renewal]);

	const expiresAt = state.preview?.expiresAt;
	useEffect(() => {
		if (!expiresAt) return () => {};
		const wait = Math.max(1000, expiresAt - Date.now() - RENEW_BEFORE_MS);
		const timer = setTimeout(() => setRenewal((n) => n + 1), wait);
		return () => clearTimeout(timer);
	}, [expiresAt]);

	useEffect(
		() => () => {
			seq.current += 1;
			drop();
		},
		[drop]
	);

	return {
		...state,
		refresh: () => setRenewal((n) => n + 1),
		consume: () => {
			open.current = null;
		}
	};
}
