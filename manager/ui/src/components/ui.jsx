import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { m, useMotionValue, useMotionValueEvent, useReducedMotion, useSpring } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { copy, fmtSats } from '../lib/format.js';
import { useToast } from './Toast.jsx';

export function Card({ title, help, actions, children, className = '' }) {
	return (
		<div className={`card ${className}`}>
			{(title || actions) && (
				<div className="card-head">
					{title && (
						<h3>
							{title}
							{help && <Help>{help}</Help>}
						</h3>
					)}
					{actions && <div className="card-actions">{actions}</div>}
				</div>
			)}
			{children}
		</div>
	);
}

/** Spring count-up for numeric values; renders plain text under reduced motion. */
export function AnimatedNumber({ value, suffix = '' }) {
	const reduced = useReducedMotion();
	const n = Number(value);
	const valid = Number.isFinite(n);
	const mv = useMotionValue(valid ? n : 0);
	const spring = useSpring(mv, { stiffness: 110, damping: 26 });
	const [display, setDisplay] = useState(valid ? n : 0);
	useEffect(() => {
		if (valid) mv.set(n);
	}, [n, valid, mv]);
	useMotionValueEvent(spring, 'change', (v) => setDisplay(v));
	if (!valid) return <>-</>;
	if (reduced) return <>{n.toLocaleString('en-US') + suffix}</>;
	return <>{Math.round(display).toLocaleString('en-US') + suffix}</>;
}

export function Stat({ label, value, num, suffix = '', sub }) {
	const hasNum = num !== null && num !== undefined && Number.isFinite(Number(num));
	return (
		<div className="stat">
			<div className="stat-label">{label}</div>
			<div className="stat-value">
				{hasNum ? <AnimatedNumber value={num} /> : value ?? '-'}
				{hasNum && suffix.trim() && <span className="stat-unit">{suffix.trim()}</span>}
			</div>
			{sub && <div className="stat-sub">{sub}</div>}
		</div>
	);
}

export function Button({ children, variant = 'ghost', busy, className = '', ...props }) {
	return (
		<m.button
			whileTap={{ scale: 0.97 }}
			className={`btn ${variant} ${className}`}
			disabled={busy || props.disabled}
			{...props}
		>
			{busy ? '…' : children}
		</m.button>
	);
}

export function Field({ label, hint, help, children }) {
	return (
		<label className="field">
			{label && (
				<span className="field-label">
					{label}
					{help && <Help>{help}</Help>}
				</span>
			)}
			{children}
			{hint && <span className="field-hint">{hint}</span>}
		</label>
	);
}

const HELP_EDGE = 12; // kept clear between the popover and the viewport edge
const HELP_GAP = 8; // between the "?" and the popover

/**
 * A "?" that keeps an explanation out of the way until it is asked for: hover
 * or focus shows it, a click or tap pins it (phones have no hover), and
 * Escape, a scroll or a press anywhere else puts it away.
 *
 * The trigger is a span with a button role rather than a <button>, because it
 * sits inside <label>s (checkbox rows, Field) and a <button> there becomes
 * what the label points at; its click is swallowed so it never ticks the
 * checkbox or focuses the input beside it. The text is always in the DOM in a
 * hidden span, which is what aria-describedby reads and what the render tests
 * see; hidden, it stays out of the label's accessible name. The visible copy
 * is portalled to <body> while open, since a modal's scrolling box would clip
 * it in place.
 */
