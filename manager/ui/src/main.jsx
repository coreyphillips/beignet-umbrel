import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';
import App from './App.jsx';
import { ToastProvider } from './components/Toast.jsx';
import '@fontsource-variable/inter';
import './styles/index.css';

// Apply the theme before first paint so there's no flash of the wrong one.
// Priority: ?theme= param (also persisted) > saved choice > OS preference.
const themeParam = new URLSearchParams(window.location.search).get('theme');
if (themeParam === 'light' || themeParam === 'dark') {
	localStorage.setItem('beignet-theme', themeParam);
}
document.documentElement.dataset.theme =
	localStorage.getItem('beignet-theme') ||
	(window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');

// domMax (not domAnimation) because layoutId shared-element morphs need the
// layout-animation feature set. `strict` keeps us on the slim `m.` components.
createRoot(document.getElementById('root')).render(
	<React.StrictMode>
		<BrowserRouter>
			<LazyMotion features={domMax} strict>
				<MotionConfig
					reducedMotion="user"
					transition={{ type: 'spring', stiffness: 380, damping: 34 }}
				>
					<ToastProvider>
						<App />
					</ToastProvider>
				</MotionConfig>
			</LazyMotion>
		</BrowserRouter>
	</React.StrictMode>
);
