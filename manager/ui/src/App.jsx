import { useEffect, useState } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { manager } from './api.js';
import { BACKUP_EVENT } from './lib/backup.js';
import { useToast } from './components/Toast.jsx';
import { Icon } from './components/icons.jsx';
import { Spinner } from './components/motion.jsx';
import BackupModal from './components/BackupModal.jsx';
import SettingsModal from './components/SettingsModal.jsx';
import WalletsPage from './pages/WalletsPage.jsx';
import WalletPage from './pages/WalletPage.jsx';

function ThemeToggle() {
	const [theme, setTheme] = useState(document.documentElement.dataset.theme || 'dark');
	useEffect(() => {
		document.documentElement.dataset.theme = theme;
		localStorage.setItem('beignet-theme', theme);
	}, [theme]);
	const dark = theme === 'dark';
	const flip = () => {
		// Every colour on the page crosses over together instead of snapping.
		const html = document.documentElement;
		html.classList.add('theme-fade');
		setTheme(dark ? 'light' : 'dark');
		setTimeout(() => html.classList.remove('theme-fade'), 320);
	};
	return (
		<button
			type="button"
			className="theme-toggle"
			title={dark ? 'Switch to light theme' : 'Switch to dark theme'}
			aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
			onClick={flip}
		>
			<AnimatePresence mode="wait" initial={false}>
				<m.span
					key={theme}
					style={{ display: 'inline-grid' }}
					initial={{ rotate: -50, opacity: 0, scale: 0.6 }}
					animate={{ rotate: 0, opacity: 1, scale: 1 }}
					exit={{ rotate: 50, opacity: 0, scale: 0.6 }}
					transition={{ duration: 0.18, ease: 'easeOut' }}
				>
					<Icon name={dark ? 'moon' : 'sun'} size={15} />
				</m.span>
			</AnimatePresence>
		</button>
	);
}

export default function App() {
	const location = useLocation();
	const toast = useToast();
	const [settings, setSettings] = useState(null); // { config, origin } | null
	const [loadingSettings, setLoadingSettings] = useState(false);
	// The backup dialog: asked for by the Settings dialog and by the empty
	// first-run screen, so it is held here rather than in either of them.
	const [backup, setBackup] = useState(null); // { mode, origin } | null
	// Key pages on `/w/:id` (not the tab segment) so switching tabs animates
	// inside WalletPage instead of remounting the whole page.
	const pageKey = location.pathname.split('/').slice(0, 3).join('/') || '/';

	useEffect(() => {
		const onBackup = (e) => setBackup({ mode: e.detail?.mode || 'export', origin: e.detail?.origin });
		window.addEventListener(BACKUP_EVENT, onBackup);
		return () => window.removeEventListener(BACKUP_EVENT, onBackup);
	}, []);

	const openSettings = async (e) => {
		const origin = { x: e.clientX, y: e.clientY };
		setLoadingSettings(true);
		try {
			const config = await manager.config();
			setSettings({ config, origin });
		} catch (err) {
			toast(err.message, 'error');
		} finally {
			setLoadingSettings(false);
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
						aria-busy={loadingSettings || undefined}
						disabled={loadingSettings}
						onClick={openSettings}
					>
						{loadingSettings ? <Spinner /> : <Icon name="settings" size={16} />}
					</button>
					<ThemeToggle />
				</div>
			</header>
			<AnimatePresence>
				{settings && (
					<SettingsModal
						key="settings"
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
				{backup && (
					<BackupModal
						key="backup"
						mode={backup.mode}
						origin={backup.origin}
						onClose={() => setBackup(null)}
						onRestored={() => {
							// The Settings dialog this may have been opened over is
							// holding the defaults the restore just replaced; saving
							// it now would put them straight back.
							setSettings(null);
							toast('Wallets restored. Start each one when you are ready.', 'success');
						}}
					/>
				)}
			</AnimatePresence>
			<AnimatePresence mode="popLayout" initial={false}>
				{/* Opacity-only at the page root: transforms here would break the
				    cross-page layoutId morphs. */}
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
