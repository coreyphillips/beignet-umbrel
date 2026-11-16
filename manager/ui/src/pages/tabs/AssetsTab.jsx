import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { useToast } from '../../components/Toast.jsx';
import { Button, ErrorNote, Segmented, Skeleton } from '../../components/ui.jsx';
import { useAssetActivity, useAssetBalances, useAssetSummary, useAssetsApi } from '../../hooks/useAssets.js';
import { assetWarnings, explorerNetwork, hostState, sentence } from '../../lib/assets.js';
import { openBackup } from '../../lib/backup.js';
import AssetDetail from './assets/AssetDetail.jsx';
import AssetSettingsModal from './assets/AssetSettingsModal.jsx';
import CreateView, { EMPTY_CREATE, EMPTY_SEEDLING, isBlank } from './assets/CreateView.jsx';
import HoldingsView from './assets/HoldingsView.jsx';
import HostNotice from './assets/HostNotice.jsx';
import ReceiveView, { EMPTY_RECEIVE } from './assets/ReceiveView.jsx';
import SendView, { EMPTY_SEND } from './assets/SendView.jsx';
import { ExplorerNetwork, Parts, useFees } from './assets/shared.jsx';

const VIEWS = [
	['holdings', 'Holdings'],
	['receive', 'Receive'],
	['send', 'Send'],
	['create', 'Create']
];
const VIEW_KEYS = VIEWS.map(([key]) => key);

/* ------------------------------------------------------------- the draft */

// What is being described on the Create view is kept in this browser tab's
// storage, so a reload, or a look at another wallet, does not lose it. It is
// the description only: nothing about a mint reaches the wallet until the
// button is pressed.
const draftKey = (id) => `beignet-asset-draft-${id}`;

/** The Create view's state as it is stored: what was typed, and which mint is being watched. */
export function draftOf(create) {
	const kept = { form: create.form, batch: create.batch, feeRate: create.feeRate, mintedRowId: create.minted?.rowId || null };
	const empty = isBlank(create.form) && create.batch.length === 0 && !kept.mintedRowId && !create.feeRate;
	return empty ? null : kept;
}

/** The Create view's state from a stored draft, with how many assets it was holding. */
export function createFromDraft(draft) {
	if (!draft || typeof draft !== 'object') return EMPTY_CREATE;
	const form = { ...EMPTY_SEEDLING, ...(draft.form && typeof draft.form === 'object' ? draft.form : {}) };
	const batch = Array.isArray(draft.batch) ? draft.batch.filter((b) => b && typeof b === 'object').map((b) => ({ ...EMPTY_SEEDLING, ...b })) : [];
	return {
		form,
		batch,
		feeRate: typeof draft.feeRate === 'string' ? draft.feeRate : '',
		minted: draft.mintedRowId ? { rowId: draft.mintedRowId, row: null } : null,
		restored: batch.length + (isBlank(form) ? 0 : 1)
	};
}

function readDraft(id) {
	try {
		const raw = sessionStorage.getItem(draftKey(id));
		return raw ? createFromDraft(JSON.parse(raw)) : EMPTY_CREATE;
	} catch (_) {
		return EMPTY_CREATE;
	}
}

function writeDraft(id, create) {
	try {
		const draft = draftOf(create);
		if (draft) sessionStorage.setItem(draftKey(id), JSON.stringify(draft));
		else sessionStorage.removeItem(draftKey(id));
	} catch (_) {
		/* no storage, no draft */
	}
}

/* --------------------------------------------------------------- the tab */

/**
 * Where the tab is: which view, and which asset when one is open.
 *
 * Both are in the address (?view=send, ?asset=<key>), so a view can be
 * linked to and the browser's Back button steps out of an asset. Without a
 * `go` to move the address (a test, or anywhere the tab is mounted bare) the
 * same thing is kept in state.
 */
function usePlace(route, go) {
	const [local, setLocal] = useState({});
	const query = go ? route?.query || {} : local;
	const view = VIEW_KEYS.includes(query.view) ? query.view : 'holdings';
	const assetKey = query.asset ? String(query.asset).toLowerCase() : null;
	const move = useCallback(
		(next, options) => {
			if (go) go('assets', { query: next, ...options });
			else setLocal(next);
		},
		[go]
	);
	return { view, assetKey, move };
}

