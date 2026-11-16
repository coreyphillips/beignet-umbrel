/**
 * The Assets tab's judgement calls, kept out of its components: which
 * warnings a wallet earns, why a send cannot go, what an event is worth
 * saying aloud, and the list of things assets here do not cover.
 *
 * Pure, like lib/asset-progress.js beside it, so the wording and the
 * conditions can both be pinned by tests.
 */
import { cmpUnits, decimalsOf, fmtAsset, fmtUnits, isZero, unitOf } from './asset-amount.js';
import { amountOf, canRebroadcast, isFailed, isPending, namesOf, stuckNote } from './asset-progress.js';
import { timeAgo } from './backup.js';
import { fmtSats, shortId } from './format.js';

export { isPending, isFailed };

/** What makes an asset itself: its group key when it has one, else its ID. */
export function identityKey(asset) {
	return (asset && (asset.groupKey || asset.assetId || asset.key)) || null;
}

/** Bitcoin's own prefix for a Taproot Assets address on each chain. */
export const TAP_PREFIX = { mainnet: 'tapbc1', testnet: 'taptb1', regtest: 'taprt1' };
export const tapPrefix = (network) => TAP_PREFIX[network] || TAP_PREFIX.mainnet;

/* ------------------------------------------------------------ proof server */

// The port a proof courier listens on when its address names none.
export const COURIER_PORT = 10029;

/**
 * A custom proof server as the settings form holds it, from the wallet's
 * record: { host, port, rest }. Empty strings when there is none.
 */
export function universeToForm(universe) {
	const m = /^[a-z+]+:\/\/(\[[0-9a-f:]+\]|[^:/]+)(?::(\d+))?$/i.exec(String(universe?.courier || '').trim());
	return { host: m ? m[1] : '', port: m && m[2] ? m[2] : m ? String(COURIER_PORT) : '', rest: String(universe?.rest || '') };
}

/**
 * The settings form as the wallet setting, or the reason it is not one yet.
 * Returns { universe: { courier, rest } } or { problem }.
 *
 * The web address defaults to https on the same host, which is where a
 * universe server's REST gateway usually is.
 */
