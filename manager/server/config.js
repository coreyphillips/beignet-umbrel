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
	// The app release this image was built from, baked in by the build (the
	// git tag) since nothing inside the container carries umbrel-app.yml. Null
	// outside a release build; a backup archive records it either way.
	appVersion: process.env.APP_VERSION || null,
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
	childPortMax: parseInt(process.env.CHILD_PORT_MAX || '3999', 10),
	// The host port the compose file publishes the first wallet's Lightning
	// listen port at (umbrel #193): the container's 9101 to 9130 answer on the
	// host at this base and the twenty-nine ports after it. Unset outside
	// Docker, where a listen port is reachable as itself.
	publicPortBase: process.env.PUBLIC_PORT_BASE ? parseInt(process.env.PUBLIC_PORT_BASE, 10) || null : null
};

// One-click Electrum presets. The Umbrel Electrs/Fulcrum apps use fixed
// internal IPs and are reachable over Umbrel's shared app network even though
// this app declares no dependency on them. A preset host may also be a
// container name, which Docker's DNS resolves on that network. The dashboard
// probes every preset (electrum-probe.js) and shows one that is not installed
// as not found, so a preset costs nothing when its app is absent.
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
	},
	{
		id: 'umbrel-rbitcoin',
		label: 'Umbrel rbitcoin',
		// The pinned container name of the rbitcoin-node app from the
		// rbitcoin store (coreyphillips/rbitcoin-umbrel), resolved by
		// Docker's DNS on the shared network. No fixed IP: that app pins
		// names, not addresses (see its docker-compose.yml). Until app
		// 0.8.99-2 it was this store's beignet-rbitcoin app, at
		// beignet-rbitcoin_node_1; wallets saved with that host keep it.
		host: 'rbitcoin-node_node_1',
		port: 50001,
		tls: false,
		// That app runs mainnet and nothing else, so the dashboard offers
		// this preset only when the wallet (or the default) is on mainnet.
		// A preset without `networks` is offered for every network.
		networks: ['mainnet'],
		note: 'Use if the rbitcoin app (rbitcoin store) is installed'
	}
];

// Public Electrum servers, offered in place of the presets when none of them
// answers on the wallet's chain. Each runs on someone else's machine, which
// learns the wallet's addresses and this Umbrel's IP address, so the dashboard
// says so and offers them only then. Every one is TLS with a certificate a
// public authority signed for its name, so a pick turns verification on
// (`tlsVerify`) where the engine supports it. The dashboard probes them only
// while it shows them, for the wallet's chain alone.
const PUBLIC_ELECTRUM_SERVERS = [
	{
		id: 'public-bitkit',
		label: 'Bitkit',
		// What bitkit-android uses for mainnet (Env.kt). It does not offer
		// server.features and hangs up when asked; electrum-probe.js reads the
		// chain from block 0 instead.
		host: 'bitkit.to',
		port: 9999,
		tls: true,
		tlsVerify: true,
		networks: ['mainnet'],
		note: "Synonym's server, the one the Bitkit wallet uses"
	},
	{
		id: 'public-bluewallet',
		label: 'BlueWallet',
		// BlueWallet's default is electrum1.bluewallet.io, which presents
		// electrum2's certificate and so fails verification. electrum2 is the
		// same operator under the name its certificate carries.
		host: 'electrum2.bluewallet.io',
		port: 443,
		tls: true,
		tlsVerify: true,
		networks: ['mainnet'],
		note: "BlueWallet's server"
	},
	{
		id: 'public-blockstream',
		label: 'Blockstream',
		host: 'electrum.blockstream.info',
		port: 50002,
		tls: true,
		tlsVerify: true,
		networks: ['mainnet'],
		note: "Blockstream's server"
	},
	{
		id: 'public-acinq',
		label: 'ACINQ',
		host: 'electrum.acinq.co',
		port: 50002,
		tls: true,
		tlsVerify: true,
		networks: ['mainnet'],
		note: "ACINQ's server, one of BlueWallet's defaults"
	},
	{
		id: 'public-blockstream-testnet',
		label: 'Blockstream testnet',
		// Also what bitkit-android uses for testnet.
		host: 'electrum.blockstream.info',
		port: 60002,
		tls: true,
		tlsVerify: true,
		networks: ['testnet'],
		note: "Blockstream's testnet server, the one Bitkit uses for testnet"
	},
	{
		id: 'public-bitkit-regtest',
		label: 'Bitkit regtest',
		// bitkit-android's staging regtest (Env.kt). The same chain as the
		// engine's own regtest default, 34.65.252.32:18483, over TLS.
		host: 'electrs.bitkit.stag0.blocktank.to',
		port: 9999,
		tls: true,
		tlsVerify: true,
		networks: ['regtest'],
		note: "Synonym's staging regtest server, the one Bitkit's regtest builds use"
	}
];

