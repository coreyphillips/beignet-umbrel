import { useEffect, useState } from 'react';
import { tooShortToJudge } from '../lib/payment-uri.js';

// The same beat the decode waits, so the refusal and the reading that follows it
// are paced together rather than one racing ahead of the other.
export const REFUSAL_HOLD_MS = 300;

/**
 * May a refusal about this string be shown yet?
 *
 * A structural refusal is the harshest thing a send form says, and while someone
 * is still writing it is usually wrong. The decode that follows a refusal is
 * debounced; the refusal was not, so the box turned red at around twenty five
 * characters of a typed invoice, with the caret still in it, advising the reader
 * to "copy the whole of it again" for something they were typing by hand. Anyone
 * dictating an address, or pasting one in two pieces, got the same.
 *
 * So: held for the same beat as the decode, and suppressed outright while the
 * field has focus and the string is still shorter than a complete one of its
 * kind. Leaving the field shows it at once, since a finished string that cannot
 * be read is exactly what a refusal is for.
 */
export function useSettledRefusal(value, focused) {
	const [settled, setSettled] = useState(value);

	useEffect(() => {
		// Not being typed into: whatever is in there is finished, and waiting would
		// only delay the answer.
		if (!focused) {
			setSettled(value);
			return () => {};
		}
		const timer = setTimeout(() => setSettled(value), REFUSAL_HOLD_MS);
		return () => clearTimeout(timer);
	}, [value, focused]);

	if (settled !== value) return false;
	return !(focused && tooShortToJudge(value));
}