export function formToUniverse({ host, port, rest }) {
	const h = String(host || '').trim().replace(/^[a-z+]+:\/\//i, '').replace(/\/+$/, '');
	if (!h) return { problem: "Enter the proof server's host." };
	if (/[\s/]/.test(h)) return { problem: 'The host is a name or an address, without a path.' };
	const p = String(port || '').trim() === '' ? COURIER_PORT : Number(port);
	if (!Number.isInteger(p) || p < 1 || p > 65535) return { problem: 'The port is a number from 1 to 65535.' };
	const web = String(rest || '').trim() || `https://${h}`;
	if (!/^https?:\/\/[^\s]+$/i.test(web)) return { problem: 'The web address starts with https://.' };
	return { universe: { courier: `universerpc://${h}:${p}`, rest: web.replace(/\/+$/, '') } };
}

/** What a proof server test found, as the line beside the Test button: { state, text }. */
export function describeProofServerTest(result, network) {
	if (!result) return null;
	if (!result.reachable) {
		return { state: 'unreachable', text: `Not reachable: ${String(result.error || 'no answer').replace(/[.\s]+$/, '')}.` };
	}
	if (result.network && network && result.network !== network) {
		return { state: 'wrong-chain', text: `This server is for ${result.network}, and this wallet is on ${network}.` };
	}
	const parts = ['Reachable'];
	if (result.network) parts.push(result.network);
	if (Number.isFinite(result.ms)) parts.push(`${Math.round(result.ms)} ms`);
	return { state: 'ok', text: parts.join(' \u00b7 ') };
}

/* ------------------------------------------------------------------ limits */

/**
 * What assets in this app do not do, said before anyone finds out the hard
 * way. Shown on the empty state, under Holdings and in Settings.
 *
 * Each item is { key, parts }, parts being strings and { code } for the one
 * thing set in monospace, the proof server's host.
 */
export function LIMITS(network, host, lightning) {
	const where = host || 'the default one';
	const ready =
		network === 'regtest'
			? 'A new asset is usable after 1 confirmation. On regtest that is the next block you mine.'
			: 'A new asset is usable after 6 confirmations, about an hour. On testnet, blocks are irregular and it can take much longer.';
	const items = [
		{
			key: 'backup',
			parts: [
				'A recovery phrase alone does not bring assets back. Their proofs are kept in the app backup (Settings, Back up all wallets), so make a new backup after you create or receive an asset.'
			]
		},
		{
			key: 'fee-bump',
			parts: ['Asset transactions cannot be fee-bumped yet. One sent at a low fee rate waits until the network takes it.']
		},
		{ key: 'confirmations', parts: [ready] },
		{
			key: 'anchor',
			parts: [
				'Each asset sits in a bitcoin output of about 1,000 sats. Those sats are yours, and they are shown as locked with assets instead of in the on-chain balance.'
			]
		},
		{
			key: 'proof-server',
			parts: [
				'Proofs travel through a proof server (',
				{ code: where },
				" unless you change it). It learns which assets this wallet asks about, and this Umbrel's IP address unless the wallet is in Tor mode."
			]
		},
		{ key: 'names', parts: ['Names are not unique. Anyone can create an asset with any name, so go by the asset ID.'] }
	];
	if (lightning) {
		items.push({
			key: 'lightning',
			parts: [
				"Paying and receiving over Lightning needs a channel funded with the asset. The price is your channel peer's, and it holds for seconds to minutes."
			]
		});
	}
	items.push({ key: 'prices', parts: ['No prices are shown. This app does not know what an asset is worth.'] });
	return items;
}

/** A limit as one plain sentence, for tests and for anything that cannot set type. */
export function limitText(item) {
	return item.parts.map((p) => (typeof p === 'string' ? p : p.code)).join('');
}

/* ---------------------------------------------------------------- warnings */

/**
 * A wallet can hold what an asset transaction costs and still be unable to
 * build it: the library works with more than the cost and hands the rest
 * back as change. The sentence for that, or null when the refusal names no
 * such figure and the wallet is simply short of the cost.
 */
export function onHandShortage(details, what) {
	const d = details || {};
	if (d.onHandSats == null || d.needed == null || !(Number(d.onHandSats) > Number(d.needed))) return null;
	const has = d.spendable != null ? ` This wallet has ${fmtSats(d.spendable)}.` : '';
	return `${what} costs ${fmtSats(d.needed)}, but the wallet has to hold about ${fmtSats(d.onHandSats)} on-chain to build the transaction. What is not spent comes straight back.${has} Deposit bitcoin on the Receive tab first.`;
}

/**
 * What the assets host says is wrong with the wallet's asset channels, one
 * note each: { code, tone, text }, the sentence being the host's own. A
 * recovery that is taking long is a wait, and is said in blue. Anything else
 * is something the wallet cannot put right by itself, and is said in red. A
 * host that names no codes is believed all the same, in one red note.
 */
/**
 * Why this wallet's node takes nothing new over asset channels, when the
 * wallet's assets host says it does not (`status.lightning.unavailable`):
 * { code, text }, with the host's own sentence. Null for a wallet whose
 * asset channels work, and for one that has none to speak of. The channels
 * there already are stay listed and can still be closed, so the screens
 * stay, held with this reason.
 */
export function lightningHeld(status) {
	const said = status && status.lightning && status.lightning.unavailable;
	if (!said || typeof said.message !== 'string' || !said.message.trim()) return null;
	return { code: typeof said.code === 'string' && said.code ? said.code : 'LIGHTNING_UNAVAILABLE', text: said.message.trim() };
}

// A warning that is a wait or a thing said, not a loss: shown blue.
const CHANNEL_NOTES = new Set(['RECOVERY_STUCK', 'FEE_BUDGET_EXHAUSTED']);

export function channelWarnings(status) {
	const ln = status && status.lightning;
	if (!ln) return [];
	const said = Array.isArray(ln.warnings) ? ln.warnings.filter((w) => w && typeof w.text === 'string' && w.text.trim()) : [];
	if (said.length > 0) {
		return said.map((w) => ({ code: String(w.code || 'CHANNEL_WARNING'), tone: CHANNEL_NOTES.has(w.code) ? 'info' : 'error', text: w.text.trim() }));
	}
	return typeof ln.warning === 'string' && ln.warning.trim() ? [{ code: 'CHANNEL_WARNING', tone: 'error', text: ln.warning.trim() }] : [];
}

/**
 * The notes across the top of the Assets tab. Errors first, then the things
 * worth knowing. Each is { code, tone: 'error' | 'info', text, action }, the
 * action being 'backup' where the reader can do something about it now.
 */
export function assetWarnings({ status, rec, info, health, btc, holdings, rows, fees, now = Date.now() } = {}) {
	const out = [];
	if (!status) return out;
	const host = status.proofServer?.host || 'the proof server';
	const holds = (holdings || []).length > 0 || !!status.holdsAssets;
	const active = (rows || []).filter(isPending);

	if (status.proofServer && status.proofServer.reachable === false) {
		out.push({
			code: 'PROOF_SERVER_DOWN',
			tone: 'error',
			parts: [
				'The proof server (',
				{ code: host },
				') is not answering. Assets you hold are unaffected, but a receive cannot complete and a sent proof waits until it is back.'
			]
		});
	}

	// For a moment after this wallet's own mint, send or burn is broadcast
	// its balance reads zero: the coin it spent is gone and the change is not
	// seen yet. That is not an empty wallet, so nothing is said until the
	// transaction has a block. A wallet that really is empty hears it then.
	const settling = (rows || []).some(
		(row) => ['mint', 'send', 'burn'].includes(row.kind) && (row.state === 'pending' || row.state === 'broadcast') && !isFailed(row)
	);
	const spendable = btc?.spendableSats ?? info?.onchainBalanceSats;
	if (spendable === 0 && !settling) {
		const lfbw = !!rec?.lfbw?.enabled;
		out.push({
			code: lfbw ? 'NO_SATS_LFBW' : 'NO_SATS',
			// With nothing held, nothing is blocked that the reader has tried to
			// do, so it is said as a fact. With assets held it is the reason
			// they cannot be moved, and it is said as one.
			tone: holds ? 'error' : 'info',
			parts: [
				lfbw
					? 'A lightning-first wallet keeps its bitcoin in its channel, so there is nothing on-chain to pay asset fees with. Receiving an asset still works.'
					: 'This wallet has no bitcoin on-chain. Creating, sending and burning an asset each pay a miner fee in bitcoin, so deposit some on the Receive tab first.'
			]
		});
	}

	// What is wrong with an asset channel is said here too: the assets in it
	// are part of what this tab counts.
	for (const w of channelWarnings(status)) out.push({ code: w.code, tone: w.tone, parts: [w.text] });
	// A node that does not offer asset channels: nothing new can be opened,
	// invoiced or paid over them, in the host's own sentence.
	const held = lightningHeld(status);
	if (held) out.push({ code: held.code, tone: 'error', parts: [held.text] });

	if (health && health.electrumConnected === false) {
		out.push({
			code: 'ELECTRUM_DOWN',
			tone: 'error',
			parts: ['The Electrum server is not connected, so an incoming asset cannot be seen until it is.']
		});
	}

	const stuckRow = active.find((row) => stuckNote(row, fees, now));
	if (stuckRow) {
		out.push({
			code: 'STUCK',
			tone: 'info',
			parts: [stuckNote(stuckRow, fees, now)],
			...(canRebroadcast(stuckRow) ? { action: 'rebroadcast', rowId: stuckRow.id } : {})
		});
	}

	const backup = status.backup;
	if (backup && holds) {
		if (!backup.exportedAt) {
			out.push({
				code: 'BACKUP_NEVER',
				tone: 'info',
				action: 'backup',
				parts: [
					"Your assets are not in a backup yet. The recovery phrase brings back this wallet's bitcoin, but assets also need their proofs, and those are only in the app backup."
				]
			});
		} else if (backup.dirty) {
			out.push({
				code: 'BACKUP_STALE',
				tone: 'info',
				action: 'backup',
				parts: [
					`Your assets changed since the backup ${timeAgo(backup.exportedAt, now) || 'you last made'}. A backup made now includes the new proofs.`
				]
			});
		}
	}

	return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === 'error' ? -1 : 1));
}

