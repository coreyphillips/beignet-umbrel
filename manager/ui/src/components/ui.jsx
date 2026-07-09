import { useEffect, useRef, useState } from 'react';
import { m, useMotionValue, useMotionValueEvent, useReducedMotion, useSpring } from 'motion/react';
import { QRCodeSVG } from 'qrcode.react';
import { copy } from '../lib/format.js';
import { useToast } from './Toast.jsx';

export function Card({ title, actions, children, className = '' }) {
	return (
		<div className={`card ${className}`}>
			{(title || actions) && (
				<div className="card-head">
					{title && <h3>{title}</h3>}
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

export function Field({ label, hint, children }) {
	return (
		<label className="field">
			{label && <span className="field-label">{label}</span>}
			{children}
			{hint && <span className="field-hint">{hint}</span>}
		</label>
	);
}

export function Badge({ children, tone = 'muted' }) {
	return <span className={`badge ${tone}`}>{children}</span>;
}

/**
 * Segmented pill control with a morphing active indicator. `id` scopes the
 * shared layoutId so multiple groups can coexist. `options` is [key, label][].
 */
export function Segmented({ id, options, value, onChange }) {
	return (
		<div className="pills">
			{options.map(([key, label]) => (
				<button
					key={key}
					type="button"
					className={`pill ${value === key ? 'active' : ''}`}
					onClick={() => onChange(key)}
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

export function CopyText({ value, mono = true, truncate = false }) {
	const toast = useToast();
	return (
		<button
			className={`copytext ${mono ? 'mono' : ''} ${truncate ? 'trunc' : ''}`}
			title="Copy"
			onClick={async () => toast((await copy(value)) ? 'Copied' : 'Copy failed', 'info')}
		>
			{value}
		</button>
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
export function Modal({ title, onClose, children, wide = false, origin = null }) {
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
					<h3>{title}</h3>
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
	return <div className="error-note">{error.message || String(error)}</div>;
}

export const staggerContainer = {
	hidden: {},
	show: { transition: { staggerChildren: 0.045 } }
};

export const staggerItem = {
	hidden: { opacity: 0, y: 10 },
	show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 34 } }
};
