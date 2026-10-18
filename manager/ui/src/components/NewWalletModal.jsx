import { useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Button, Disclosure, Field, Help, Modal, Note, Segmented } from './ui.jsx';
import ElectrumFields from './ElectrumFields.jsx';
import LfbwFields, { EMPTY_LFBW, lfbwBody, lfbwComplete, primaryCandidates } from './LfbwFields.jsx';
import GuardianServeField from './GuardianServeField.jsx';
import NetworkModeField from './NetworkModeField.jsx';
import FforSettleField from './FforSettleField.jsx';
import RecoveryModeField from './RecoveryModeField.jsx';
import RecoveryAutoApplyField from './RecoveryAutoApplyField.jsx';
import { irohBody } from '../lib/iroh.js';
import { usesOnion, usesPublic } from '../lib/node-uris.js';

function emptyElectrum(config) {
	return config.defaultElectrum ? { ...config.defaultElectrum } : { host: '', port: 50001, tls: false };
}

/**
 * Create or import a wallet. The basics sit in view; everything a new wallet
 * can also be told (its Electrum server, channel backup, the roles it serves,
 * lightning-first, how it reaches the network) folds away under Advanced and
 * keeps its values while folded.
 */
export default function NewWalletModal({ config, wallets, origin, onClose, onDone, onSeed, onOpen }) {
	const toast = useToast();
	const [tab, setTab] = useState('create');
	const [lfbw, setLfbw] = useState({ ...EMPTY_LFBW });
	const [name, setName] = useState('');
	const [network, setNetwork] = useState(config.defaultNetwork);
	const [wordCount, setWordCount] = useState(24);
	const [mnemonic, setMnemonic] = useState('');
	const [custom, setCustom] = useState(!config.defaultElectrum);
	const [electrum, setElectrum] = useState(emptyElectrum(config));

	// The network mode (umbrel #193): hybrid is the posture a new wallet always
	// had, direct dials with the onion announced when announcing is on, plus a
	// public address once one is entered.
	const [networkMode, setNetworkMode] = useState('hybrid');
	const [publicHost, setPublicHost] = useState('');
	const [announce, setAnnounce] = useState(false);
	const [iroh, setIroh] = useState(false);
	const [irohRelays, setIrohRelays] = useState('');
	const announced = announce && (usesOnion(networkMode) || (usesPublic(networkMode) && !!publicHost.trim()));
	const [onchainOnly, setOnchainOnly] = useState(false);
	// Channel backup defaults to seed only until peer-storage restore is
	// reachable end to end; the choice is there for anyone opting in now.
	const [recoveryMode, setRecoveryMode] = useState('off');
	// The one-time answer a peer-storage import asks for: is the previous
	// device stopped? With it the daemon applies the newest checkpoint its
	// peers return by itself (beignet #690). Import only: a fresh wallet has
	// nothing anywhere to restore.
	const [recoveryAutoApply, setRecoveryAutoApply] = useState(false);
	// Serve the reference guardian to other beignet nodes at this wallet's
	// Lightning address (beignet #699). Off by default: it is an obligation
	// to stay online for whoever pins this node.
	const [guardianServe, setGuardianServe] = useState(false);
	const asksGuardianServe = !!config.guardianHostingAvailable && !onchainOnly;
	// Settle offline receives for siblings (FFOR, beignet #729). Off by
	// default: each book locks its whole amount on this wallet's side.
	const [fforBlock, setFforBlock] = useState({ settle: { enabled: false }, witness: { enabled: false }, issuer: { enabled: false } });
	const asksFfor = !!config.fforAvailable && !onchainOnly;
	const [busy, setBusy] = useState(false);
	const guardiansConfigured = (config.recoveryGuardians || []).length === 3;
	const asksAutoApply =
		tab === 'import' && !onchainOnly && recoveryMode === 'peer-storage' && !!config.recoveryAutoApplyAvailable;

	// Why the button is off, said next to it rather than left to be guessed.
	const blocker = !name.trim()
		? 'Give the wallet a name.'
		: tab === 'import' && !mnemonic.trim()
		? 'Paste the recovery phrase.'
		: onchainOnly
		? null
		: !lfbwComplete(lfbw)
		? 'Choose a primary node for the lightning-first wallet, or switch lightning-first off.'
		: networkMode === 'clearnet' && !publicHost.trim()
		? 'Clearnet mode needs a public address.'
		: null;

	const submit = async () => {
		setBusy(true);
		try {
			const elec = custom
				? { host: electrum.host.trim(), port: parseInt(electrum.port, 10), tls: !!electrum.tls }
				: undefined;
			const shared = {
				name,
				network,
				electrum: elec,
				networkMode,
				...(config.irohAvailable ? { iroh: irohBody(iroh && !onchainOnly, irohRelays) } : {}),
				publicHost,
				announce,
				onchainOnly,
				recoveryMode: onchainOnly ? 'off' : recoveryMode,
				...(asksGuardianServe ? { guardianServe } : {}),
				...(asksFfor ? { ffor: fforBlock } : {}),
				...(config.lfbwAvailable && !onchainOnly ? { lfbw: lfbwBody(lfbw) } : {})
			};
			if (tab === 'create') {
				const r = await manager.createWallet({ ...shared, wordCount });
				onDone();
				onSeed({ type: 'seed', name: r.record.name, mnemonic: r.mnemonic });
				return;
			}
			const r = await manager.importWallet({
				...shared,
				mnemonic,
				...(asksAutoApply ? { recoveryAutoApply } : {})
			});
			toast('Wallet imported. It will sync in the background.', 'success');
			onDone();
			// A guardian-mode import may land in the restore hold (the guardians
			// already hold this seed's channels); the wallet page is where that
			// is answered, so go there.
			if (!onchainOnly && (recoveryMode === 'async-remote' || recoveryMode === 'quorum') && r?.record?.id) {
				onOpen(r.record);
				return;
			}
			onClose();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Modal
			title="New wallet"
			onClose={onClose}
			origin={origin}
			wide
			foot={
				<>
					{blocker && <span className="field-hint">{blocker}</span>}
					<span className="spacer" />
					<Button onClick={onClose}>Cancel</Button>
					<Button variant="primary" busy={busy} onClick={submit} disabled={!!blocker}>
						{tab === 'create' ? 'Create wallet' : 'Import wallet'}
					</Button>
				</>
			}
		>
			<Segmented
				id="new-wallet"
				value={tab}
				onChange={setTab}
				label="Create or import"
				options={[
					['create', 'Create wallet'],
					['import', 'Import wallet']
				]}
			/>

			<div className="row">
				<Field label="Name">
					<input value={name} placeholder="My wallet" onChange={(e) => setName(e.target.value)} autoFocus />
				</Field>
				<Field label="Network">
					<select value={network} onChange={(e) => setNetwork(e.target.value)}>
						{config.supportedNetworks.map((n) => (
							<option key={n} value={n}>
								{n}
							</option>
						))}
					</select>
				</Field>
				{tab === 'create' && (
					<Field label="Seed length">
						<select value={wordCount} onChange={(e) => setWordCount(parseInt(e.target.value, 10))}>
							<option value={24}>24 words</option>
							<option value={12}>12 words</option>
						</select>
					</Field>
				)}
			</div>

			{tab === 'import' && (
				<Field label="Recovery phrase">
					<textarea
						rows={3}
						value={mnemonic}
						placeholder="Enter your 12 or 24 word seed phrase"
						onChange={(e) => setMnemonic(e.target.value)}
					/>
				</Field>
			)}

			<label className="checkbox field">
				<input type="checkbox" checked={onchainOnly} onChange={(e) => setOnchainOnly(e.target.checked)} />
				On-chain only (no Lightning)
				<Help>
					A plain Bitcoin wallet: addresses, transactions and coins, with the Lightning apparatus put
					away and no Lightning listener running. The same seed backs both modes, so Lightning can be
					switched on later from the wallet's Edit dialog without touching the seed.
					{tab === 'import'
						? " Importing reads the seed's history off the chain itself, reaching back to before this wallet existed, as far as the standard address scan finds use."
						: ''}
				</Help>
			</label>

			{!config.defaultElectrum && !custom && (
				<Note tone="info">No default Electrum server set. Choose one under Advanced or in Settings.</Note>
			)}

			<Disclosure label="Advanced options" openLabel="Advanced options" defaultOpen={!config.defaultElectrum} persist>
				<label className="checkbox field" style={{ marginTop: 4 }}>
					<input type="checkbox" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
					{config.defaultElectrum ? 'Use a different Electrum server for this wallet' : 'Electrum server'}
				</label>
				{custom && <ElectrumFields presets={config.electrumPresets} value={electrum} onChange={setElectrum} />}

				{config.recoveryAvailable && !onchainOnly && (
					<RecoveryModeField
						value={recoveryMode}
						onChange={setRecoveryMode}
						guardiansConfigured={guardiansConfigured}
						settingsGuardians={config.recoveryGuardians || []}
						importing={tab === 'import'}
					/>
				)}
				{asksAutoApply && <RecoveryAutoApplyField value={recoveryAutoApply} onChange={setRecoveryAutoApply} />}

				{asksGuardianServe && (
					<GuardianServeField value={guardianServe} onChange={setGuardianServe} announced={announced} />
				)}
				{asksFfor && <FforSettleField value={fforBlock} onChange={setFforBlock} />}

				{config.lfbwAvailable && !onchainOnly && (
					<LfbwFields value={lfbw} onChange={setLfbw} candidates={primaryCandidates(wallets, { network })} />
				)}

				{!onchainOnly && (
					<NetworkModeField
						mode={networkMode}
						onMode={setNetworkMode}
						publicHost={publicHost}
						onPublicHost={setPublicHost}
						announce={announce}
						onAnnounce={setAnnounce}
						torAvailable={!!config.torAvailable}
						torProxyScopeAvailable={config.torProxyScopeAvailable !== false}
						irohAvailable={!!config.irohAvailable}
						iroh={iroh}
						onIroh={setIroh}
						irohRelays={irohRelays}
						onIrohRelays={setIrohRelays}
					/>
				)}
			</Disclosure>
		</Modal>
	);
}
