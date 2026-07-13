import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes to manager/public, which the manager server serves.
// A dev proxy forwards API + per-wallet routes to a locally running manager.
// MANAGER_URL points it elsewhere when port 3000 is already taken.
const manager = process.env.MANAGER_URL || 'http://localhost:3000';

export default defineConfig({
	plugins: [react()],
	build: {
		outDir: '../public',
		emptyOutDir: true
	},
	server: {
		port: 5199,
		proxy: {
			'/api': manager,
			'/wallets': manager,
			'/vendor': manager
		}
	}
});
