import { createContext, useCallback, useContext, useState } from 'react';

const ToastCtx = createContext(() => {});

export function ToastProvider({ children }) {
	const [toasts, setToasts] = useState([]);

	const push = useCallback((message, type = 'info') => {
		const id = Math.random().toString(36).slice(2);
		setToasts((t) => [...t, { id, message, type }]);
		setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
	}, []);

	return (
		<ToastCtx.Provider value={push}>
			{children}
			<div className="toast-wrap">
				{toasts.map((t) => (
					<div key={t.id} className={`toast ${t.type}`}>
						{t.message}
					</div>
				))}
			</div>
		</ToastCtx.Provider>
	);
}

export function useToast() {
	return useContext(ToastCtx);
}
