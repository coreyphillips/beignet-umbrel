'use strict';

function toBool(value, fallback = false) {
	if (value === undefined || value === '') return fallback;
	return String(value).toLowerCase() === 'true';
}

// Networks the beignet CLI understands (src/cli/types.ts). mainnet maps to
// beignet's internal "bitcoin" network downstream. Defined early so the
// default-network seed can be validated against it.
const SUPPORTED_NETWORKS = ['mainnet', 'testnet', 'regtest'];

// Umbrel may inject a network beignet cannot use (e.g. testnet4, signet). In
// that case fall back to mainnet so wallet creation still works; the user picks
// a supported network per wallet.
const injectedNetwork = process.env.DEFAULT_NETWORK || 'mainnet';
const defaultNetwork = SUPPORTED_NETWORKS.includes(injectedNetwork) ? injectedNetwork : 'mainnet';

// Umbrel injects its Tor. The SOCKS proxy (TOR_PROXY_IP:TOR_PROXY_PORT) is used
// for per-wallet outbound Lightning over Tor. The control port (29051, same IP,
// authed with TOR_PASSWORD) is used to publish an inbound hidden service.
const torProxyIp = process.env.TOR_PROXY_IP || '';
const torProxy =
	torProxyIp && process.env.TOR_PROXY_PORT ? `${torProxyIp}:${process.env.TOR_PROXY_PORT}` : '';
const torControlPort = 29051;

const config = {
	port: parseInt(process.env.PORT || '3000', 10),
	dataDir: process.env.DATA_DIR || '/data',
	torProxy,
	torProxyIp,
	torControlPort,
	torPassword: process.env.TOR_PASSWORD || '',
	defaultNetwork,
	defaultElectrum: {
		host: process.env.DEFAULT_ELECTRUM_HOST || '',
		port: parseInt(process.env.DEFAULT_ELECTRUM_PORT || '50001', 10),
		tls: toBool(process.env.DEFAULT_ELECTRUM_TLS, false)
	},
	childPortBase: parseInt(process.env.CHILD_PORT_BASE || '3101', 10),
	childPortMax: parseInt(process.env.CHILD_PORT_MAX || '3999', 10)
};

// One-click Electrum presets. The Umbrel Electrs/Fulcrum apps use fixed
// internal IPs and are reachable over Umbrel's shared app network even though
// this app declares no dependency on them.
const ELECTRUM_PRESETS = [
	{
		id: 'umbrel-electrs',
		label: 'Umbrel Electrs',
		host: '10.21.21.10',
		port: 50001,
		tls: false,
		note: 'Use if the Electrs app is installed on this Umbrel'
	},
	{
		id: 'umbrel-fulcrum',
		label: 'Umbrel Fulcrum',
		host: '10.21.21.200',
		port: 50002,
		tls: false,
		note: 'Use if the Fulcrum app is installed on this Umbrel'
	}
];

module.exports = { config, toBool, SUPPORTED_NETWORKS, ELECTRUM_PRESETS };