/** How many operations are still going, for the count beside the tab's name. */
export function pendingCount(status) {
	const p = status && status.pending;
	if (!p) return 0;
	return (p.mints || 0) + (p.sends || 0) + (p.receives || 0) + (p.burns || 0);
}

/* ---------------------------------------------------------------- the host */

// A route that refuses because there is no assets host behind it: the host's
// own word for "I could not start", and the engine's for "nothing was loaded".
const HOST_GONE = new Set(['ASSETS_UNAVAILABLE', 'EXTENSION_UNAVAILABLE']);

const reasonOf = (e) => {
	const text = e && typeof e === 'object' ? e.message : e;
	return (text && String(text).trim()) || null;
};

/**
 * Where a wallet's assets host stands, from the three places that say: its
 * status, the error the last status request came back with, and the wallet's
 * record.
 *
 * Returns { kind }, one of
 *   'loading'      nothing has answered yet
 *   'unavailable'  the host is not running; `reason` is why, when anyone said
 *   'restarting'   the wallet is being restarted under it, and it will be back
 *   'starting'     the host is up and still checking: `done` of `total`
 *   'unreadable'   the wallet did not answer, for a reason of its own (`error`)
 *   'ready'
 *
 * A status that answered once is kept while a later request fails, so the
 * error is read first: a host that has gone says so on every route.
 */