export function Help({ children, label = 'More info' }) {
	const id = useId();
	const trigger = useRef(null);
	const pop = useRef(null);
	const [open, setOpen] = useState(false); // false | 'hover' | 'pinned'
	const [place, setPlace] = useState(null);

	useLayoutEffect(() => {
		if (!open) {
			setPlace(null);
			return;
		}
		const t = trigger.current.getBoundingClientRect();
		const p = pop.current.getBoundingClientRect();
		const [vw, vh] = [window.innerWidth, window.innerHeight];
		const left = Math.max(HELP_EDGE, Math.min(t.left + t.width / 2 - p.width / 2, vw - HELP_EDGE - p.width));
		const below = t.bottom + HELP_GAP;
		const above = t.top - HELP_GAP - p.height;
		setPlace({ left, top: below + p.height > vh - HELP_EDGE && above >= HELP_EDGE ? above : below });
	}, [open]);

	useEffect(() => {
		if (!open) return undefined;
		const close = () => setOpen(false);
		// Captured on window so it runs before a modal's own Escape handler,
		// and stopped there: Escape puts the explanation away, not the dialog.
		const onKey = (e) => {
			if (e.key !== 'Escape') return;
			e.stopPropagation();
			close();
		};
		const onPress = (e) => {
			if (trigger.current?.contains(e.target) || pop.current?.contains(e.target)) return;
			close();
		};
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('scroll', close, true);
		window.addEventListener('resize', close);
		document.addEventListener('pointerdown', onPress, true);
		return () => {
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('scroll', close, true);
			window.removeEventListener('resize', close);
			document.removeEventListener('pointerdown', onPress, true);
		};
	}, [open]);

	const toggle = () => setOpen((o) => (o === 'pinned' ? false : 'pinned'));
	// Events from the portalled popover still bubble through React to whatever
	// holds the "?", a clickable wallet row say; they end here.
	const swallow = (e) => {
		e.preventDefault();
		e.stopPropagation();
	};

	return (
		<>
			<span
				ref={trigger}
				role="button"
				tabIndex={0}
				className="help-btn"
				aria-label={label}
				aria-describedby={id}
				aria-expanded={!!open}
				onMouseEnter={() => setOpen((o) => o || 'hover')}
				onMouseLeave={() => setOpen((o) => (o === 'hover' ? false : o))}
				onFocus={() => setOpen((o) => o || 'hover')}
				onBlur={() => setOpen(false)}
				onClick={(e) => {
					swallow(e);
					toggle();
				}}
				onKeyDown={(e) => {
					if (e.key !== 'Enter' && e.key !== ' ') return;
					swallow(e);
					toggle();
				}}
			>
				?
			</span>
			<span id={id} hidden>
				{children}
			</span>
			{open &&
				createPortal(
					<div
						ref={pop}
						className="help-pop"
						aria-hidden
						style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
						onClick={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
					>
						{children}
					</div>,
					document.body
				)}
		</>
	);
}

export function Badge({ children, tone = 'muted' }) {
	return <span className={`badge ${tone}`}>{children}</span>;
}

/**
 * Fee rate entry: a field to type an exact sat/vB, and a slider for the rest.
 *
 * The slider is capped, never open-ended. A careless drag on an open-ended fee
 * slider hands the balance to miners, so the ceiling is a few times the fast
 * estimate, and the caller lowers it further when the balance cannot even cover
 * the fee at that rate. `value` empty means the wallet picks the rate itself, so
 * the slider tracks the estimate it would use until the user moves it.
 */
export function FeeField({ label, hint, value, onChange, rate, max }) {
	const ceiling = Math.max(1, Math.floor(Number(max) || 1));
	const current = Math.min(Math.max(1, parseInt(rate, 10) || 1), ceiling);
	// Two controls for one value, so the label names the one that is typed into
	// and the slider carries its own. Without either, a screen reader reaching
	// these hears "edit text" with nothing to say what it wants or in what unit.
	const id = useId();

	return (
		<div className="field">
			{label && (
				<label className="field-label" htmlFor={id}>
					{label}
				</label>
			)}
			<input
				id={id}
				className="amount-input"
				inputMode="numeric"
				value={value}
				placeholder="auto"
				onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
			/>
			<input
				type="range"
				className="amount-slider"
				aria-label={label ? `${label} slider` : 'Fee rate slider'}
				min={1}
				max={ceiling}
				step={1}
				value={current}
				onChange={(e) => onChange(e.target.value)}
			/>
			<div className="amount-scale">
				<span>1 sat/vB</span>
				<span>{current} sat/vB</span>
				<span>{ceiling} sat/vB</span>
			</div>
			{hint && <span className="field-hint">{hint}</span>}
		</div>
	);
}

/**
 * Sat amount entry: a field to type an exact number, a slider for everything
 * else, and a Max button.
 *
 * `max` is the largest amount that can actually be spent, already net of the
 * mining fee, so the slider cannot be dragged to a number the wallet will then
 * reject. The fee moves with the fee rate, which means `max` moves too, so a
 * caller holding Max re-derives the amount from it on every render rather than
 * freezing whatever it was when the button was pressed.
 *
 * Not wrapped in <Field>: that renders a <label> around its children, and a
 * label holding two inputs would hand every click on it to the first one. The
 * label here points at the field it names instead, which gets the same click
 * behaviour without claiming the button and the slider as well.
 */
export function AmountField({
	label,
	hint,
	value,
	onChange,
	max,
	isMax,
	onMax,
	disabled
}) {
	const ceiling = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : 0;
	const current = Math.min(parseInt(value, 10) || 0, ceiling);
	const pct = ceiling > 0 ? Math.round((current / ceiling) * 100) : 0;
	const usable = !disabled && ceiling > 0;
	const id = useId();

	return (
		<div className="field">
			{label && (
				<label className="field-label" htmlFor={id}>
					{label}
				</label>
			)}
			<div className="amount-row">
				<input
					id={id}
					className="amount-input"
					inputMode="numeric"
					value={value}
					disabled={disabled}
					// Digits only: a stray character would silently parse to NaN and
					// disable the submit button with nothing on screen to explain why.
					onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
				/>
				<button
					type="button"
					className={`btn sm ${isMax ? 'primary' : ''}`}
					onClick={onMax}
					disabled={!usable}
					aria-pressed={!!isMax}
				>
					Max
				</button>
			</div>
			<input
				type="range"
				className="amount-slider"
				aria-label={label ? `${label} slider` : 'Amount slider'}
				min={0}
				max={ceiling}
				step={1}
				value={current}
				disabled={!usable}
				onChange={(e) => onChange(e.target.value)}
			/>
			<div className="amount-scale">
				<span>0</span>
				<span>{pct}%</span>
				<span>{ceiling > 0 ? fmtSats(ceiling) : '-'}</span>
			</div>
			{hint && <span className="field-hint">{hint}</span>}
		</div>
	);
}

/**
 * Segmented pill control with a morphing active indicator. `id` scopes the
 * shared layoutId so multiple groups can coexist. `options` is
 * [key, label, disabled?, hint?][]; `hint` is shown as a tooltip when disabled.
 */
export function Segmented({ id, options, value, onChange }) {
	return (
		<div className="pills">
			{options.map(([key, label, disabled, hint]) => (
				<button
					key={key}
					type="button"
					disabled={disabled}
					title={disabled ? hint : undefined}
					className={`pill ${value === key ? 'active' : ''}`}
					onClick={() => !disabled && onChange(key)}
				>
					{value === key && (
						<m.span
							layoutId={`pill-${id}`}
							className="pill-indicator"
							transition={{ type: 'spring', stiffness: 500, damping: 40 }}
						/>
					)}
					{label}
				</button>
			))}
		</div>
	);
}

export function Skeleton({ height = 60, width = '100%', className = '', style }) {
	return <div className={`skeleton ${className}`} style={{ height, width, ...style }} aria-hidden />;
}

export function BalanceBar({ local, remote }) {
	const total = Number(local) + Number(remote) || 1;
	const localPct = (Number(local) / total) * 100;
	return (
		<div className="balbar" title={`local ${local} / remote ${remote}`}>
			<div className="balbar-local" style={{ width: `${localPct}%` }} />
		</div>
	);
}

/** The two overlapping sheets everyone recognises as "copy". */
function CopyIcon() {
	return (
		<svg
			className="copy-icon"
			viewBox="0 0 16 16"
			width="13"
			height="13"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.4"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden
		>
			<rect x="5.5" y="5.5" width="8" height="9" rx="1.5" />
			<path d="M10.5 5.5V3a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v6A1.5 1.5 0 0 0 4 10.5h1.5" />
		</svg>
	);
}

/**
 * `label` shows something shorter than what gets copied, for places where the
 * full value would not fit (the wallet header shows a short node id but still
 * needs to hand over all 66 characters).
 */
export function CopyText({ value, label, mono = true, truncate = false }) {
	const toast = useToast();
	return (
		<button
			className={`copytext ${mono ? 'mono' : ''} ${truncate ? 'trunc' : ''}`}
			title="Copy"
			onClick={async () => toast((await copy(value)) ? 'Copied' : 'Copy failed', 'info')}
		>
			<span className="copytext-value">{label ?? value}</span>
			<CopyIcon />
		</button>
	);
}

/** A label and its value, for the detail views. */
export function DetailRow({ label, children }) {
	return (
		<div className="detail-row">
			<div className="detail-label">{label}</div>
			<div className="detail-value">{children}</div>
		</div>
	);
}

/**
 * A link out to a block explorer. Renders nothing when there is nowhere to go,
 * which is the case on regtest: it is a chain only this machine can see.
 */
export function ExplorerLink({ url, children }) {
	if (!url) return null;
	return (
		<a className="explorer-link" href={url} target="_blank" rel="noreferrer noopener">
			{children} ↗
		</a>
	);
}

export function QR({ value, size = 180 }) {
	if (!value) return null;
	return (
		<div className="qr">
			<QRCodeSVG value={value} size={size} bgColor="#ffffff" fgColor="#111111" includeMargin />
		</div>
	);
}

const CLOSE_MS = 160;

/**
 * Glass modal that grows out of its trigger. Pass `origin` ({x, y} client
 * coords from the opening click) to make it fly in from that point; without
 * it, it scales from center. Closing plays a short exit before onClose fires,
 * so call sites can keep conditional rendering.
 */
export function Modal({ title, help, onClose, children, wide = false, origin = null }) {
	const [closing, setClosing] = useState(false);
	const closeTimer = useRef(null);
	const reduced = useReducedMotion();

	const close = () => {
		if (closing) return;
		if (reduced) return onClose();
		setClosing(true);
		closeTimer.current = setTimeout(onClose, CLOSE_MS);
	};

	useEffect(() => () => clearTimeout(closeTimer.current), []);
	useEffect(() => {
		const onKey = (e) => e.key === 'Escape' && close();
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [closing]);

	// Fly in from the trigger: offset toward the click point, damped so it
	// reads as growth rather than teleportation.
	const [vw, vh] = [window.innerWidth, window.innerHeight];
	const from = origin
		? { x: (origin.x - vw / 2) * 0.55, y: (origin.y - vh / 2) * 0.55, scale: 0.72 }
		: { x: 0, y: 0, scale: 0.92 };

	return (
		<m.div
			className="modal"
			initial={{ opacity: 0 }}
			animate={{ opacity: closing ? 0 : 1 }}
			transition={{ duration: 0.16 }}
			onMouseDown={(e) => e.target.classList.contains('modal') && close()}
		>
			<m.div
				className={`modal-box ${wide ? 'wide' : ''}`}
				initial={{ opacity: 0, ...from }}
				animate={
					closing
						? { opacity: 0, x: from.x * 0.4, y: from.y * 0.4, scale: 0.9 }
						: { opacity: 1, x: 0, y: 0, scale: 1 }
				}
				transition={
					closing
						? { duration: CLOSE_MS / 1000, ease: 'easeIn' }
						: { type: 'spring', stiffness: 420, damping: 36 }
				}
			>
				<div className="modal-head">
					<h3>
						{title}
						{help && <Help>{help}</Help>}
					</h3>
					<Button onClick={close}>Close</Button>
				</div>
				<div className="modal-body">{children}</div>
			</m.div>
		</m.div>
	);
}

export function Empty({ children }) {
	return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }) {
	if (!error) return null;
	// A refusal, announced as soon as it appears: it is the reason the thing the
	// reader was doing has stopped.
	return (
		<div className="error-note" role="alert">
			{error.message || String(error)}
		</div>
	);
}

export const staggerContainer = {
	hidden: {},
	show: { transition: { staggerChildren: 0.045 } }
};

export const staggerItem = {
	hidden: { opacity: 0, y: 10 },
	show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 34 } }
};
