import { Field } from './ui.jsx';
import { MODE_LABELS, RECOVERY_MODES, isGuardianMode } from '../lib/recovery.js';

/**
 * The per-wallet channel backup choice (the beignet Recovery Protocol), shared
 * by the create form and the edit dialog so both read the same.
 *
 * Four modes, one note for the one selected. The guardian modes need a set
 * of three guardians in Settings; without one they stay listed but disabled,
 * with the hint saying where to go. The peer storage note is honest about the
 * engine it ships with: the checkpoints go out, but nothing restores from
 * them yet.
 */
const NOTES = {
	off: 'Nothing is kept beyond the seed. If this Umbrel is lost, importing the seed elsewhere recovers the on-chain funds. Open channels are closed by their peers and the funds return on-chain over time. Fine for a wallet without channels.',
	'peer-storage':
		'The wallet keeps an encrypted checkpoint of its channels with the peers it has channels with. Nothing to set up and no extra servers. This version of the engine sends the checkpoints but cannot restore from them yet, so a restore still closes channels. Turning it on now means the checkpoints exist when it can.',
	'async-remote':
		'Channel state is copied in the background to the three guardian servers set in Settings. Payments never wait on them. If this Umbrel is lost, importing the seed with the same guardians restores the channels and resumes them. A payment mid-flight at the exact moment of loss may not be covered; that channel closes safely instead.',
	quorum:
		'Every payment step waits until two of the three guardians have stored it, so a restore resumes every channel exactly and the old device is fenced off. Payments take a guardian round trip longer and pause while fewer than two guardians are reachable. Once this wallet has used strict quorum it cannot go back to a weaker setting.'
};

export const OPTION_LABELS = {
	off: 'Seed only (channels close on restore)',
	'peer-storage': 'Checkpoints via peer storage',
	'async-remote': MODE_LABELS['async-remote'],
	quorum: MODE_LABELS.quorum
};

export default function RecoveryModeField({
	value,
	onChange,
	guardiansConfigured,
	importing = false,
	disabled = false,
	pinnedGuardians = [],
	settingsGuardians = [],
	// A wallet that has used strict quorum cannot leave it: the weaker
	// options stay listed, disabled, with the reason on them.
	lockedToQuorum = false
}) {
	const pinned = pinnedGuardians.length > 0;
	const guardiansUsable = pinned || guardiansConfigured;
	const differs =
		pinned &&
		settingsGuardians.length > 0 &&
		pinnedGuardians
			.map((g) => String(g).slice(0, 64).toLowerCase())
			.sort()
			.join() !==
			settingsGuardians
				.map((g) => String(g).slice(0, 64).toLowerCase())
				.sort()
				.join();
	return (
		<>
			<Field label="Channel backup">
				<select
					value={value}
					disabled={disabled}
					data-testid="recovery-mode"
					onChange={(e) => onChange(e.target.value)}
				>
					{RECOVERY_MODES.map((mode) => {
						const needsGuardians = isGuardianMode(mode) && !guardiansUsable;
						const weaker = lockedToQuorum && mode !== 'quorum';
						return (
							<option
								key={mode}
								value={mode}
								disabled={needsGuardians || weaker}
								title={
									weaker
										? 'A wallet that has used strict quorum cannot move to a weaker setting'
										: needsGuardians
										? 'Set three guardians in Settings to use these'
										: undefined
								}
							>
								{OPTION_LABELS[mode]}
							</option>
						);
					})}
				</select>
			</Field>
			<div className="info-note">{NOTES[value] || NOTES.off}</div>
			{!guardiansUsable && !disabled && (
				<div className="info-note">Set three guardians in Settings to use the guardian modes.</div>
			)}
			{importing && guardiansUsable && (
				<div className="info-note">
					To restore channels from guardians, enter the same three guardians this wallet used
					before in Settings, then import with the same guardian setting. If the guardians hold
					this wallet, the next page offers the restore.
				</div>
			)}
			{pinned && (
				<div className="info-note">
					Guardians for this wallet are fixed to the set it first registered with (three
					servers).
					{differs ? ' Settings now lists a different set; this wallet keeps its own.' : ''}
					<ul className="guardian-list">
						{pinnedGuardians.map((g) => (
							<li key={g}>
								<code>{g}</code>
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}
