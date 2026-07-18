import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '../../components/ui.jsx';

// A terminal for the wallet daemon's HTTP API. Commands are the API itself
// (`GET /channels`, `POST /invoice/create {"amountSats":1000}`), sent through
// the same authenticated proxy the rest of the dashboard uses, so nothing new
// is exposed and Umbrel's sign-on still fronts every request.

const INTRO = [
	'Type an API call and press Enter. The verb and path are the daemon\'s own REST API:',
	'',
	'  GET /health',
	'  GET /channels',
	'  POST /invoice/create {"amountSats": 1000, "description": "coffee"}',
	'  POST /invoice/decode {"bolt11": "lnbc…"}',
	'',
	'help shows this again · clear empties the screen · ↑/↓ recall history.',
	'The full route list is under "Raw API" in the sidebar.'
];

function parseCommand(raw) {
	const s = raw.trim();
	if (!s) return null;
	const lower = s.toLowerCase();
	if (lower === 'help' || lower === '?') return { kind: 'help' };
	if (lower === 'clear') return { kind: 'clear' };
	const m = s.match(/^(get|post)\s+(\/\S*)\s*(\{[\s\S]*\})?$/i);
	if (!m) {
		return {
			kind: 'error',
			message:
				'Commands look like: GET /path, or POST /path {"json": "body"}. Type help for examples.'
		};
	}
	const [, verb, path, bodyRaw] = m;
	let body;
	if (bodyRaw) {
		try {
			body = JSON.parse(bodyRaw);
		} catch (e) {
			return { kind: 'error', message: `Body is not valid JSON: ${e.message}` };
		}
	}
	return { kind: 'call', method: verb.toUpperCase(), path, body };
}

export default function ConsoleTab({ id, api }) {
	const [entries, setEntries] = useState([{ kind: 'intro' }]);
	const [input, setInput] = useState('');
	const [busy, setBusy] = useState(false);
	// Command history, newest last; histAt counts back from the end while
	// browsing with the arrow keys.
	const hist = useRef([]);
	const histAt = useRef(null);
	const bodyRef = useRef(null);
	const inputRef = useRef(null);

	useEffect(() => {
		if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
	}, [entries]);

	// A fresh console per wallet: replaying wallet A's output under wallet B
	// would misattribute every line.
	useEffect(() => {
		setEntries([{ kind: 'intro' }]);
		hist.current = [];
		histAt.current = null;
	}, [id]);

	const run = async () => {
		const raw = input;
		const cmd = parseCommand(raw);
		if (!cmd) return;
		setInput('');
		histAt.current = null;
		if (cmd.kind === 'clear') {
			setEntries([]);
			return;
		}
		hist.current.push(raw.trim());
		if (cmd.kind === 'help') {
			setEntries((es) => [...es, { kind: 'cmd', text: raw.trim() }, { kind: 'intro' }]);
			return;
		}
		if (cmd.kind === 'error') {
			setEntries((es) => [
				...es,
				{ kind: 'cmd', text: raw.trim() },
				{ kind: 'err', text: cmd.message }
			]);
			return;
		}
		setEntries((es) => [...es, { kind: 'cmd', text: raw.trim() }]);
		setBusy(true);
		try {
			const result =
				cmd.method === 'GET' ? await api.get(cmd.path) : await api.post(cmd.path, cmd.body);
			setEntries((es) => [...es, { kind: 'out', text: JSON.stringify(result, null, 2) }]);
		} catch (e) {
			setEntries((es) => [
				...es,
				{ kind: 'err', text: `${e.code ? `[${e.code}] ` : ''}${e.message}` }
			]);
		} finally {
			setBusy(false);
			inputRef.current?.focus();
		}
	};

	const onKeyDown = (e) => {
		if (e.key === 'Enter' && !busy) {
			e.preventDefault();
			run();
			return;
		}
		if (e.key === 'ArrowUp') {
			if (hist.current.length === 0) return;
			e.preventDefault();
			histAt.current =
				histAt.current === null
					? hist.current.length - 1
					: Math.max(0, histAt.current - 1);
			setInput(hist.current[histAt.current]);
			return;
		}
		if (e.key === 'ArrowDown') {
			if (histAt.current === null) return;
			e.preventDefault();
			histAt.current += 1;
			if (histAt.current >= hist.current.length) {
				histAt.current = null;
				setInput('');
			} else {
				setInput(hist.current[histAt.current]);
			}
		}
	};

	return (
		<Card
			title="Console"
			actions={
				<Button className="sm" onClick={() => setEntries([])} disabled={entries.length === 0}>
					Clear
				</Button>
			}
		>
			<div className="log-body console-body" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
				{entries.map((entry, i) => {
					if (entry.kind === 'intro') {
						return (
							<div key={i} className="console-intro">
								{INTRO.map((line, j) => (
									<div className="log-line" key={j}>
										{line || ' '}
									</div>
								))}
							</div>
						);
					}
					if (entry.kind === 'cmd') {
						return (
							<div key={i} className="log-line console-cmd">
								&gt; {entry.text}
							</div>
						);
					}
					return (
						<div key={i} className={`log-line${entry.kind === 'err' ? ' error' : ''}`}>
							{entry.text}
						</div>
					);
				})}
			</div>
			<div className="console-input-row">
				<span className="console-prompt mono">&gt;</span>
				<input
					ref={inputRef}
					className="console-input mono"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={onKeyDown}
					disabled={busy}
					placeholder='GET /health · POST /invoice/create {"amountSats":1000}'
					autoFocus
					spellCheck={false}
					autoComplete="off"
				/>
			</div>
			<div className="field-hint" style={{ marginTop: 10 }}>
				Talks straight to this wallet's daemon, so anything the API can do, this can do:
				including sending money. Commands the dashboard has no button for yet live here.
			</div>
		</Card>
	);
}
