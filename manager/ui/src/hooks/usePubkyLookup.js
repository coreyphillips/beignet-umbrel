import { useEffect, useRef, useState } from 'react';
import { manager } from '../api.js';
import { requestFromEndpoints, shortPubky } from '../lib/paykit.js';

/**
 * Look up a pubky's published payment details through the manager and read
 * them as one request this wallet can pay (lib/paykit.js). Only the newest
 * lookup's answer is kept. `pubky` null clears it.
 *
 * Returns `{ looking, request, error, pubky, who }`: `request` is
 * `{ text, address, lightning, funding }`, and `who` the pubky shortened
 * for a sentence.
 */
export function usePubkyLookup(id, pubky, network) {
	const [state, setState] = useState({ looking: false, request: null, error: null, pubky: null });
	const latest = useRef(0);
	useEffect(() => {
		const seq = ++latest.current;
		if (!pubky) {
			setState({ looking: false, request: null, error: null, pubky: null });
			return;
		}
		setState({ looking: true, request: null, error: null, pubky });
		manager
			.paykitLookup(id, pubky)
			.then((r) => {
				if (seq !== latest.current) return;
				setState({ looking: false, request: requestFromEndpoints(r.endpoints, { network }), error: null, pubky });
			})
			.catch((e) => {
				if (seq !== latest.current) return;
				setState({ looking: false, request: null, error: e.message, pubky });
			});
	}, [id, pubky, network]);
	return { ...state, who: shortPubky(state.pubky) };
}
