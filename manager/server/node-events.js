'use strict';

const http = require('http');

// Reconnect backoff for the daemon's event stream. The daemon is local, so a
// dropped stream almost always means it restarted; retry quickly but back off
// so a daemon that is down does not spin.
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

/**
 * Subscribes to a beignet daemon's SSE stream (GET /events) and invokes
 * onEvent(name, data) for each event.
 *
 * The daemon reports the reason a channel open failed (peer rejection, funding
 * failure, disconnect mid-open) only as a `node:error` event. Nothing polls for
 * it and it is not part of any resource, so without a live subscription the
 * reason is lost and a failed open just looks like a channel that vanished.
 *
 * Node 24 has no global EventSource without a flag, so the stream is parsed
 * here: SSE frames are separated by a blank line and carry `event:` and
 * `data:` fields.
 *
 * Returns a handle with stop(). Reconnects until stopped.
 *
 * The stream is opened when the daemon is spawned, before it listens, so the
 * first attempts fail and the retry backs off. Anything the daemon emits
 * while no stream is attached is lost: nothing replays it. So the handle
 * also says when it is connected (`connected`, `whenConnected(ms)`), and
 * `kick()` retries at once, for a caller that knows the daemon is up and is
 * about to make it emit something that must be recorded (beignet-umbrel
 * #282).
 */
function subscribeToEvents({ port, token, onEvent, onConnect, log }) {
	let stopped = false;
	let req = null;
	let retryTimer = null;
	let retryMs = RETRY_MIN_MS;
	// A request is pending or its stream is open.
	let inFlight = false;
	let connected = false;
	const waiters = new Set();

	const settleWaiters = (value) => {
		for (const w of waiters) w(value);
		waiters.clear();
	};
	const lost = () => {
		inFlight = false;
		connected = false;
	};

	const scheduleRetry = () => {
		if (stopped || retryTimer) return;
		retryTimer = setTimeout(() => {
			retryTimer = null;
			connect();
		}, retryMs);
		retryMs = Math.min(RETRY_MAX_MS, retryMs * 2);
	};

	const dispatch = (frame) => {
		let name = null;
		const dataLines = [];
		for (const line of frame.split('\n')) {
			if (line.startsWith('event:')) name = line.slice(6).trim();
			else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
		}
		if (!name) return;
		let data = null;
		try {
			data = dataLines.length ? JSON.parse(dataLines.join('\n')) : null;
		} catch (_) {
			/* keep the event even if its payload is not JSON */
		}
		try {
			onEvent(name, data);
		} catch (err) {
			log(`event handler failed: ${err.message}`);
		}
	};

	const connect = () => {
		if (stopped) return;
		inFlight = true;
		// Each handler checks it still belongs to the current request, so a
		// late error from one that kick() or stop() replaced changes nothing.
		const r = http.request(
			{
				host: '127.0.0.1',
				port,
				path: '/events',
				method: 'GET',
				headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }
			},
			(res) => {
				if (req !== r) {
					res.resume();
					return;
				}
				if (res.statusCode !== 200) {
					res.resume();
					lost();
					scheduleRetry();
					return;
				}
				// Connected: reset the backoff so the next drop retries promptly.
				retryMs = RETRY_MIN_MS;
				connected = true;
				settleWaiters(true);
				if (onConnect) Promise.resolve().then(onConnect).catch(err => log(`Event refresh failed: ${err.message}`));
				res.setEncoding('utf8');
				let buf = '';
				res.on('data', (chunk) => {
					buf += chunk;
					let sep;
					// Frames are terminated by a blank line. Anything after the last
					// separator is a partial frame and stays buffered.
					while ((sep = buf.indexOf('\n\n')) !== -1) {
						const frame = buf.slice(0, sep);
						buf = buf.slice(sep + 2);
						if (frame.trim()) dispatch(frame);
					}
				});
				const drop = () => {
					if (req !== r) return;
					lost();
					scheduleRetry();
				};
				res.on('end', drop);
				res.on('error', drop);
			}
		);
		req = r;
		r.on('error', () => {
			if (req !== r) return;
			lost();
			scheduleRetry();
		});
		r.end();
	};

	connect();

	return {
		get connected() {
			return connected;
		},
		/**
		 * Resolves true once the stream is connected (at once if it is), or
		 * false after `timeoutMs` or when the subscription is stopped.
		 */
		whenConnected(timeoutMs) {
			if (connected) return Promise.resolve(true);
			if (stopped) return Promise.resolve(false);
			return new Promise((resolve) => {
				let timer = null;
				const done = (value) => {
					if (timer) clearTimeout(timer);
					waiters.delete(done);
					resolve(value);
				};
				waiters.add(done);
				if (Number.isFinite(timeoutMs)) {
					timer = setTimeout(() => done(false), timeoutMs);
					if (typeof timer.unref === 'function') timer.unref();
				}
			});
		},
		/**
		 * Retry now instead of waiting out the backoff. Nothing happens while
		 * an attempt is pending or the stream is open.
		 */
		kick() {
			if (stopped || connected || inFlight) return;
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}
			retryMs = RETRY_MIN_MS;
			connect();
		},
		stop() {
			stopped = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = null;
			}
			lost();
			settleWaiters(false);
			if (req) {
				const r = req;
				req = null;
				r.destroy();
			}
		}
	};
}

module.exports = { subscribeToEvents };
