import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes to manager/public, which the manager server serves.
// A dev proxy forwards API + per-wallet routes to a locally running manager.
export default defineConfig({
	plugins: [react()],
	build: {
		outDir: '../public',
		emptyOutDir: true
	},
	server: {
		port: 5199,
		proxy: {
			'/api': 'http://localhost:3000',
			'/wallets': 'http://localhost:3000',
			'/vendor': 'http://localhost:3000'
		}
	}
});
