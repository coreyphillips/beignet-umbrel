import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { manager } from './api.js';
import { useToast } from './components/Toast.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import WalletsPage from './pages/WalletsPage.jsx';
import WalletPage from './pages/WalletPage.jsx';

const SPOT_SURFACES = '.card, .wallet, .stat, .whead, .wnav';

/** Tracks the cursor over glass surfaces so their spotlight bloom follows it. */
function useSpotlight() {
	useEffect(() => {
		let raf = 0;
		const onMove = (e) => {
			if (raf) return;
			raf = requestAnimationFrame(() => {
				raf = 0;
				// Nested surfaces (a .stat inside a .card) each get their own glow.
				let el = e.target instanceof Element ? e.target.closest(SPOT_SURFACES) : null;
				while (el) {
					const r = el.getBoundingClientRect();
					el.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
					el.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
					el = el.parentElement ? el.parentElement.closest(SPOT_SURFACES) : null;
				}
			});
		};
		window.addEventListener('pointermove', onMove, { passive: true });
		return () => {
			window.removeEventListener('pointermove', onMove);
			cancelAnimationFrame(raf);
		};
	}, []);
}

function ThemeToggle() {
	const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		localStorage.setItem('beignet-theme', theme);
	}, [theme]);
	const dark = theme === 'dark';
	return (
		<button
			type="button"
			className="theme-toggle"
			title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
			aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
			onClick={() => setTheme(dark ? 'light' : 'dark')}
		>
			{dark ? '☾' : '☀'}
		</button>
	);
}

export default function App() {
	const location = useLocation();
	const toast = useToast();
	useSpotlight();
	const [settings, setSettings] = useState(null); // { config, origin } | null
	// Key pages on `/w/:id` (not the tab segment) so switching tabs animates
	// inside WalletPage instead of remounting the whole page.
	const pageKey = location.pathname.split('/').slice(0, 3).join('/') || '/';

	const openSettings = async (e) => {
		const origin = { x: e.clientX, y: e.clientY };
		try {
			const config = await manager.config();
			setSettings({ config, origin });
		} catch (err) {
			toast(err.message, 'error');
		}
	};

	return (
		<div className="app">
			<div className="ambient" aria-hidden />
			<header className="topbar">
				<Link to="/" className="brand">
					<img src="/icon.svg" alt="Beignet" />
					<div>
						<h1>Beignet</h1>
						<div className="sub">Bitcoin &amp; Lightning wallets</div>
					</div>
				</Link>
				<div className="topbar-right">
					<button
						type="button"
						className="icon-btn"
						title="Settings"
						aria-label="Settings"
						onClick={openSettings}
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
							<circle cx="12" cy="12" r="3" />
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
						</svg>
					</button>
					<ThemeToggle />
				</div>
			</header>
			{settings && (
				<SettingsModal
					config={settings.config}
					origin={settings.origin}
					onClose={() => setSettings(null)}
					onSaved={(c) => {
						setSettings(null);
						toast('Settings saved', 'success');
						// Let any mounted page (WalletsPage) refresh its copy of config.
						window.dispatchEvent(new CustomEvent('beignet:config', { detail: c }));
					}}
				/>
			)}
			<AnimatePresence mode="popLayout" initial={false}>
				{/* Opacity-only at the page root: transforms here would break the
				    sticky wnav and the cross-page layoutId morphs. */}
				<m.div
					key={pageKey}
					style={{ width: '100%' }}
					initial={{ opacity: 0 }}
					animate={{ opacity: 1 }}
					exit={{ opacity: 0 }}
					transition={{ duration: 0.22, ease: 'easeOut' }}
				>
					<Routes location={location}>
						<Route path="/" element={<WalletsPage />} />
						<Route path="/w/:id" element={<WalletPage />} />
						<Route path="/w/:id/:tab" element={<WalletPage />} />
						<Route path="*" element={<WalletsPage />} />
					</Routes>
				</m.div>
			</AnimatePresence>
		</div>
	);
}