export function hostState({ status, error, loading, rec } = {}) {
	const record = rec && rec.assets;
	const failed = !!status && (status.phase === 'failed' || status.phase === 'error');
	if (error && HOST_GONE.has(error.code)) {
		return { kind: 'unavailable', reason: (failed && reasonOf(status.error)) || reasonOf(record && record.error) || reasonOf(error) };
	}
	if (error && error.code === 'ASSETS_STOPPING') return { kind: 'restarting' };
	if (error && error.code === 'ASSETS_STARTING' && !(status && status.ready)) return { kind: 'starting', done: null, total: null };
	if (failed) return { kind: 'unavailable', reason: reasonOf(status.error) || reasonOf(record && record.error) };
	if (!status) {
		if (record && record.phase === 'failed') return { kind: 'unavailable', reason: reasonOf(record.error) };
		return loading || !error ? { kind: 'loading' } : { kind: 'unreadable', error };
	}
	if (status.ready === false) {
		const total = (status.startup && status.startup.total) || null;
		return { kind: 'starting', done: total ? Math.min(total, status.startup.done || 0) : null, total };
	}
	return { kind: 'ready' };
}

/** Two proof server hosts name the same server, whatever port either one spelled out. */
const sameServer = (a, b) => {
	const bare = (h) => String(h || '').trim().toLowerCase().replace(/:\d+$/, '');
	return !!bare(a) && bare(a) === bare(b);
};

/**
 * What waits while this wallet's proof server is not answering, said on the
 * view where the waiting would be met. `doing` is 'send' or 'receive'.
 *
 * A send's proof goes to the server its address names, so with an address
 * read (`courierHost`) this only speaks when that is the same server.
 *
 * Returns the sentence, or null while the server answers or has not been
 * asked yet.
 */
export function proofServerWait(proofServer, doing, courierHost) {
	if (!proofServer || proofServer.reachable !== false) return null;
	if (doing === 'send') {
		if (courierHost && !sameServer(courierHost, proofServer.host)) return null;
		return 'While the proof server is not answering, a send still goes out and confirms. Its proof waits here and is delivered when the server is back, and the recipient has the asset then.';
	}
	return 'While the proof server is not answering, an address can still be made and paid. The asset stays in progress until the server answers and the wallet has its proof. Nothing is lost while it waits.';
}

/**
 * The proof servers the app knows for `network`, from its config, as the
 * settings dialog lists them: [{ id, label, host, courier, rest, note }].
 * The first is the one a wallet uses when it names none of its own. Empty
 * when the app knows none for that network (regtest without one set).
 *
 * Testnet is two chains with a server each. `chain` is the one the wallet's
 * host says it is on (`status.chain.name`), and the other chain's server is
 * left out. While the host has not said, both are listed.
 */
/**
 * The chain a wallet's assets are on, in words: its network, or which
 * testnet once its host has found out.
 */
export function chainName(network, status) {
	const name = status && status.chain && status.chain.name;
	return name && name !== network ? name : network;
}

