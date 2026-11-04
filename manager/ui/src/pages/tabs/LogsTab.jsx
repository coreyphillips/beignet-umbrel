import { useEffect, useMemo, useRef, useState } from 'react';
import { manager } from '../../api.js';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card } from '../../components/ui.jsx';
import { copy, fmtDate, shortId } from '../../lib/format.js';
import { formatNodeError } from '../../lib/channel-open.js';
import {
	errorChannelId,
	groupNodeErrors,
	isWarningLogLine,
	nodeErrorKind
} from '../../lib/node-errors.js';

const POLL_MS = 3000;

// Lines worth colouring. The daemon prefixes its own level, and the manager
// prefixes the node errors it captures off the event stream.
// Anchored on the shapes the manager and daemon actually emit, rather than a
// bare "error", which would tint any line that merely mentions the word.
const ERROR_RE = /node error \[|\bERROR\b|\bfatal\b|\bfailed\b|exited code=/i;
const WARN_RE = /\bwarn(ing)?\b|\bunreachable\b|\bretry(ing)?\b|\brestarting\b/i;

function toneOf(line) {
	// Checked first: the manager echoes a peer warning or a turned-away payment
	// as "node error [...]", and neither is a failure of this wallet.
	if (isWarningLogLine(line)) return 'warn';
	if (ERROR_RE.test(line)) return 'error';
	if (WARN_RE.test(line)) return 'warn';
	return null;
}

// When it last happened, how often, and on which channel. Connection-level
// messages carry the all-zero channel id, which names no channel.
function ErrorMeta({ e }) {
	const channel = errorChannelId(e);
	return (
		<div className="wallet-meta" style={{ marginTop: 4 }}>
			{fmtDate(e.timestamp)} · <span className="mono">{e.code}</span>
			{e.count > 1 && ` · ${e.count} times since ${fmtDate(e.firstTimestamp)}`}
			{channel && (
				<>
					{' '}
					· channel <span className="mono">{shortId(channel)}</span>
				</>
			)}
		</div>
	);
}

export default function LogsTab({ id, tick }) {
	const toast = useToast();
	const [filter, setFilter] = useState('');
	const [follow, setFollow] = useState(true);
	const bodyRef = useRef(null);

	const { data: logs, refresh } = usePoll(
		() => manager.logs(id).catch(() => []),
		POLL_MS,
		[id, tick]
	);
	const { data: errors } = usePoll(
		() => manager.errors(id).catch(() => []),
		POLL_MS,
		[id, tick]
	);

	const lines = useMemo(() => logs || [], [logs]);
	const shown = useMemo(() => {
		if (!filter.trim()) return lines;
		const needle = filter.trim().toLowerCase();
		return lines.filter((l) => l.toLowerCase().includes(needle));
	}, [lines, filter]);

	// Keep the newest line in view while following, the way a terminal does.
	useEffect(() => {
		if (!follow || !bodyRef.current) return;
		bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
	}, [shown, follow]);

	const copyAll = async () => {
		const ok = await copy(shown.join('\n'));
		toast(ok ? `Copied ${shown.length} lines` : 'Could not copy', ok ? 'success' : 'error');
	};

	const download = () => {
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `beignet-${id.slice(0, 8)}.log`;
		a.click();
		URL.revokeObjectURL(url);
	};

	// Real failures go in red at the top. Peer warnings and payments a channel
	// turned away are not failures of this wallet, so they sit in a quiet card
	// under the log instead. Repeats fold into one entry each either way.
	const { recentErrors, recentWarnings } = useMemo(() => {
		const all = errors || [];
		return {
			recentErrors: groupNodeErrors(
				all.filter((e) => nodeErrorKind(e) === 'error'),
				15
			),
			recentWarnings: groupNodeErrors(
				all.filter((e) => nodeErrorKind(e) === 'warning'),
				10
			)
		};
	}, [errors]);

	return (
		<div>
			{recentErrors.length > 0 && (
				<Card title="Recent node errors">
					<div className="wallet-meta" style={{ marginBottom: 10 }}>
						Errors reported by the wallet daemon, newest first. Some come from the
						wallet itself and some are what a peer told us; each one says which.
					</div>
					{recentErrors.map((e, i) => (
						<div className="error-note" key={`${e.timestamp}-${i}`} style={{ marginBottom: 8 }}>
							<div>{formatNodeError(e)}</div>
							<ErrorMeta e={e} />
						</div>
					))}
				</Card>
			)}

			<Card
				title="Logs"
				actions={
					<>
						<Button className="sm" onClick={copyAll} disabled={shown.length === 0}>
							Copy
						</Button>
						<Button className="sm" onClick={download} disabled={lines.length === 0}>
							Download
						</Button>
						<Button className="sm" onClick={refresh}>
							Refresh
						</Button>
					</>
				}
			>
				<div className="log-toolbar">
					<input
						className="log-filter"
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						placeholder="Filter lines…"
					/>
					<label className="checkbox">
						<input
							type="checkbox"
							checked={follow}
							onChange={(e) => setFollow(e.target.checked)}
						/>
						Follow
					</label>
					<span className="wallet-meta">
						{shown.length}
						{filter.trim() && ` of ${lines.length}`} lines
					</span>
				</div>

				{shown.length === 0 ? (
					<div className="empty">
						{lines.length === 0
							? 'No output yet. The wallet daemon logs here as it runs.'
							: 'No lines match the filter.'}
					</div>
				) : (
					<div className="log-body" ref={bodyRef}>
						{shown.map((line, i) => {
							const tone = toneOf(line);
							return (
								<div key={i} className={`log-line${tone ? ` ${tone}` : ''}`}>
									{line}
								</div>
							);
						})}
					</div>
				)}
				<div className="field-hint" style={{ marginTop: 10 }}>
					The manager keeps the most recent output from this wallet's daemon. Copy it into a
					bug report if something is not working.
				</div>
			</Card>

			{recentWarnings.length > 0 && (
				<Card
					title="Warnings"
					help={
						'Worth knowing, but not failures of this wallet: warnings a peer sent us, ' +
						"and payments a channel turned away because they didn't fit. Most peer " +
						'warnings are about the network map (gossip). Neither kind changes your ' +
						'channels.'
					}
				>
					{recentWarnings.map((e, i) => (
						<div
							className="node-warning"
							key={`${e.timestamp}-${i}`}
							style={{ marginBottom: i === recentWarnings.length - 1 ? 0 : 12 }}
						>
							<div>{formatNodeError(e)}</div>
							<ErrorMeta e={e} />
						</div>
					))}
				</Card>
			)}
		</div>
	);
}
