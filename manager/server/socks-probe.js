'use strict';

const net = require('net');

/**
 * Minimal SOCKS5 CONNECT probe (no auth). Resolves true when the proxy
 * completes a CONNECT to host:port, false on any failure or timeout. Used to
 * verify Umbrel's Tor can actually build circuits: its SOCKS port accepting
 * TCP says nothing about circuit health, and a circuit-dead Tor makes every
 * peer connection of a Tor-enabled wallet time out.
 */
function probeSocksConnect({ proxyHost, proxyPort, host, port, timeoutMs = 30000 }) {
	return new Promise((resolve) => {
		const socket = net.connect({ host: proxyHost, port: proxyPort });
		let stage = 'greeting';
		let done = false;
		const timer = setTimeout(() => finish(false), timeoutMs);
		function finish(ok) {
			if (done) return;
			done = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(ok);
		}
		socket.on('error', () => finish(false));
		socket.on('connect', () => {
			socket.write(Buffer.from([0x05, 0x01, 0x00]));
		});
		socket.on('data', (buf) => {
			if (stage === 'greeting') {
				if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false);
				stage = 'connect';
				const hostBuf = Buffer.from(host, 'utf8');
				socket.write(
					Buffer.concat([
						Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
						hostBuf,
						Buffer.from([(port >> 8) & 0xff, port & 0xff])
					])
				);
			} else if (stage === 'connect') {
				finish(buf[0] === 0x05 && buf[1] === 0x00);
			}
		});
	});
}

module.exports = { probeSocksConnect };