/** The network to link a block explorer for: testnet4 by name when that is the wallet's chain. */
export function explorerNetwork(network, status) {
	return status && status.chain && status.chain.name === 'testnet4' ? 'testnet4' : network;
}

export function proofServersFor(config, network, chain = null) {
	return ((config && config.universeServers) || [])
		.filter((s) => s && s.courier && s.rest && Array.isArray(s.networks) && s.networks.includes(network))
		.filter((s) => !chain || !s.chain || s.chain === chain)
		.map((s) => ({
			id: String(s.id || s.courier),
			label: s.label || null,
			host: String(s.courier).replace(/^[a-z+]+:\/\//i, ''),
			courier: s.courier,
			rest: s.rest,
			note: s.note || null
		}));
}

/* ------------------------------------------------------------ send refusal */

/**
 * Why a decoded address cannot be paid from this wallet, or null when it can.
 *
 * `decoded` is the wallet's reading of the address, `holdings` what the
 * wallet holds, and `error` whatever the last attempt to price the send came
 * back with. The local reasons come first: they are certain, and the wallet
 * should not be asked to build a transaction that cannot be one.
 *
 * Returns { code, text }.
 */
export function sendRefusal({ decoded, holdings, error } = {}) {
	if (!decoded) return null;
	if (decoded.own) {
		return {
			code: 'OWN_ADDRESS',
			text: "This is one of this wallet's own addresses. Sending to it would only pay a fee."
		};
	}
	const wanted = decoded.groupKey || decoded.assetId;
	const held =
		(holdings || []).find((a) => a.key === wanted || a.assetId === decoded.assetId || (decoded.groupKey && a.groupKey === decoded.groupKey)) ||
		null;
	if (!held) {
		return {
			code: 'ASSET_NOT_HELD',
			text: `This address asks for an asset this wallet does not hold (ID ${shortId(decoded.assetId || wanted, 4)}), so there is nothing to send.`
		};
	}
	const onchain = held.balance?.onchain ?? '0';
	if (cmpUnits(decoded.amount, onchain) > 0) {
		const inChannels = held.balance?.channelLocal;
		const channelNote =
			inChannels && !isZero(inChannels)
				? ` Another ${fmtAsset(inChannels, held)} is in Lightning channels, which an on-chain send cannot use.`
				: '';
		return {
			code: 'INSUFFICIENT_ASSET',
			text: `This address asks for ${fmtAsset(decoded.amount, held)} and this wallet has ${fmtAsset(onchain, held)} on-chain. Ask for an address for a smaller amount.${channelNote}`
		};
	}
	if (error) {
		if (error.code === 'INSUFFICIENT_BTC') {
			const d = error.details || {};
			const held = onHandShortage(d, 'Sending');
			if (held) return { code: 'INSUFFICIENT_SATS', text: held };
			const split =
				d.feeSats != null && d.anchorSats != null
					? ` (${Number(d.feeSats).toLocaleString('en-US')} for the miner fee and ${Number(d.anchorSats).toLocaleString('en-US')} that travel with the asset)`
					: ' for the miner fee and the sats that travel with the asset';
			const needs = d.needed != null ? `Sending needs ${fmtSats(d.needed)} in bitcoin${split}` : 'Sending needs bitcoin for the miner fee and the sats that travel with the asset';
			const has = d.spendable != null ? `, and this wallet has ${fmtSats(d.spendable)} on-chain` : ', and this wallet does not have enough on-chain';
			return { code: 'INSUFFICIENT_SATS', text: `${needs}${has}. Deposit bitcoin on the Receive tab first.` };
		}
		if (error.code === 'INSUFFICIENT_ASSET_BALANCE') {
			return {
				code: 'INSUFFICIENT_ASSET',
				text: `This address asks for ${fmtAsset(decoded.amount, held)}, which is more than this wallet can send on-chain right now. Ask for an address for a smaller amount.`
			};
		}
		if (error.code === 'OWN_ADDRESS') {
			return { code: 'OWN_ADDRESS', text: "This is one of this wallet's own addresses. Sending to it would only pay a fee." };
		}
		if (error.code === 'FEE_TOO_HIGH') {
			return {
				code: 'FEE_TOO_HIGH',
				text: 'That fee rate is above the limit this wallet allows for an asset transaction. Lower it and the send can go.'
			};
		}
		return { code: error.code || 'SEND_REFUSED', text: sentence(error.message || 'The wallet could not prepare this send') };
	}
	return null;
}

/** A line that ends like one, whatever the wallet's own message ended with. */
export function sentence(text) {
	const t = String(text || '').trim();
	return /[.!?…]$/.test(t) ? t : `${t}.`;
}

/* ------------------------------------------------------------ proof files */

/** The largest proof file the wallet takes by hand. */
export const MAX_PROOF_FILE_BYTES = 4 * 1024 * 1024;

/** A proof file as the wallet hands it over (base64), as bytes to save. */
export function proofFileBytes(base64) {
	const binary = atob(String(base64 || ''));
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * What to say once the wallet has taken a proof file: { text, tone }. A file
 * is `complete` when it verified and the asset is held, `kept` when the
 * wallet will verify it later by itself, and `already` when there was
 * nothing left to do.
 */
export function proofTaken(answer) {
	const a = answer || {};
	const row = a.row || null;
	// What arrived is said by the wallet's own event; this says the file was good.
	if (a.result === 'complete') return { text: 'The proof checks out, and the asset is in your holdings.', tone: 'success' };
	if (a.result === 'already') return { text: 'This wallet already has that payment. Nothing changed.', tone: 'info' };
	if (a.waitingFor === 'confirmations') {
		const need = row && row.confirmationsRequired ? `${row.confirmationsRequired} blocks deep` : 'deep enough';
		return { text: `The proof file is kept. The asset arrives once its transaction is ${need}, with no proof server needed.`, tone: 'info' };
	}
	const why = a.reason ? ` (${String(a.reason).replace(/\.$/, '')})` : '';
	return { text: `The proof file is kept, and could not be checked just now${why}. The wallet tries again by itself.`, tone: 'info' };
}

/* ----------------------------------------------------------------- events */

/**
 * What an assets event is worth saying in a toast, or null for nothing.
 *
 * Only the ends are announced: an asset arriving, a mint becoming usable, a
 * send's proof landing, a burn done, and a failure. The broadcast was already
 * said by the form that caused it, and each confirmation in between is on the
 * timeline for anyone watching.
 */
export function describeAssetEvent(name, data) {
	// A channel open that was turned down after the dialog had closed: the
	// wallet says why in a sentence of its own, and the row is already gone,
	// so this is the only place it can be read.
	if (name === 'assets:error' && data && data.channelId && typeof data.message === 'string' && data.message.trim()) {
		return { text: `The asset channel was not opened. ${data.message.trim()}`, tone: 'error', duration: 12000 };
	}
	const row = data && data.row;
	if (!row) return null;
	const failed = isFailed(row);
	const reason = row.failure?.message ? `: ${String(row.failure.message).replace(/[.\s]+$/, '')}` : '';
	const done = row.state === 'complete';
	if (!done && !failed) return null;
	const what = amountOf(row);
	switch (name) {
		case 'assets:mint':
			if (failed) return { text: `Minting ${namesOf(row)} failed${reason}`, tone: 'error', duration: 9000 };
			return {
				text:
					(row.assets || []).length === 1
						? `${row.assets[0].name} is ready: ${mintedText(row.assets[0])}`
						: `${namesOf(row)} are ready`,
				tone: 'success',
				duration: 8000
			};
		case 'assets:receive':
			if (row.kind === 'ln-receive') return null;
			if (failed) return { text: `Receiving ${what} failed${reason}`, tone: 'error', duration: 9000 };
			return { text: `Received ${what}`, tone: 'success', duration: 8000 };
		case 'assets:transfer':
			if (row.kind === 'burn') {
				if (failed) return { text: `Burning ${what} failed${reason}`, tone: 'error', duration: 9000 };
				return { text: `Burned ${what}`, tone: 'success' };
			}
			if (failed) return { text: `Sending ${what} failed${reason}`, tone: 'error', duration: 9000 };
			return { text: `Sent ${what}: proof delivered`, tone: 'success', duration: 6000 };
		case 'assets:invoice':
			if (failed || row.kind !== 'ln-receive') return null;
			return { text: `Received ${what} over Lightning`, tone: 'success', duration: 8000 };
		default:
			return null;
	}
}

function mintedText(asset) {
	if (asset.type === 'collectible') return 'one of one';
	return `${fmtUnits(asset.amount, decimalsOf(asset))} minted`;
}

/* ------------------------------------------------------------ asking once */

// Not the wallet's answer: the manager standing in for a daemon it could not
// reach, or the browser giving up on the wait. A thrown error with no code at
// all (a dropped connection) is not an answer either.
const NOT_AN_ANSWER = new Set(['PROXY_ERROR', 'NOT_RUNNING', 'WALLET_UNRESPONSIVE']);

/** Whether an error is the wallet refusing, as opposed to no answer arriving. */
export function isRefusal(error) {
	const code = error && error.code;
	return typeof code === 'string' && code !== '' && !NOT_AN_ANSWER.has(code);
}

/**
 * Send a money-moving request so that it happens once.
 *
 * `send(key)` posts with an idempotency key. A refusal is thrown as it is. A
 * request whose answer never came back may still have landed, so before
 * anything else the wallet is asked whether a row carries the key
 * (`findByClientRef`), and only then is the same request, with the same key,
 * asked again. The wallet answers a repeated key with what it did the first
 * time, so nothing is minted or sent twice.
 *
 * Gives up after a few tries with the original error, marked `unknown`: the
 * page then says the outcome is not known, which is the truth.
 */
export async function submitOnce(send, key, findByClientRef, { delays = [1000, 2000, 4000] } = {}) {
	try {
		return await send(key);
	} catch (first) {
		if (isRefusal(first)) throw first;
		for (const delay of delays) {
			await new Promise((r) => setTimeout(r, delay));
			try {
				const row = findByClientRef ? await findByClientRef(key) : null;
				if (row) return { row, recovered: true };
			} catch (_) {
				/* still no answer: ask again below */
			}
			try {
				return await send(key);
			} catch (again) {
				if (isRefusal(again)) throw again;
			}
		}
		first.unknown = true;
		throw first;
	}
}

/* ------------------------------------------------------------------- misc */

/** "asset, shown with 2 decimal places" / "collectible, one of one" */
export function describeType(asset) {
	if (!asset) return '-';
	if (asset.type === 'collectible') return 'collectible, one of one';
	const d = decimalsOf(asset);
	return d === 0 ? 'asset, counted in whole units' : `asset, shown with ${d} decimal place${d === 1 ? '' : 's'}`;
}

/** "1,000,000.00 BUSD issued in 2 mints · 500.00 burned", or that it is not known. */
export function describeSupply(asset, issuances) {
	const supply = asset && asset.supply;
	if (!supply || !supply.known || supply.issued == null) return 'not known: this wallet has only seen its own part';
	if (asset.type === 'collectible') return 'one of one';
	const mints = (issuances || []).length;
	const issued = `${fmtAsset(supply.issued, asset)} issued${mints > 1 ? ` in ${mints} mints` : ''}`;
	const burned = supply.burned && !isZero(supply.burned) ? ` · ${fmtUnits(supply.burned, decimalsOf(asset))} burned` : '';
	return issued + burned;
}

/** "on-chain 12,500.00 · lightning 2,400.00", only when there is more than one place. */
export function describeSplit(asset) {
	const b = asset && asset.balance;
	if (!b) return '';
	const d = decimalsOf(asset);
	const parts = [];
	const inChannels = b.channelLocal && !isZero(b.channelLocal);
	if (inChannels) {
		parts.push(`on-chain ${fmtUnits(b.onchain, d)}`);
		parts.push(`lightning ${fmtUnits(b.channelLocal, d)}`);
	}
	if (b.pendingIn && !isZero(b.pendingIn)) parts.push(`${fmtUnits(b.pendingIn, d)} arriving`);
	if (b.pendingOut && !isZero(b.pendingOut)) parts.push(`${fmtUnits(b.pendingOut, d)} leaving`);
	return parts.join(' · ');
}

/** The name as a heading wants it: whole, however long. */
export const fullName = (asset) => (asset && asset.name) || unitOf(asset);
