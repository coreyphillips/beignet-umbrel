import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Icon } from './icons.jsx';

const ToastCtx = createContext(() => {});
const MAX_VISIBLE = 3;
const DEDUPE_MS = 2000;

const ICONS = { info: 'info', success: 'check', error: 'alert' };

export function ToastProvider({ children }) {
	const [toasts, setToasts] = useState([]);
	const timers = useRef(new Map());
	const recent = useRef(new Map()); // message+type -> last pushed at

	const remove = useCallback((id) => {
		clearTimeout(timers.current.get(id));
		timers.current.delete(id);
		setToasts((t) => t.filter((x) => x.id !== id));
	}, []);

	const arm = useCallback(
		(id, duration) => {
			clearTimeout(timers.current.get(id));
			timers.current.set(
				id,
				setTimeout(() => remove(id), duration)
			);
		},
		[remove]
	);

	// `duration` exists for the toasts that carry news rather than confirmation.
	// "Sent" confirms a click and can go quickly; money arriving is news the
	// reader did nothing to cause, and it should survive a glance away.
	const push = useCallback(
		(message, type = 'info', { duration = 3600 } = {}) => {
			const key = `${type}:${message}`;
			const now = Date.now();
			// The same line twice in two seconds is one line.
			if (now - (recent.current.get(key) || 0) < DEDUPE_MS) return;
			recent.current.set(key, now);
			const id = Math.random().toString(36).slice(2);
			setToasts((t) => {
				const next = [...t, { id, message, type, duration }];
				// Only the newest few stay on screen; older ones leave early.
				while (next.length > MAX_VISIBLE) {
					const gone = next.shift();
					clearTimeout(timers.current.get(gone.id));
					timers.current.delete(gone.id);
				}
				return next;
			});
			arm(id, duration);
		},
		[arm]
	);

	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div className="toast-wrap" aria-live="polite" aria-relevant="additions">
				<AnimatePresence>
					{toasts.map((t) => (
						<m.div
							key={t.id}
							layout
							className={`toast ${t.type}`}
							initial={{ opacity: 0, y: 16, scale: 0.95 }}
							animate={{ opacity: 1, y: 0, scale: 1 }}
							exit={{ opacity: 0, y: 8, scale: 0.95 }}
							transition={{ type: 'spring', stiffness: 480, damping: 38 }}
							onClick={() => remove(t.id)}
							onMouseEnter={() => clearTimeout(timers.current.get(t.id))}
							onMouseLeave={() => arm(t.id, Math.max(1500, t.duration / 2))}
							title="Dismiss"
						>
							<span className="toast-icon">
								<Icon name={ICONS[t.type] || 'info'} size={12} strokeWidth={2.2} />
							</span>
							<span>{t.message}</span>
						</m.div>
					))}
				</AnimatePresence>
			</div>
		</ToastCtx.Provider>
	);
}

export function useToast() {
	return useContext(ToastCtx);
}
