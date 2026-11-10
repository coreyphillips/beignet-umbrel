/**
 * One Paykit call, run in a worker thread of its own.
 *
 * The Pubky SDK replaces globalThis.fetch with a cookie-jar wrapper the
 * moment it is imported, and every request it makes goes through the global
 * fetch. Run in the manager's own thread, that would change every fetch the
 * manager makes and send Pubky traffic by whatever route happened to be the
 * default. Here both stay in this thread: the route this wallet's network
 * mode asks for (Tor, or direct with private addresses refused) is installed
 * as the global dispatcher before the SDK loads, and the thread ends with
 * the call.
 *
 * In: workerData { op: 'get' | 'set', route, torProxy, pubky?, secret?,
 * endpoints? }. `secret` is the 32-byte identity secret; it is zeroed once
 * the call is over and never leaves this thread or reaches a message.
 * Out: one message, { ok: true, result } or { ok: false, code, message }.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { setGlobalDispatcher } = require('undici');
const { createDispatcher } = require('./outbound.js');

const { op, route, torProxy, pubky, endpoints } = workerData;
const secret = workerData.secret ? new Uint8Array(workerData.secret) : null;
if (workerData.secret) workerData.secret.fill(0);

setGlobalDispatcher(createDispatcher({ route, torProxy }));

try {
	const { getPaymentList, setPaymentList } = await import('@coreyphillips/paykit-discovery');
	let result;
	if (op === 'get') result = await getPaymentList(pubky);
	else if (op === 'set') result = await setPaymentList(secret, endpoints);
	else throw Object.assign(new Error(`Unknown Paykit operation ${op}`), { code: 'INVALID_INPUT' });
	parentPort.postMessage({ ok: true, result });
} catch (e) {
	// paykit-discovery's messages never carry a secret; a transport error's
	// cause might name a URL, which is not secret either.
	parentPort.postMessage({ ok: false, code: e?.code || 'TRANSPORT', message: String(e?.message || e) });
} finally {
	if (secret) secret.fill(0);
}
