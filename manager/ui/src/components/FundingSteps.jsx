import { useEffect, useState } from 'react';
import { manager } from '../api.js';
import { describeStep, stepOffset, stepsFinished } from '../lib/direct-funding.js';

/**
 * A direct funding's steps with their times: the routes tried and skipped, the
 * offer, the signature, the receipt. A slow or refused payment says where its
 * time went on the payment itself, instead of in a log nobody opens (umbrel #147).
 */
export function FundingSteps({ steps }) {
	if (!Array.isArray(steps) || steps.length === 0) return null;
	return (
		<div style={{ marginTop: 8 }}>
			<div className="field-hint">Direct funding steps</div>
			<ol aria-label="Direct funding steps" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
				{steps.map((step, i) => {
					const offset = stepOffset(step, steps);
					return (
						<li key={`${step.timestamp}-${step.action}-${i}`} className="wallet-meta">
							<span className="mono">{new Date(step.timestamp).toLocaleTimeString()}</span>
							{offset && <span className="mono"> {offset}</span>} {describeStep(step)}
						</li>
					);
				})}
			</ol>
		</div>
	);
}

// Asked this often while the attempt is still going. An attempt whose end never
// shows (a daemon printing nothing, a receipt that never came) stops being asked
// about after GIVE_UP_MS, which outlasts the offer and receipt windows.
const POLL_MS = 3000;
const GIVE_UP_MS = 5 * 60_000;

/** The steps of the latest attempt to pay one request, kept current while it runs. */
export function LiveFundingSteps({ walletId, requestId }) {
	const [steps, setSteps] = useState(null);
	useEffect(() => {
		let alive = true;
		let timer = null;
		const began = Date.now();
		const ask = async () => {
			const got = await manager.directFundingSteps(walletId, requestId).catch(() => null);
			if (!alive) return;
			if (Array.isArray(got)) setSteps(got);
			if (stepsFinished(got) || Date.now() - began > GIVE_UP_MS) return;
			timer = setTimeout(ask, POLL_MS);
		};
		ask();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, [walletId, requestId]);
	return <FundingSteps steps={steps} />;
}
