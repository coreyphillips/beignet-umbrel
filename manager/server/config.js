'use strict';

function toBool(value, fallback = false) {
	if (value === undefined || value === '') return fallback;
	return String(value).toLowerCase() === 'true';
}

const config = {
	port: parseInt(process.env.PORT || '3000', 10),
	dataDir: process.env.DATA_DIR || '/data',
	defaultNetwork: process.env.DEFAULT_NETWORK || 'mainnet',
	defaultElectrum: {
		host: process.env.DEFAULT_ELECTRUM_HOST || '',
		port: parseInt(process.env.DEFAULT_ELECTRUM_PORT || '50001', 10),
		tls: toBool(process.env.DEFAULT_ELECTRUM_TLS, false)
	},
	childPortBase: parseInt(process.env.CHILD_PORT_BASE || '3101', 10),
	childPortMax: parseInt(process.env.CHILD_PORT_MAX || '3999', 10)
};

// Networks the beignet CLI understands (src/cli/types.ts). mainnet maps to
// beignet's internal "bitcoin" network downstream.
const SUPPORTED_NETWORKS = ['mainnet', 'testnet', 'regtest'];

module.exports = { config, toBool, SUPPORTED_NETWORKS };
