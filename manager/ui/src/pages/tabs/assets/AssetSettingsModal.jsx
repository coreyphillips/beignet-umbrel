import { useState } from 'react';
import { manager } from '../../../api.js';
import AssetAvatar from '../../../components/AssetAvatar.jsx';
import { looksLikeAssetId } from '../../../components/AssetPicker.jsx';
import { useToast } from '../../../components/Toast.jsx';
import { Button, CopyText, Field, Help, Modal } from '../../../components/ui.jsx';
import { useAssetsApi } from '../../../hooks/useAssets.js';
import { fmtUnits } from '../../../lib/asset-amount.js';
import {
	COURIER_PORT,
	describeProofServerTest,
	describeType,
	formToUniverse,
	chainName,
	proofServersFor,
	sentence,
	universeToForm
} from '../../../lib/assets.js';
import { shortId } from '../../../lib/format.js';
import { LimitsList } from './shared.jsx';

/** Looking an asset up by its ID on the proof server, without holding it. */
function Lookup({ assets }) {
	const [text, setText] = useState('');
	const [busy, setBusy] = useState(false);
	const [answer, setAnswer] = useState(null); // { asset } | { missing } | { error }
	const id = text.trim().toLowerCase();
	const run = async () => {
		setBusy(true);
		setAnswer(null);
		try {
			const found = await assets.lookup(id);
			setAnswer({ asset: found.asset });
		} catch (e) {
			setAnswer(e.status === 404 || e.code === 'ASSET_NOT_FOUND' ? { missing: true } : { error: sentence(e.message || 'The proof server did not answer') });
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<Field label="Look up an asset by ID" hint="An asset ID is 64 characters; a group key is 66.">
				<input
					className="mono"
					value={text}
					placeholder="Asset ID or group key"
					spellCheck={false}
					autoComplete="off"
					data-testid="asset-settings-lookup"
					onChange={(e) => {
						setText(e.target.value);
						setAnswer(null);
					}}
				/>
			</Field>
			<div className="electrum-test-row">
				<Button className="sm" busy={busy} disabled={!looksLikeAssetId(id)} data-testid="asset-settings-lookup-run" onClick={run}>
					Look up
				</Button>
				{answer?.missing && (
					<span className="electrum-test-result" role="status" data-state="unreachable">
						The proof server knows no asset with that ID.
					</span>
				)}
				{answer?.error && (
					<span className="electrum-test-result" role="status" data-state="error">
						{answer.error}
					</span>
				)}
			</div>
			{answer?.asset && (
				<div className="asset-found" role="status" data-testid="asset-settings-found">
					<AssetAvatar asset={answer.asset} size="sm" />
					<span className="asset-row-main">
						<span className="asset-name">{answer.asset.name}</span>
						<span className="asset-id">
							{describeType(answer.asset)}
							{answer.asset.supply?.issued ? ` · ${fmtUnits(answer.asset.supply.issued, answer.asset.decimalDisplay || 0)} issued` : ''}
						</span>
					</span>
					<CopyText value={answer.asset.assetId} label={shortId(answer.asset.assetId)} />
				</div>
			)}
		</>
	);
}

const DEFAULT = 'default';
const CUSTOM = 'custom';

const sameUniverse = (a, b) => !!a && !!b && a.courier === b.courier && String(a.rest).replace(/\/+$/, '') === String(b.rest).replace(/\/+$/, '');

/**
 * Asset settings: the proof server, and the small print.
 *
 * The proof server is a setting of the wallet, kept in its record beside the
 * Electrum server, and the wallet's assets host reads it when it starts. So
 * saving a change restarts the wallet, and the dialog says so before the
 * button is pressed, not after.
 *
 * The choices are the servers the app knows for the wallet's network
 * (`config.universeServers`), the first of them being the default, and one
 * typed by hand. The default is saved as no setting at all, so a wallet
 * follows the app if the app's default ever changes.
 */
export default function AssetSettingsModal({ api, rec, status, config, network, lightning, origin, onClose, onSaved }) {
	const toast = useToast();
	const assets = useAssetsApi(api);
	const current = rec?.assets?.universe || null;
	// Which testnet, for a testnet wallet whose host has found out.
	const chain = chainName(network, status);
	const known = proofServersFor(config, network, status?.chain?.name || null);
	const [first, ...others] = known;
	const [choice, setChoice] = useState(() => (!current ? DEFAULT : others.find((s) => sameUniverse(s, current))?.id || CUSTOM));
	const custom = choice === CUSTOM;
	const picked = others.find((s) => s.id === choice) || null;
	const [form, setForm] = useState(() => universeToForm(current));
	const [busy, setBusy] = useState(false);
	const [testing, setTesting] = useState(false);
	const [tested, setTested] = useState(null); // { key, state, text }
	const [problem, setProblem] = useState(null);

	// What the wallet's host is using now. It names the default only while
	// that is what it uses, so the app's own list is asked first.
	const server = status?.proofServer || null;
	const defaultHost = first?.host || server?.defaultHost || (server?.isDefault ? server.host : null);
	const defaultRest = first?.rest || (server?.isDefault ? server.rest : null);
	const built = custom ? formToUniverse(form) : { universe: picked ? { courier: picked.courier, rest: picked.rest } : null };
	const testable = custom ? built.universe?.rest : picked ? picked.rest : defaultRest;
	const key = JSON.stringify(built.universe || null);
	// A form that is not a server yet still counts as a change, so Save can
	// be pressed and say what is missing instead of sitting there disabled.
	const changed = !!built.problem || key !== JSON.stringify(current);
	const set = (changes) => {
		setForm((f) => ({ ...f, ...changes }));
		setProblem(null);
	};

	const choose = (next) => {
		setChoice(next);
		setProblem(null);
	};

	const test = async () => {
		const rest = testable;
		if (!rest) return;
		setTesting(true);
		try {
			const result = await assets.testProofServer(rest);
			setTested({ key, ...describeProofServerTest(result, network) });
		} catch (e) {
			setTested({ key, state: 'error', text: sentence(e.message || 'The test could not be run') });
		} finally {
			setTesting(false);
		}
	};

	const save = async () => {
		if (built.problem) {
			setProblem(built.problem);
			return;
		}
		setBusy(true);
		setProblem(null);
		try {
			await manager.updateWallet(rec.id, { assets: { universe: built.universe } });
			toast('Proof server saved. The wallet is restarting.', 'success');
			onSaved();
		} catch (e) {
			setProblem(sentence(e.message || 'The proof server could not be saved'));
			setBusy(false);
		}
	};

	const shown = tested && tested.key === key ? tested : null;

	return (
		<Modal title="Asset settings" origin={origin} onClose={onClose}>
			<div data-testid="asset-settings">
				<div className="field-label" style={{ marginBottom: 8 }}>
					Proof server
					<Help>
						Wallets exchange asset proofs through a proof server, also called a universe. This wallet asks it for the
						proof of each asset it receives, and writes its address into the addresses it creates, so senders know where
						to deliver proofs.
					</Help>
				</div>
				<div role="radiogroup" aria-label="Proof server" className="radio-list">
					<label className="checkbox field">
						<input
							type="radio"
							name="asset-proof-server"
							checked={choice === DEFAULT}
							data-testid="asset-settings-default"
							onChange={() => choose(DEFAULT)}
						/>
						<span>
							Default for {chain}
							{defaultHost ? (
								<>
									: <code>{defaultHost}</code>
								</>
							) : null}
							{first?.label && <span className="radio-sub">{first.note || first.label}</span>}
							{!defaultHost && (
								<span className="radio-sub">
									The app knows no proof server for {chain}, so assets have none unless one is set here.
								</span>
							)}
						</span>
					</label>
					{others.map((s) => (
						<label className="checkbox field" key={s.id}>
							<input
								type="radio"
								name="asset-proof-server"
								checked={choice === s.id}
								data-testid={`asset-settings-server-${s.id}`}
								onChange={() => choose(s.id)}
							/>
							<span>
								{s.label || 'Proof server'}: <code>{s.host}</code>
								{s.note && <span className="radio-sub">{s.note}</span>}
							</span>
						</label>
					))}
					<label className="checkbox field">
						<input
							type="radio"
							name="asset-proof-server"
							checked={custom}
							data-testid="asset-settings-custom"
							onChange={() => choose(CUSTOM)}
						/>
						<span>Custom</span>
					</label>
				</div>

				{custom && (
					<div data-testid="asset-settings-custom-fields">
						<div className="row">
							<Field label="Host">
								<input
									value={form.host}
									placeholder="universe.example.com"
									spellCheck={false}
									autoComplete="off"
									data-testid="asset-settings-host"
									onChange={(e) => set({ host: e.target.value })}
								/>
							</Field>
							<Field label="Port">
								<input
									value={form.port}
									inputMode="numeric"
									placeholder={String(COURIER_PORT)}
									style={{ maxWidth: 120 }}
									data-testid="asset-settings-port"
									onChange={(e) => set({ port: e.target.value.replace(/[^0-9]/g, '') })}
								/>
							</Field>
						</div>
						<Field label="Web address" hint="Where the same server answers over https. Left empty, https on the host above is used.">
							<input
								value={form.rest}
								placeholder={form.host.trim() ? `https://${form.host.trim()}` : 'https://universe.example.com'}
								spellCheck={false}
								autoComplete="off"
								data-testid="asset-settings-rest"
								onChange={(e) => set({ rest: e.target.value })}
							/>
						</Field>
					</div>
				)}

				<div className="electrum-test-row">
					<Button
						className="sm"
						busy={testing}
						disabled={!testable}
						data-testid="asset-settings-test"
						onClick={test}
					>
						Test
					</Button>
					{shown && (
						<span className="electrum-test-result" role="status" data-testid="asset-settings-test-result" data-state={shown.state}>
							{shown.text}
						</span>
					)}
				</div>

				{server && server.reachable === false && !changed && (
					<div className="error-note" role="alert">
						This wallet cannot reach <code>{server.host}</code> right now
						{server.lastError ? ` (${String(server.lastError).replace(/[.\s]+$/, '')})` : ''}. Receives wait for it; nothing is
						lost.
					</div>
				)}
				{server?.viaTor && <div className="field-note" style={{ marginTop: 0 }}>This wallet is in Tor mode, so the proof server is reached over Tor.</div>}
				<div className="info-note" role="note" data-testid="asset-settings-restart">
					Addresses you already handed out keep the server they were made with. Changing this restarts the wallet.
				</div>
				{problem && (
					<div className="error-note" role="alert" data-testid="asset-settings-problem">
						{problem}
					</div>
				)}

				<details className="field asset-details">
					<summary>Advanced</summary>
					<div style={{ marginTop: 10 }}>
						<Lookup assets={assets} />
						<div className="field-label" style={{ margin: '4px 0 6px' }}>
							What assets here do not cover
						</div>
						<LimitsList network={network} host={server?.host} lightning={lightning} testId="asset-limits-settings" />
					</div>
				</details>

				<div className="center-actions">
					<Button variant="primary" busy={busy} disabled={!changed} data-testid="asset-settings-save" onClick={save}>
						Save
					</Button>
					<Button onClick={onClose}>Cancel</Button>
				</div>
			</div>
		</Modal>
	);
}
