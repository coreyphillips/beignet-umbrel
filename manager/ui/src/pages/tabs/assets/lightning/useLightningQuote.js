import { useCallback, useEffect, useRef, useState } from 'react';

// A beat after the inputs stop moving, as the other quotes wait.
export const QUOTE_DELAY_MS = 250;

const EMPTY = { quote: null, error: null, pending: false, at: 0 };

/**
 * A price from the channel peer, asked for once what it is for has settled.
 *
 * Unlike a fee, a price is for one asset and one amount and holds for
 * seconds, so the manners differ from useAssetQuote in two ways. The price
 * on screen is dropped the moment what it is for changes: a figure for
 * another asset is not an old figure, it is a wrong one. And it is never
 * asked for again unprompted: when it runs out the page says so and the
 * reader asks, so the peer is not polled by a tab left open.
 *
 * `scope` is a string naming what the price is for, or null for nothing to
 * price. `ask()` returns the quote.
 *
 * Returns { quote, error, pending, at, renew, replace }. `at` is when the
 * quote arrived, which is what a countdown measures its bar against. `renew`
 * asks again at once, and `replace` puts a quote the wallet handed back
 * (with a changed price) in the place of the one on screen.
 */
export function useLightningQuote(ask, scope) {
	const [state, setState] = useState(EMPTY);
	const [round, setRound] = useState(0);
	const seq = useRef(0);
	const lastRound = useRef(0);
	const asker = useRef(ask);
	asker.current = ask;

	useEffect(() => {
		const mine = ++seq.current;
		if (scope === null || scope === undefined) {
			setState(EMPTY);
			return () => {};
		}
		// Asking again is a press, not typing, so it does not wait.
		const renewing = round !== lastRound.current;
		lastRound.current = round;
		setState({ quote: null, error: null, pending: true, at: 0 });
		const timer = setTimeout(
			async () => {
				try {
					const quote = await asker.current();
					if (seq.current === mine) setState({ quote, error: null, pending: false, at: Date.now() });
				} catch (error) {
					if (seq.current === mine) setState({ quote: null, error, pending: false, at: 0 });
				}
			},
			renewing ? 0 : QUOTE_DELAY_MS
		);
		return () => clearTimeout(timer);
	}, [scope, round]);

	useEffect(
		() => () => {
			seq.current += 1;
		},
		[]
	);

	const renew = useCallback(() => setRound((n) => n + 1), []);
	const replace = useCallback((quote) => {
		seq.current += 1;
		setState({ quote, error: null, pending: false, at: Date.now() });
	}, []);

	return { ...state, renew, replace };
}
