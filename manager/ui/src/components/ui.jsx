import { Component, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { m, useMotionValue, useMotionValueEvent, useReducedMotion, useSpring } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { copy, fmtSats } from '../lib/format.js';
import { springs } from '../lib/motion.js';
import { useToast } from './Toast.jsx';
import { Icon } from './icons.jsx';
import { Reveal, Spinner } from './motion.jsx';

export { staggerContainer, staggerItem } from '../lib/motion.js';

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

/**
 * A labelled figure. Typographic by default: the label small above, the
 * number large below, the unit hanging off its baseline. `size` is sm, md
 * or lg; `tone` colours the number.
 */
export function Stat({ label, value, num, suffix = '', sub, size = 'md', tone = '', className = '' }) {
	const hasNum = num !== null && num !== undefined && Number.isFinite(Number(num));
	return (
		<div className={`stat ${size} ${tone} ${className}`}>
			<div className="stat-label">{label}</div>
			<div className="stat-value">
				{hasNum ? <AnimatedNumber value={num} /> : value ?? '-'}
				{hasNum && suffix.trim() && <span className="stat-unit">{suffix.trim()}</span>}
			</div>
			{sub && <div className="stat-sub">{sub}</div>}
		</div>
	);
}

/** A strip of stats on one inset, divided by hairlines. */
export function StatRow({ children, className = '' }) {
	return <div className={`stat-row ${className}`}>{children}</div>;
}

/**
 * `busy` disables the button and puts a spinner beside the label, which
 * stays, so the button keeps its width and its name. The spread comes first
 * so a caller's `disabled` can never re-enable a busy button.
 */
export function Button({ children, variant = 'ghost', busy, size = '', icon, className = '', ...props }) {
	return (
		<m.button
			whileTap={{ scale: 0.97 }}
			{...props}
			className={`btn ${variant} ${size} ${className}`}
			disabled={busy || props.disabled}
			aria-busy={busy || undefined}
		>
			{busy ? <Spinner /> : icon ? <Icon name={icon} size={14} /> : null}
			{children}
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
	// holds the "?", a clickable wallet card say; they end here.
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
					<m.div
						ref={pop}
						className="help-pop"
						aria-hidden
						initial={{ opacity: 0, scale: 0.96, y: -2 }}
						animate={{ opacity: place ? 1 : 0, scale: 1, y: 0 }}
						transition={{ duration: 0.14, ease: 'easeOut' }}
						style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
						onClick={(e) => e.stopPropagation()}
						onMouseDown={(e) => e.stopPropagation()}
					>
						{children}
					</m.div>,
					document.body
				)}
		</>
	);
}

export function Badge({ children, tone = 'muted', chip = false, title, className = '' }) {
	return (
		<span className={`badge ${tone} ${chip ? 'chip' : ''} ${className}`} title={title}>
			{children}
		</span>
	);
}

/** A status word with its dot. The raw code rides along in the title. */
export function StatusBadge({ label, tone = 'muted', raw, pulse }) {
	return (
		<span className={`badge ${tone}`} title={raw && raw !== label ? raw : undefined}>
			<span className={`dot ${pulse ? 'pulse' : ''}`} />
			{label}
		</span>
	);
}

