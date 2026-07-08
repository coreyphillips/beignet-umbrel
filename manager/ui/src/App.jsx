import { Link, Route, Routes } from 'react-router-dom';
import WalletsPage from './pages/WalletsPage.jsx';
import WalletPage from './pages/WalletPage.jsx';

export default function App() {
	return (
		<div className="app">
			<header className="topbar">
				<Link to="/" className="brand">
					<img src="/icon.svg" alt="Beignet" />
					<div>
						<h1>Beignet</h1>
						<div className="sub">Bitcoin &amp; Lightning wallets</div>
					</div>
				</Link>
			</header>
			<Routes>
				<Route path="/" element={<WalletsPage />} />
				<Route path="/w/:id" element={<WalletPage />} />
				<Route path="/w/:id/:tab" element={<WalletPage />} />
				<Route path="*" element={<WalletsPage />} />
			</Routes>
		</div>
	);
}
