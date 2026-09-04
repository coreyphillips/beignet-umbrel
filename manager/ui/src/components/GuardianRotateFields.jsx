import { useState } from 'react';
import { manager } from '../api.js';
import { useToast } from './Toast.jsx';
import { Button, Field } from './ui.jsx';
import { guardianEntryLabel, isNodeUri } from '../lib/recovery.js';

/**
 * Replace a running wallet's guardians, one or all three, with the channels
 * running (beignet #701). The three slots start as the pinned set; a slot
 * takes a finished entry or a beignet node's Lightning address, which is
 * resolved before the rotation runs. The daemon registers with the new
 * set under its current lease, backfills, switches, and retires the old
 * set; the record follows on success, so no restart is needed.
 *
 * The consequence is named on the button: the old set is retired for good,
 * and a previous device still running on it freezes the moment it sees the
 * new generation.
 */
export default function GuardianRotateFields({ walletId, pinned, disabled = false, onRotated }) {
	const toast = useToast();
	const [slots, setSlots] = useState(() => {
		const list = (pinned || []).slice(0, 3);
		while (list.length < 3) list.push('');
		return list;
	});
	const [busy, setBusy] = useState(false);
	// The set the wallet is on right now: the pinned set until a rotation
	// lands, then the set it rotated to, so the slots compare against it.
	const [current, setCurrent] = useState(() => (pinned || []).slice(0, 3));
	const pinnedKeys = current.map((g) => String(g).slice(0, 64));
	const filled = slots.map((s) => s.trim()).filter(Boolean);
	const changed =
		filled.length === 3 &&
		(filled.some((g) => !isNodeUri(g) && !pinnedKeys.includes(g.slice(0, 64))) ||
			filled.some((g) => isNodeUri(g)));

	const rotate = async () => {
		setBusy(true);
		try {
			const entries = [];
			for (const g of filled) {
				if (isNodeUri(g)) {
					const r = await manager.resolveGuardian(g);
					entries.push(r.entry);
				} else {
					entries.push(g);
				}
			}
			const r = await manager.rotateGuardians(walletId, entries);
			toast(
				`Guardians rotated to generation ${r.generation}${
					r.retired === 0 ? '. The old set has not confirmed its retirement yet; the wallet keeps trying.' : '.'
				}`,
				'success'
			);
			setSlots(entries);
			setCurrent(entries);
			onRotated?.(r);
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<>
			<div className="field-label" style={{ marginTop: 4, marginBottom: 8 }}>
				Rotate guardians
			</div>
			<div className="info-note">
				Replace one guardian or all three while the channels keep running. Paste a guardian entry
				or a beignet node’s Lightning address (<code>node id@host:port</code>). The wallet
				registers with the new set, copies its journal there, switches, and retires the old set
				for good. A previous device still running on the old set stops itself the moment it sees
				the new set.
			</div>
			{slots.map((g, i) => (
				<Field key={i} label={`Guardian ${i + 1}`}>
					<input
						value={g}
						disabled={disabled || busy}
						spellCheck={false}
						data-testid={`rotate-guardian-${i}`}
						placeholder="<64-hex pubkey>@bolt8://<node id>@host:port, or <node id>@host:port"
						onChange={(e) => setSlots((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
					/>
					{g.trim() && !isNodeUri(g) && (
						<div className="wallet-meta" style={{ marginTop: 4 }}>
							{guardianEntryLabel(g)}
							{pinnedKeys.includes(g.trim().slice(0, 64)) ? ' (kept)' : ' (new)'}
						</div>
					)}
				</Field>
			))}
			<div style={{ marginBottom: 16 }}>
				<Button busy={busy} disabled={disabled || !changed} onClick={rotate} data-testid="rotate-guardians">
					Rotate guardians and retire the old set
				</Button>
			</div>
		</>
	);
}
