import { useState } from 'react';
import AssetAvatar from '../../../../components/AssetAvatar.jsx';
import { AssetAmount } from '../../../../components/AssetAmount.jsx';
import { Badge, Button, Modal } from '../../../../components/ui.jsx';
import { fmtAsset } from '../../../../lib/asset-amount.js';
import { canClose, channelState, peerName, sharePct } from '../../../../lib/asset-lightning.js';
import { fmtSats, shortId } from '../../../../lib/format.js';

/**
 * The asset channels of a wallet, one block each.
 *
 * A channel funded with an asset is counted in the asset, so every figure
 * here is in its units: what is on each side, what can be sent and received
 * right now, and how much the channel holds in all. The bitcoin the channel
 * also holds is the one figure in sats, and is labelled as that.
 *
 * A list and not a table: six figures a channel do not fit a phone as
 * columns, and a block wraps where a row would scroll sideways.
 */
export default function AssetChannelRows({ channels, onClose }) {
	return (
		<ul className="asset-channel-list" data-testid="asset-channel-list">
			{(channels || []).map((c) => {
				const state = channelState(c.state);
				const alias = typeof c.peerAlias === 'string' && c.peerAlias.trim() ? c.peerAlias.trim() : null;
				return (
					// A channel is known by the id its open was given until the funding
					// transaction gives it its own. The first stays with it, so the row
					// is the same row across that change.
					<li key={c.pendingChannelId || c.channelId} className="asset-channel" data-testid="asset-channel" data-state={c.state}>
						<div className="asset-channel-head">
							<AssetAvatar asset={c.asset} />
							<div className="asset-channel-title">
								<div className="asset-name">{c.asset?.name || 'Asset'}</div>
								<div className="wallet-meta">
									with {alias ? `${alias} · ` : ''}
									<span className="mono" title={c.peerPubkey}>
										{shortId(c.peerPubkey)}
									</span>
								</div>
							</div>
							<Badge tone={state.tone}>{state.word}</Badge>
							{onClose && canClose(c) && (
								<Button className="sm" data-testid="asset-channel-close" onClick={(e) => onClose(c, e)}>
									Close
								</Button>
							)}
						</div>

						<div
							className="balbar asset-channel-bar"
							role="img"
							aria-label={`${fmtAsset(c.localBalance, c.asset)} on your side, ${fmtAsset(c.remoteBalance, c.asset)} on the peer's side`}
						>
							<div className="balbar-local" style={{ width: `${sharePct(c.localBalance, c.remoteBalance)}%` }} />
						</div>
						<div className="asset-channel-sides">
							<span data-testid="asset-channel-local">
								<AssetAmount value={c.localBalance} asset={c.asset} /> <span className="side-word">yours</span>
							</span>
							<span data-testid="asset-channel-remote">
								<span className="side-word">theirs</span> <AssetAmount value={c.remoteBalance} asset={c.asset} />
							</span>
						</div>

						<dl className="asset-channel-facts">
							<div>
								<dt>Can send</dt>
								<dd>
									<AssetAmount value={c.sendable} asset={c.asset} />
								</dd>
							</div>
							<div>
								<dt>Can receive</dt>
								<dd>
									<AssetAmount value={c.receivable} asset={c.asset} />
								</dd>
							</div>
							<div>
								<dt>Capacity</dt>
								<dd>
									<AssetAmount value={c.capacity} asset={c.asset} />
								</dd>
							</div>
							<div>
								<dt>Bitcoin in the channel</dt>
								<dd>{fmtSats(c.channelSats)}</dd>
							</div>
						</dl>
						{state.word === 'opening' && (
							<div className="field-hint">
								Opening. It can carry payments once its funding transaction has confirmed.
							</div>
						)}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * Closing an asset channel.
 *
 * The cooperative close is the one offered. A force close is a second
 * question behind it, asked on a page of its own: it is slower, costs more,
 * and is only for a peer that has stopped answering, so it is never one
 * misplaced press away.
 *
 * `onConfirm(force)` does the close and may reject; the dialog stays open
 * with the reason when it does.
 */
export function CloseAssetChannelModal({ channel, origin, onClose, onConfirm }) {
	const [forcing, setForcing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(null);
	const who = peerName(channel);
	const mine = fmtAsset(channel.localBalance, channel.asset);

	const run = async (force) => {
		setBusy(true);
		setError(null);
		try {
			await onConfirm(force);
		} catch (e) {
			setError(e?.text || e?.message || 'The channel could not be closed.');
			setBusy(false);
		}
	};

	return (
		<Modal title={forcing ? 'Force close asset channel' : 'Close asset channel'} onClose={onClose} origin={origin}>
			<div data-testid="asset-channel-close-dialog" data-step={forcing ? 'force' : 'cooperative'}>
				{!forcing ? (
					<>
						<p className="wallet-meta">
							Close the {channel.asset?.name} channel with {who}? Your side of it, {mine}, comes back to this wallet
							on-chain, along with the bitcoin the channel holds, once the closing transaction confirms.
						</p>
						<p className="wallet-meta">
							After that this wallet can no longer send or receive {channel.asset?.name} over Lightning through this
							peer.
						</p>
					</>
				) : (
					<>
						<div className="error-note" role="alert">
							A force close does not ask the peer. It is for a peer that has stopped answering, and for nothing else.
						</div>
						<p className="wallet-meta">
							Your {mine} and the channel&apos;s bitcoin come back only after the channel&apos;s safety delay, which can
							be days, and the transaction costs more in mining fees than an agreed close. If the peer is reachable,
							go back and close cooperatively.
						</p>
					</>
				)}
				{error && (
					<div className="error-note" role="alert" data-testid="asset-channel-close-error">
						{error}
					</div>
				)}
				<div className="center-actions">
					{!forcing ? (
						<>
							<Button variant="primary" busy={busy} data-testid="asset-channel-close-coop" onClick={() => run(false)}>
								Close cooperatively
							</Button>
							<Button
								variant="danger"
								disabled={busy}
								data-testid="asset-channel-close-force"
								onClick={() => {
									setError(null);
									setForcing(true);
								}}
							>
								Force close…
							</Button>
							<Button onClick={onClose}>Cancel</Button>
						</>
					) : (
						<>
							<Button variant="danger" busy={busy} data-testid="asset-channel-close-force-confirm" onClick={() => run(true)}>
								Force close anyway
							</Button>
							<Button
								disabled={busy}
								data-testid="asset-channel-close-back"
								onClick={() => {
									setError(null);
									setForcing(false);
								}}
							>
								Back
							</Button>
						</>
					)}
				</div>
			</div>
		</Modal>
	);
}
