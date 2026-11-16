import { useEffect, useState } from 'react';
import { useToast } from '../../../../components/Toast.jsx';
import { Button, Card, Empty, Skeleton } from '../../../../components/ui.jsx';
import { useAssetsApi } from '../../../../hooks/useAssets.js';
import { usePoll } from '../../../../hooks/usePoll.js';
import { lightningRefusal } from '../../../../lib/asset-lightning.js';
import AssetChannelRows, { CloseAssetChannelModal } from './AssetChannelRows.jsx';
import OpenAssetChannelModal from './OpenAssetChannelModal.jsx';

const clickOrigin = (e) => (e && typeof e.clientX === 'number' ? { x: e.clientX, y: e.clientY } : null);

/**
 * The asset channels of a wallet, on its Channels tab: the list, opening
 * one, and closing one.
 *
 * Mounted only for a wallet that is offered asset channels
 * (assetChannelsOffered in lib/asset-lightning.js), so a wallet that is not
 * never asks for the list and never sees the card.
 *
 * An asset's own page sends its "Open channel" button here with the asset
 * in hand (`route.state.openAsset`), and the dialog opens on that asset.
 */
export default function AssetChannelsCard({ id, api, tick, bump, route, go }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const [modal, setModal] = useState(null);
	const { data, error, refresh } = usePoll(() => assets.channels(), 8000, [assets, tick]);
	const channels = data?.channels || null;

	const wanted = route?.state?.openAsset || null;
	useEffect(() => {
		if (!wanted) return;
		setModal({ type: 'open', assetKey: wanted, origin: null });
		// The request is spent. Without this, coming back to the tab, or
		// reloading it, would open the dialog again.
		if (go) go('channels', { replace: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [wanted]);

	const changed = () => {
		refresh();
		if (bump) bump();
	};

	const close = async (channel, force) => {
		try {
			await assets.closeChannel({ channelId: channel.channelId, force });
		} catch (e) {
			throw lightningRefusal(e, { asset: channel.asset });
		}
		toast(
			force
				? `Force closing the ${channel.asset?.name} channel. The funds come back after its safety delay.`
				: `Closing the ${channel.asset?.name} channel. The funds come back on-chain once it confirms.`,
			'success'
		);
		setModal(null);
		changed();
	};

	return (
		<>
			<Card
				title="Asset channels"
				help="A Lightning channel funded with an asset. Payments through it are made in the asset, and the peer exchanges it for bitcoin at a price it quotes each time."
				actions={
					<Button
						variant="primary"
						className="sm"
						data-testid="asset-channel-open"
						onClick={(e) => setModal({ type: 'open', assetKey: null, origin: clickOrigin(e) })}
					>
						Open asset channel
					</Button>
				}
			>
				<div data-testid="asset-channels" data-count={channels ? channels.length : ''}>
					{!channels && error ? (
						<div className="error-note" role="alert">
							{lightningRefusal(error).text}
						</div>
					) : !channels ? (
						<Skeleton height={72} />
					) : channels.length === 0 ? (
						<Empty>No asset channels. Open one to send and receive an asset over Lightning.</Empty>
					) : (
						<AssetChannelRows channels={channels} onClose={(c, e) => setModal({ type: 'close', channel: c, origin: clickOrigin(e) })} />
					)}
				</div>
			</Card>

			{modal?.type === 'open' && (
				<OpenAssetChannelModal
					id={id}
					api={api}
					assetKey={modal.assetKey}
					origin={modal.origin}
					onClose={() => setModal(null)}
					onDone={() => {
						setModal(null);
						changed();
					}}
				/>
			)}
			{modal?.type === 'close' && (
				<CloseAssetChannelModal
					channel={modal.channel}
					origin={modal.origin}
					onClose={() => setModal(null)}
					onConfirm={(force) => close(modal.channel, force)}
				/>
			)}
		</>
	);
}