/** A bare status dot, for a line that names the status itself. */
export function StatusDot({ tone = 'muted', pulse = false }) {
	return <span className={`status-dot ${tone} ${pulse ? 'pulse' : ''}`} aria-hidden="true" />;
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
export function AmountField({ label, hint, value, onChange, max, isMax, onMax, disabled }) {
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
export function Segmented({ id, options, value, onChange, label }) {
	return (
		<div className="pills" role="tablist" aria-label={label}>
			{options.map(([key, text, disabled, hint]) => (
				<button
					key={key}
					type="button"
					role="tab"
					aria-selected={value === key}
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
					{text}
				</button>
			))}
		</div>
	);
}

/** A selectable chip, for presets. `pressed` marks the one in force. */
export function Chip({ pressed = false, children, className = '', ...props }) {
	return (
		<button type="button" className={`chip ${className}`} aria-pressed={pressed} {...props}>
			{children}
		</button>
	);
}

export function Skeleton({ height = 60, width = '100%', className = '', style }) {
	return <div className={`skeleton ${className}`} style={{ height, width, ...style }} aria-hidden />;
}

/** A few placeholder rows while a list is still on its way. */
export function SkeletonRows({ rows = 3, height = 36 }) {
	return (
		<div className="skeleton-rows" aria-hidden>
			{Array.from({ length: rows }, (_, i) => (
				<Skeleton key={i} height={height} className="line" style={{ opacity: 1 - i * 0.2 }} />
			))}
		</div>
	);
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

/**
 * `label` shows something shorter than what gets copied, for places where the
 * full value would not fit (the wallet header shows a short node id but still
 * needs to hand over all 66 characters).
 */
export function CopyText({ value, label, mono = true, truncate = false }) {
	const toast = useToast();
	return (
		<button
			type="button"
			className={`copytext ${mono ? 'mono' : ''} ${truncate ? 'trunc' : ''}`}
			title="Copy"
			onClick={async () => toast((await copy(value)) ? 'Copied' : 'Copy failed', 'info')}
		>
			<span className="copytext-value">{label ?? value}</span>
			<Icon name="copy" size={13} className="copy-icon" strokeWidth={1.6} />
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

/** Key and value on one line, for status panels. */
export function KeyValue({ children, className = '' }) {
	return <div className={`kv ${className}`}>{children}</div>;
}

export function KeyValueRow({ label, help, sub, children }) {
	return (
		<div className="kv-row">
			<div className="kv-key">
				{label}
				{help && <Help>{help}</Help>}
			</div>
			<div className="kv-val">
				{children}
				{sub && <div className="kv-sub">{sub}</div>}
			</div>
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

class QRFallback extends Component {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	render() {
		return this.state.failed ? (
			<span className="field-hint">
				This address is too long for a QR code. Copy the address instead.
			</span>
		) : (
			this.props.children
		);
	}
}

export function QR({ value, size = 180 }) {
	if (!value) return null;
	return (
		<div className="qr">
			<QRFallback key={value}>
				<QRCodeSVG value={value} size={size} bgColor="#ffffff" fgColor="#111111" includeMargin />
			</QRFallback>
		</div>
	);
}

// Open dialogs, innermost last. Only the top one answers Escape and the
// backdrop, so a dialog opened over another closes alone.
const dialogStack = [];
const FOCUSABLE =
	'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function trapTab(e, box) {
	if (!box) return;
	const items = [...box.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === box);
	if (items.length === 0) {
		e.preventDefault();
		return;
	}
	const first = items[0];
	const last = items[items.length - 1];
	const active = document.activeElement;
	if (e.shiftKey && (active === first || active === box)) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && active === last) {
		e.preventDefault();
		first.focus();
	}
}

/**
 * Glass dialog that grows out of its trigger. Pass `origin` ({x, y} client
 * coords from the opening click) to make it fly in from that point; without
 * it, it scales from center. Render it conditionally inside an
 * <AnimatePresence> and it plays its exit on every way out: Escape, the
 * backdrop, the close button, or the parent dropping it after a save.
 *
 * It takes focus when it opens and hands it back when it closes, keeps Tab
 * inside, and locks the page behind it from scrolling.
 */
export function Modal({ title, help, onClose, children, wide = false, origin = null, foot = null }) {
	const id = useId();
	const token = useRef({});
	const box = useRef(null);
	const reduced = useReducedMotion();
	const isTop = () => dialogStack[dialogStack.length - 1] === token.current;

	useEffect(() => {
		const me = token.current;
		dialogStack.push(me);
		const previous = document.activeElement;
		const open = Number(document.body.dataset.dialogs || 0) + 1;
		document.body.dataset.dialogs = String(open);
		document.body.style.overflow = 'hidden';
		box.current?.focus?.({ preventScroll: true });
		return () => {
			const i = dialogStack.indexOf(me);
			if (i >= 0) dialogStack.splice(i, 1);
			const left = Number(document.body.dataset.dialogs || 1) - 1;
			if (left <= 0) {
				delete document.body.dataset.dialogs;
				document.body.style.overflow = '';
			} else {
				document.body.dataset.dialogs = String(left);
			}
			if (previous && typeof previous.focus === 'function' && document.contains(previous)) {
				previous.focus({ preventScroll: true });
			}
		};
	}, []);

	useEffect(() => {
		const onKey = (e) => {
			if (!isTop()) return;
			if (e.key === 'Escape') onClose();
			else if (e.key === 'Tab') trapTab(e, box.current);
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

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
			animate={{ opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.16 }}
			onMouseDown={(e) => e.target.classList.contains('modal') && isTop() && onClose()}
		>
			<m.div
				ref={box}
				className={`modal-box ${wide ? 'wide' : ''}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={id}
				tabIndex={-1}
				initial={{ opacity: 0, ...from }}
				animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
				exit={{ opacity: 0, x: from.x * 0.3, y: from.y * 0.3, scale: 0.92 }}
				transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 36 }}
			>
				<div className="modal-head">
					<h3 id={id}>
						{title}
						{help && <Help>{help}</Help>}
					</h3>
					<button type="button" className="btn subtle icon sm" aria-label="Close" onClick={onClose}>
						<Icon name="close" size={15} />
					</button>
				</div>
				<div className="modal-body">{children}</div>
				{foot && <div className="modal-foot">{foot}</div>}
			</m.div>
		</m.div>
	);
}

/** An empty state: a line, or a title with a hint and something to do. */
export function Empty({ title, children, actions, className = '' }) {
	return (
		<div className={`empty ${className}`}>
			{title && <div className="empty-title">{title}</div>}
			{children && <div className={title ? 'empty-hint' : undefined}>{children}</div>}
			{actions && <div className="empty-actions">{actions}</div>}
		</div>
	);
}

const NOTE_ICONS = { info: 'info', success: 'check', warn: 'alert', error: 'alert', muted: 'info' };

/**
 * A note in a tone: info, success, warn, error or muted. The legacy
 * `info-note` and `error-note` classes ride along so what looks at them still
 * finds them.
 */
export function Note({ tone = 'info', icon = true, children, className = '', ...rest }) {
	const legacy = tone === 'error' ? 'error-note' : tone === 'info' ? 'info-note' : '';
	return (
		<div
			className={`note ${tone} ${legacy} ${className}`}
			role={tone === 'error' ? 'alert' : undefined}
			{...rest}
		>
			{icon && <Icon name={NOTE_ICONS[tone] || 'info'} size={14} />}
			<div className="note-body">{children}</div>
		</div>
	);
}

export function ErrorNote({ error }) {
	if (!error) return null;
	// A refusal, announced as soon as it appears: it is the reason the thing the
	// reader was doing has stopped.
	return <Note tone="error">{error.message || String(error)}</Note>;
}

/** A heading inside a long form or dialog, with an optional one-line hint. */
export function Section({ title, help, hint, children, className = '' }) {
	return (
		<div className={`section ${className}`}>
			{title && (
				<div className="section-title">
					{title}
					{help && <Help>{help}</Help>}
				</div>
			)}
			{hint && <div className="section-hint">{hint}</div>}
			{children}
		</div>
	);
}

/**
 * A section that opens on request. `persist` keeps its fields mounted while
 * closed, for forms whose values must survive being folded away.
 */
export function Disclosure({ label, openLabel, defaultOpen = false, open: controlled, onToggle, persist = false, children, className = '' }) {
	const [own, setOwn] = useState(defaultOpen);
	const open = controlled ?? own;
	const id = useId();
	const toggle = () => {
		if (onToggle) onToggle(!open);
		if (controlled === undefined) setOwn(!open);
	};
	return (
		<div className={`disclosure ${className}`}>
			<button type="button" className="disclosure-btn" aria-expanded={open} aria-controls={id} onClick={toggle}>
				<Icon name="chevron" size={14} />
				{open && openLabel ? openLabel : label}
			</button>
			<Reveal open={open} persist={persist}>
				<div id={id} className="disclosure-body">
					{children}
				</div>
			</Reveal>
		</div>
	);
}

/**
 * An overflow menu behind a "⋯" button. `items` is a list of
 * { label, onSelect, danger?, disabled?, icon? } or the string 'sep'.
 * The menu is portalled so no scrolling box clips it, and every click inside
 * it stops where it is, so a menu on a clickable card never opens the card.
 */
export function Menu({ items, label = 'More', align = 'end', size = 'sm', className = '' }) {
	const trigger = useRef(null);
	const pop = useRef(null);
	const [open, setOpen] = useState(false);
	const [place, setPlace] = useState(null);

	useLayoutEffect(() => {
		if (!open) {
			setPlace(null);
			return;
		}
		const t = trigger.current.getBoundingClientRect();
		const p = pop.current.getBoundingClientRect();
		const [vw, vh] = [window.innerWidth, window.innerHeight];
		let left = align === 'end' ? t.right - p.width : t.left;
		left = Math.max(8, Math.min(left, vw - 8 - p.width));
		let top = t.bottom + 6;
		if (top + p.height > vh - 8) top = Math.max(8, t.top - 6 - p.height);
		setPlace({ left, top });
	}, [open, align]);

	useEffect(() => {
		if (!open) return undefined;
		const close = () => setOpen(false);
		const onKey = (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				close();
				trigger.current?.focus();
				return;
			}
			if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
			const items = [...(pop.current?.querySelectorAll('[role="menuitem"]:not([disabled])') || [])];
			if (!items.length) return;
			e.preventDefault();
			const i = items.indexOf(document.activeElement);
			let next = 0;
			if (e.key === 'ArrowDown') next = i < 0 ? 0 : (i + 1) % items.length;
			if (e.key === 'ArrowUp') next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
			if (e.key === 'End') next = items.length - 1;
			items[next].focus();
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

	useEffect(() => {
		if (open && place) pop.current?.querySelector('[role="menuitem"]:not([disabled])')?.focus();
	}, [open, place]);

	const stop = (e) => e.stopPropagation();

	return (
		<>
			<button
				ref={trigger}
				type="button"
				className={`btn subtle icon ${size} ${className}`}
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={(e) => {
					stop(e);
					setOpen((o) => !o);
				}}
				onMouseDown={stop}
			>
				<Icon name="more" size={16} strokeWidth={2.4} />
			</button>
			{open &&
				createPortal(
					<m.div
						ref={pop}
						className="menu"
						role="menu"
						initial={{ opacity: 0, scale: 0.96, y: -4 }}
						animate={{ opacity: place ? 1 : 0, scale: 1, y: 0 }}
						transition={springs.snappy}
						style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: 'hidden' }}
						onClick={stop}
						onMouseDown={stop}
					>
						{items.map((it, i) =>
							it === 'sep' ? (
								<div key={`sep-${i}`} className="menu-sep" role="separator" />
							) : (
								<button
									key={it.label}
									type="button"
									role="menuitem"
									className={`menu-item ${it.danger ? 'danger' : ''}`}
									disabled={it.disabled}
									onClick={(e) => {
										stop(e);
										setOpen(false);
										it.onSelect?.(e);
									}}
								>
									{it.icon && <Icon name={it.icon} size={14} />}
									{it.label}
								</button>
							)
						)}
					</m.div>,
					document.body
				)}
		</>
	);
}