/** The public servers for `network`, or every one for a network this app does not know. */
function publicElectrumServers(network) {
	if (!SUPPORTED_NETWORKS.includes(network)) return PUBLIC_ELECTRUM_SERVERS;
	return PUBLIC_ELECTRUM_SERVERS.filter((s) => s.networks.includes(network));
}

// Taproot Assets universe servers (docs/ASSETS.md): where a wallet fetches
// the proofs of assets sent to it and leaves the proofs of assets it sends.
// An asset address names its proof courier as a universerpc:// address,
// which is gRPC; this app speaks the same server's REST gateway, so each
// entry pairs the two. The first entry for a network is the one new
// addresses name. Each is someone else's machine: it learns which assets a
// wallet asks about and this Umbrel's IP address, unless the wallet's
// network mode is Tor.
const PUBLIC_UNIVERSE_SERVERS = [
	{
		id: 'lightning-labs',
		label: 'Lightning Labs',
		courier: 'universerpc://universe.lightning.finance:10029',
		rest: 'https://universe.lightning.finance',
		networks: ['mainnet'],
		note: "Lightning Labs' universe, the default of their own daemon"
	},
	// A wallet's `testnet` is testnet3 or testnet4, whichever its Electrum
	// server is on, and each has a universe of its own. `chain` says which
	// one a server is for; a wallet's assets host finds out which chain it
	// is on and uses that server (assets-host/chain.js).
	{
		id: 'lightning-labs-testnet',
		label: 'Lightning Labs testnet3',
		courier: 'universerpc://testnet.universe.lightning.finance:10029',
		rest: 'https://testnet.universe.lightning.finance',
		networks: ['testnet'],
		chain: 'testnet3',
		note: "Lightning Labs' testnet3 universe"
	},
	{
		id: 'lightning-labs-testnet4',
		label: 'Lightning Labs testnet4',
		courier: 'universerpc://testnet4.universe.lightning.finance:443',
		rest: 'https://testnet4.universe.lightning.finance',
		networks: ['testnet'],
		chain: 'testnet4',
		note: "Lightning Labs' testnet4 universe"
	}
];

/**
 * A universe for regtest, which has no public one: the operator names a
 * local tapd's courier address and REST gateway. Both or neither.
 */
function regtestUniverse(env = process.env) {
	const courier = String(env.ASSETS_REGTEST_UNIVERSE_COURIER || '').trim();
	const rest = String(env.ASSETS_REGTEST_UNIVERSE_REST || '').trim();
	if (!courier || !rest) return null;
	// A local tapd serves its gateway on a certificate it signed itself;
	// ASSETS_REGTEST_UNIVERSE_CA names the file to trust for it.
	const ca = String(env.ASSETS_REGTEST_UNIVERSE_CA || '').trim();
	return {
		id: 'regtest',
		label: 'Local universe',
		courier,
		rest,
		networks: ['regtest'],
		note: 'Set by ASSETS_REGTEST_UNIVERSE_COURIER',
		...(ca ? { ca } : {})
	};
}

/** The universe servers offered for `network`, the default first. */
function publicUniverseServers(network, env = process.env) {
	const local = regtestUniverse(env);
	return [...PUBLIC_UNIVERSE_SERVERS, ...(local ? [local] : [])].filter((s) => s.networks.includes(network));
}

module.exports = {
	config,
	toBool,
	SUPPORTED_NETWORKS,
	ELECTRUM_PRESETS,
	PUBLIC_ELECTRUM_SERVERS,
	publicElectrumServers,
	PUBLIC_UNIVERSE_SERVERS,
	publicUniverseServers
};