function AssetsTabBody({ id, api, info, health, rec, tick, bump, config, route, go, assets: summary }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const { view, assetKey, move } = usePlace(route, go);

	// The wallet page polls the summary for its nav and hands it down; mounted
	// without one, the tab asks for itself.
	const own = useAssetSummary(api, summary === undefined, tick);
	const { status, error: statusError, loading: statusLoading } = summary === undefined ? own : summary;
	// Whether there is a host to ask at all: it may have failed to start, be
	// starting still, or be going down with the wallet. Only a ready one is
	// asked for anything more than its status.
	const standing = useMemo(
		() => hostState({ status, error: statusError, loading: statusLoading, rec }),
		[status, statusError, statusLoading, rec]
	);
	const ready = standing.kind === 'ready';
	const { holdings, btc, error: holdingsError, loading: holdingsLoading } = useAssetBalances(api, tick, ready);
	const { rows } = useAssetActivity(api, tick, { limit: 60 }, ready);
	const fees = useFees(api);

	const network = rec?.network || status?.network || 'mainnet';
	const host = status?.proofServer?.host || null;
	const lightning = !!config?.assetChannelsAvailable && !rec?.onchainOnly && status?.lightning?.mode !== 'off';

	const [receive, setReceive] = useState(EMPTY_RECEIVE);
	const [send, setSend] = useState(EMPTY_SEND);
	const [create, setCreate] = useState(() => readDraft(id));
	const [settings, setSettings] = useState(null); // click origin or null
	const patchReceive = useCallback((changes) => setReceive((s) => ({ ...s, ...changes })), []);
	const patchSend = useCallback((changes) => setSend((s) => ({ ...s, ...changes })), []);
	const patchCreate = useCallback((changes) => setCreate((s) => ({ ...s, ...changes })), []);
	useEffect(() => {
		writeDraft(id, create);
	}, [id, create]);

	// A place asked for with something in hand: Receive for this asset, Create
	// more of that one.
	const setView = useCallback(
		(next, options = {}) => {
			if (next === 'receive' && options.key) {
				setReceive({ ...EMPTY_RECEIVE, picker: { key: options.key, other: false, text: '', found: null } });
			}
			if (next === 'create' && options.reissue) {
				setCreate((s) => ({ ...s, minted: null, form: { ...EMPTY_SEEDLING, target: options.reissue } }));
			}
			move(next === 'holdings' ? {} : { view: next });
		},
		[move]
	);

	const retryProof = useCallback(
		async (row) => {
			try {
				await assets.retryProof(row.id);
				toast('Asking the proof server again', 'info');
				bump();
			} catch (e) {
				toast(sentence(e.message || 'The proof server could not be asked'), 'error');
			}
		},
		[assets, bump, toast]
	);

	// The same transaction, sent to the network once more. It is not a fee
	// bump: nothing about the transaction changes.
	const [rebroadcasting, setRebroadcasting] = useState(null);
	const rebroadcast = useCallback(
		async (rowId) => {
			setRebroadcasting(rowId);
			try {
				await assets.rebroadcast(rowId);
				toast('Broadcast again. It confirms when a block takes it.', 'info');
			} catch (e) {
				// NOT_BROADCAST is good news said as a refusal: it has a block by now.
				toast(sentence(e.message || 'The transaction could not be broadcast again'), e.code === 'NOT_BROADCAST' ? 'info' : 'error');
			} finally {
				setRebroadcasting(null);
				bump();
			}
		},
		[assets, bump, toast]
	);

	// One look at the chain for an address still waiting to be paid.
	const checkAddress = useCallback(
		async (row) => {
			try {
				const answer = await assets.checkAddress(row.id);
				const found = !!answer?.row && answer.row.state !== 'waiting';
				toast(found ? 'A payment to that address was found' : 'Nothing has arrived at that address yet', 'info');
				bump();
			} catch (e) {
				toast(sentence(e.message || 'The address could not be checked'), 'error');
			}
		},
		[assets, bump, toast]
	);

	const warnings = useMemo(
		() => (ready ? assetWarnings({ status, rec, info, health, btc, holdings, rows, fees }) : []),
		[ready, status, rec, info, health, btc, holdings, rows, fees]
	);

	let body;
	if (standing.kind === 'loading') {
		body = (
			<div data-testid="assets-loading">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} height={64} style={{ marginBottom: 12 }} />
				))}
			</div>
		);
	} else if (standing.kind === 'unreadable') {
		body = (
			<div data-testid="assets-unreadable">
				<ErrorNote error={statusError} />
				<div className="wallet-meta">Assets could not be read from the wallet.</div>
			</div>
		);
	} else if (!ready) {
		// A wallet with a proof server of its own is offered the setting: it is
		// the one thing here that could be what keeps assets from starting.
		body = (
			<HostNotice
				state={standing}
				go={go}
				onSettings={rec?.assets?.universe ? (e) => setSettings({ x: e.clientX, y: e.clientY }) : undefined}
			/>
		);
	} else if (!holdings && (holdingsLoading || !holdingsError)) {
		body = (
			<div data-testid="assets-loading">
				{[0, 1, 2].map((i) => (
					<Skeleton key={i} height={64} style={{ marginBottom: 12 }} />
				))}
			</div>
		);
	} else if (assetKey) {
		body = (
			<AssetDetail
				api={api}
				assetKey={assetKey}
				tick={tick}
				rows={rows}
				network={network}
				host={host}
				lightning={lightning}
				fees={fees}
				bump={bump}
				go={go}
				setView={setView}
				back={() => move({})}
				backHref={`/w/${id}/assets`}
				onRetryProof={retryProof}
			/>
		);
	} else if (view === 'receive') {
		body = (
			<ReceiveView
				api={api}
				state={receive}
				patch={patchReceive}
				holdings={holdings}
				rows={rows}
				network={network}
				host={host}
				proofServer={status.proofServer}
				lightning={lightning}
				bump={bump}
				onRetryProof={retryProof}
				onCheckAddress={checkAddress}
			/>
		);
	} else if (view === 'send') {
		body = (
			<SendView
				api={api}
				state={send}
				patch={patchSend}
				holdings={holdings}
				rows={rows}
				network={network}
				fees={fees}
				rec={rec}
				proofServer={status.proofServer}
				lightning={lightning}
				bump={bump}
				go={go}
			/>
		);
	} else if (view === 'create') {
		body = (
			<CreateView
				api={api}
				state={create}
				patch={patchCreate}
				holdings={holdings}
				rows={rows}
				status={status}
				network={network}
				fees={fees}
				bump={bump}
				setView={setView}
				onDiscard={() => setCreate(EMPTY_CREATE)}
				onRetryProof={retryProof}
			/>
		);
	} else {
		body = (
			<HoldingsView
				id={id}
				status={status}
				holdings={holdings}
				btc={btc}
				rows={rows}
				network={network}
				host={host}
				lightning={lightning}
				openAsset={(key) => move({ asset: key })}
				setView={setView}
				onRetryProof={retryProof}
			/>
		);
	}

	const place = assetKey ? `asset-${assetKey}` : view;

	return (
		<ExplorerNetwork.Provider value={explorerNetwork(network, status)}>
			<div className="assets" data-testid="assets-tab" data-view={assetKey ? 'asset' : view} data-host={standing.kind}>
				{warnings.map((w) => (
					<div
						key={w.code}
						className={`${w.tone === 'error' ? 'error-note' : 'info-note'}${w.action ? ' note-with-action' : ''}`}
						role={w.tone === 'error' ? 'alert' : 'status'}
						data-testid="asset-warning"
						data-code={w.code}
					>
						<span>
							<Parts parts={w.parts} />
						</span>
						{w.action === 'backup' && (
							<Button className="sm" data-testid="asset-backup-now" onClick={(e) => openBackup('export', { x: e.clientX, y: e.clientY })}>
								Back up now
							</Button>
						)}
						{w.action === 'rebroadcast' && (
							<Button className="sm" data-testid="asset-rebroadcast" disabled={rebroadcasting === w.rowId} onClick={() => rebroadcast(w.rowId)}>
								{rebroadcasting === w.rowId ? 'Broadcasting…' : 'Broadcast again'}
							</Button>
						)}
					</div>
				))}
				{ready && holdingsError && holdings && (
					<div className="error-note" role="alert" data-testid="assets-stale">
						Assets could not be read from the wallet. The last figures are kept below.
					</div>
				)}

				{ready && !assetKey && (
					<div className="assets-bar">
						<Segmented id="assets-view" options={VIEWS} value={view} onChange={(next) => setView(next)} />
						<Button className="sm" data-testid="asset-settings-open" onClick={(e) => setSettings({ x: e.clientX, y: e.clientY })}>
							Settings
						</Button>
					</div>
				)}

				<AnimatePresence mode="wait" initial={false}>
					<m.div
						key={place}
						initial={{ opacity: 0, y: 8 }}
						animate={{ opacity: 1, y: 0 }}
						exit={{ opacity: 0, y: -4 }}
						transition={{ duration: 0.16, ease: 'easeOut' }}
					>
						{body}
					</m.div>
				</AnimatePresence>

				{settings && rec && (
					<AssetSettingsModal
						api={api}
						rec={rec}
						status={status}
						config={config}
						network={network}
						lightning={lightning}
						origin={settings}
						onClose={() => setSettings(null)}
						onSaved={() => {
							setSettings(null);
							bump();
						}}
					/>
				)}
			</div>
		</ExplorerNetwork.Provider>
	);
}

/**
 * The Assets tab: Taproot Assets held by this wallet, and creating, receiving
 * and sending them.
 *
 * One tab with four views behind a bar (Holdings, Receive, Send, Create) and
 * a page per asset, reached from Holdings. What is typed into a view lives
 * here, above the views, so stepping from Send to Holdings to check a balance
 * and back does not empty the form.
 *
 * Keyed by wallet: another wallet's tab is another tab, with its own forms.
 */
export default function AssetsTab(props) {
	return <AssetsTabBody key={props.id} {...props} />;
}
