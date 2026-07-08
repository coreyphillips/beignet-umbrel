import { useEffect } from 'react';
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

export function Stat({ label, value, sub }) {
	return (
		<div className="stat">
			<div className="stat-label">{label}</div>
			<div className="stat-value">{value}</div>
			{sub && <div className="stat-sub">{sub}</div>}
		</div>
	);
}

export function Button({ children, variant = 'ghost', busy, className = '', ...props }) {
	return (
		<button className={`btn ${variant} ${className}`} disabled={busy || props.disabled} {...props}>
			{busy ? '…' : children}
		</button>
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

export function Modal({ title, onClose, children, wide = false }) {
	useEffect(() => {
		const onKey = (e) => e.key === 'Escape' && onClose();
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);
	return (
		<div className="modal" onMouseDown={(e) => e.target.classList.contains('modal') && onClose()}>
			<div className={`modal-box ${wide ? 'wide' : ''}`}>
				<div className="modal-head">
					<h3>{title}</h3>
					<button className="btn ghost" onClick={onClose}>
						Close
					</button>
				</div>
				<div className="modal-body">{children}</div>
			</div>
		</div>
	);
}

export function Empty({ children }) {
	return <div className="empty">{children}</div>;
}

export function ErrorNote({ error }) {
	if (!error) return null;
	return <div className="error-note">{error.message || String(error)}</div>;
}
