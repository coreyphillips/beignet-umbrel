import { createContext, useCallback, useContext, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
	const [toasts, setToasts] = useState([]);

	// `duration` exists for the toasts that carry news rather than confirmation.
	// "Sent" confirms a click and can go quickly; money arriving is news the
	// reader did nothing to cause, and it should survive a glance away.
	const push = useCallback((message, type = 'info', { duration = 3600 } = {}) => {
		const id = Math.random().toString(36).slice(2);
		setToasts((t) => [...t, { id, message, type }]);
		setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duration);
	}, []);

	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div className="toast-wrap">
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
						>
							{t.message}
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
