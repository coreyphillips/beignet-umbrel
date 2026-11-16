import AssetAvatar from '../../../components/AssetAvatar.jsx';
import { Button } from '../../../components/ui.jsx';
import { sentence } from '../../../lib/assets.js';

/**
 * The Assets tab when the wallet's assets host cannot answer: not started,
 * still starting, or being restarted with the wallet.
 *
 * One card in the place of the views, and nothing else: no toast, no spinner,
 * no row of warnings above it. What it says first is the thing a person
 * holding bitcoin in this wallet needs to hear, which is that the bitcoin is
 * not part of this.
 *
 * `state` is what lib/assets.js hostState() returned.
 */
export default function HostNotice({ state, go, onSettings }) {
	if (state.kind === 'unavailable') {
		return (
			<div className="card asset-notice" role="status" data-testid="assets-unavailable">
				<AssetAvatar size="lg" />
				<h3 className="asset-notice-title">Assets are unavailable on this wallet right now</h3>
				<p className="asset-notice-body">
					The bitcoin wallet is unaffected: its balance and payments work as they did. Assets this wallet holds have not
					moved. They cannot be shown or sent until assets start again.
				</p>
				<dl className="asset-notice-reason">
					<dt>Reason</dt>
					<dd data-testid="assets-unavailable-reason">{state.reason ? sentence(state.reason) : 'The wallet gave no reason.'}</dd>
				</dl>
				<p className="asset-notice-foot">
					Assets start with the wallet, so restarting the wallet tries again. The Logs tab has the detail.
				</p>
				{(go || onSettings) && (
					<div className="center-actions asset-notice-actions">
						{go && (
							<Button className="sm" data-testid="assets-unavailable-logs" onClick={() => go('logs')}>
								Open Logs tab
							</Button>
						)}
						{onSettings && (
							<Button className="sm" data-testid="assets-unavailable-settings" onClick={onSettings}>
								Proof server settings
							</Button>
						)}
					</div>
				)}
			</div>
		);
	}

	if (state.kind === 'restarting') {
		return (
			<div className="card asset-notice waiting" role="status" data-testid="assets-restarting">
				<AssetAvatar size="lg" />
				<h3 className="asset-notice-title">The wallet is restarting</h3>
				<p className="asset-notice-body">Assets will be back in a moment. There is nothing to do here: this page carries on by itself.</p>
			</div>
		);
	}

	const counted = state.total > 0;
	return (
		<div className="card asset-notice waiting" role="status" data-testid="assets-starting">
			<AssetAvatar size="lg" />
			<h3 className="asset-notice-title">Assets are starting</h3>
			<p className="asset-notice-body">
				The wallet is checking its proofs{counted ? ` (${state.done} of ${state.total})` : ''}. This takes a moment after the
				wallet starts, and this page carries on by itself.
			</p>
			{counted && (
				<div className="asset-notice-bar" aria-hidden="true">
					<span style={{ width: `${Math.round((state.done / state.total) * 100)}%` }} />
				</div>
			)}
		</div>
	);
}
