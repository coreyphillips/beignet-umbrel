'use strict';

/**
 * Per-wallet network mode (umbrel #193): how a wallet dials its peers and
 * which addresses it announces, the choice Umbrel's LND app calls Tor,
 * Clearnet and Hybrid.
 *
 *   mode       clearnet peers   .onion peers   announced
 *   tor        over Tor         over Tor       the onion
 *   clearnet   direct           over Tor       the public address
 *   hybrid     direct           over Tor       both
 *
 * Pure rules, so the record model and the daemon env can be held in tests
 * without a manager. The engine's half is the proxy scoped to .onion hosts
 * (BEIGNET_TOR_PROXY_ONION_ONLY, beignet #963, engine 0.22.0).
 */
const net = require('net');

const MODES = ['tor', 'clearnet', 'hybrid'];
const DEFAULT_MODE = 'hybrid';

function httpError(status, code, message) {
	const err = new Error(message);
	err.statusCode = status;
	err.code = code;
	return err;
}

/**
 * The mode a record runs in. Records written before the field existed carry
 * `tor` (outbound over Tor, on or off): Tor on reads as the tor mode, Tor off
 * as hybrid, which keeps the direct dials those wallets always made and
 * gives their .onion peers the app's Tor, which the old flag never passed.
 */
function networkMode(rec) {
	if (rec && MODES.includes(rec.networkMode)) return rec.networkMode;
	return rec && rec.tor ? 'tor' : DEFAULT_MODE;
}

/** The mode a request asks for: the field, else the legacy flag, else `fallback`. */
function requestedMode({ networkMode: mode, tor } = {}, fallback) {
	if (mode !== undefined && mode !== null) return String(mode);
	if (tor !== undefined) return tor ? 'tor' : DEFAULT_MODE;
	return fallback;
}

function usesOnion(mode) {
	return mode === 'tor' || mode === 'hybrid';
}

function usesPublic(mode) {
	return mode === 'clearnet' || mode === 'hybrid';
}

// The engine's rule for a DNS name in a node_announcement (parseAnnouncedAddress
// in beignet's gossip messages): lowercase letters, digits, dots and hyphens,
// neither first nor last a dot or hyphen, at most 255 characters.
const DNS_NAME_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const DOTTED_QUAD_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The public host a wallet announces, held to what the engine accepts,
 * because a bad entry in BEIGNET_ANNOUNCE_ADDRESSES fails the daemon's boot
 * and a wallet that cannot start is worse than a refused edit. Blank means
 * none. IPv6 is kept bare and bracketed where it meets a port (hostForUri).
 * The port is never part of it: the window the app publishes fixes it.
 */
function normalizePublicHost(input) {
	const raw = input === undefined || input === null ? '' : String(input).trim();
	if (!raw) return '';
	const bad = (why) => httpError(400, 'BAD_PUBLIC_HOST', why);
	if (/\s/.test(raw)) throw bad('A public address cannot contain spaces.');
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) throw bad('Enter a host, not a URL: leave off the scheme.');
	if (raw.includes('/')) throw bad('Enter a host only, with no path.');
	if (raw.includes('@')) throw bad('Enter a host only: the node id is added for you.');
	let host = raw;
	if (raw.startsWith('[')) {
		const end = raw.indexOf(']');
		if (end === -1) throw bad('An IPv6 address in brackets needs its closing bracket.');
		if (end !== raw.length - 1) throw bad('Enter the host only: the port is fixed by the app.');
		host = raw.slice(1, end);
		if (!net.isIPv6(host)) throw bad(`"${host}" is not an IPv6 address.`);
		return host.toLowerCase();
	}
	if (net.isIPv6(host)) return host.toLowerCase();
	if (host.includes(':')) {
		if (/^[^:]+:\d+$/.test(host)) throw bad('Enter the host only: the port is fixed by the app.');
		throw bad('Enter an IP address or a domain name.');
	}
	if (DOTTED_QUAD_RE.test(host)) {
		if (!net.isIPv4(host)) throw bad(`"${host}" is not a valid IPv4 address.`);
		return host;
	}
	const lower = host.toLowerCase();
	if (lower.endsWith('.onion')) {
		throw bad('The Tor address is published by the app itself; enter your public IP or domain name here.');
	}
	if (lower.length > 255 || !DNS_NAME_RE.test(lower)) throw bad('Enter an IP address or a domain name.');
	return lower;
}

/** A host as it appears before a port: IPv6 in brackets, anything else as is. */
function hostForUri(host) {
	return host && host.includes(':') ? `[${host}]` : host;
}

/**
 * The host port peers off the box dial for a listen port. The compose file
 * publishes the onion's window (the first `windowCount` listen ports from
 * `windowStart`) at `publishedBase`, so a listen port inside the window maps
 * to its place in the published range and one past it has no public port.
 * With no base set (a native run) the listen port itself is reachable.
 */
function publicPort({ listenPort, windowStart, windowCount, publishedBase } = {}) {
	if (!listenPort) return null;
	if (!publishedBase) return listenPort;
	const i = listenPort - windowStart;
	return i >= 0 && i < windowCount ? publishedBase + i : null;
}

/**
 * The addresses for the node_announcement: the onion while it forwards this
 * wallet's listen port, the public host at its published port, or both by
 * mode, and nothing while the wallet does not announce or runs no Lightning.
 */
function announceList({ mode, announce, onchainOnly, onion, listenPort, onionMapped, publicHost, publicPort: pub } = {}) {
	if (!announce || onchainOnly) return [];
	const out = [];
	if (usesOnion(mode) && onion && onionMapped && listenPort) out.push(`${onion}:${listenPort}`);
	if (usesPublic(mode) && publicHost && pub) out.push(`${hostForUri(publicHost)}:${pub}`);
	return out;
}

/**
 * The daemon's proxy env for a mode. Tor mode sends every peer through the
 * app's Tor. Clearnet and Hybrid keep the proxy for .onion peers and dial
 * clearnet directly, which is the engine's onion-only scope; an engine
 * without it gets no proxy for those modes at all, the direct dials they
 * always made, rather than a surprise trip through Tor. The scope is never
 * sent alone: the engine refuses to start on it without a proxy.
 */
function proxyEnv({ mode, torProxy, scopeSupported } = {}) {
	if (!torProxy) return {};
	if (mode === 'tor') return { BEIGNET_TOR_PROXY: torProxy };
	if (!scopeSupported) return {};
	return { BEIGNET_TOR_PROXY: torProxy, BEIGNET_TOR_PROXY_ONION_ONLY: 'true' };
}

/** What a record's network choice refuses, before anything is written. */
function validateNetworkChoice({ mode, publicHost, onchainOnly } = {}) {
	if (!MODES.includes(mode)) {
		throw httpError(400, 'BAD_NETWORK_MODE', `Unknown network mode "${mode}". Choose Tor, Clearnet or Hybrid.`);
	}
	if (mode === 'clearnet' && !publicHost && !onchainOnly) {
		throw httpError(
			400,
			'PUBLIC_HOST_REQUIRED',
			'Clearnet needs a public address, your public IP or domain name, so peers have somewhere to reach this wallet. Choose Hybrid to keep the Tor address without one.'
		);
	}
}

module.exports = {
	MODES,
	DEFAULT_MODE,
	networkMode,
	requestedMode,
	usesOnion,
	usesPublic,
	normalizePublicHost,
	hostForUri,
	publicPort,
	announceList,
	proxyEnv,
	validateNetworkChoice
};
