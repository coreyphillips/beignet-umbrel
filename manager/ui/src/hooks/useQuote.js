import { useEffect, useRef, useState } from 'react';

// Typing an amount or dragging a slider changes the quote on every keystroke and
// every pixel. Wait for the hand to settle before asking.
const DEBOUNCE_MS = 250;

/**
 * Ask the wallet what a transaction will cost.
 *
 * The fee depends on which UTXOs coin selection picks, on their script types,
 * and on whether change is needed. None of that is knowable from here, so it is
 * not guessed at: the daemon prices the transaction with the same coin selection
 * a send would run, and answers with the fee it will actually pay.
 *
 * Re-quoted whenever the amount, the rate or the mode changes, so it stays true
 * even if the wallet is set to select coins in a way that makes the fee depend
 * on the amount.
 *
 * Returns { quote, error, pending }. `quote` is the last good answer, kept while
 * a new one is in flight so the figures on screen do not flicker to nothing.
 */
export function useQuote(api, params, enabled = true) {
	const [quote, setQuote] = useState(null);
	const [error, setError] = useState(null);
	const [pending, setPending] = useState(false);
	// Only the newest request may write its answer: a slow one must not overwrite
	// a fresher one that landed first.
	const latest = useRef(0);
	const key = JSON.stringify(params);

	useEffect(() => {
		if (!enabled) {
			setQuote(null);
			setError(null);
			return () => {};
		}
		const id = ++latest.current;
		setPending(true);
		const timer = setTimeout(() => {
			api
				.post('/tx/quote', JSON.parse(key))
				.then((res) => {
					if (id !== latest.current) return;
					setQuote(res);
					setError(null);
				})
				.catch((e) => {
					if (id !== latest.current) return;
					// Keep the previous figures rather than blanking them: a rate the
					// balance cannot cover is a normal thing to type on the way to one
					// it can.
					setError(e.message);
				})
				.finally(() => {
					if (id === latest.current) setPending(false);
				});
		}, DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [api, key, enabled]);

	return { quote, error, pending };
}
