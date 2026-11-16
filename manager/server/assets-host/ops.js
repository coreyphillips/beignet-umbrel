'use strict';

/**
 * What the routes do. Each function takes the host (service.js) and the
 * request, and answers in the shapes of manager/ui/src/lib/assets-api.js.
 *
 * The writes that move money keep three promises:
 *
 *   A preview is a transaction funded and signed and not sent. Confirming it
 *   first writes, in one database transaction, the `committed/<id>` row that
 *   lets the loop carry it on, the answer to the request's idempotency key
 *   and the activity row. Only then is it advanced. A crash on either side
 *   of that write leaves either a preview the next start cancels, or a
 *   confirmed transfer the next start finishes: never a transfer nobody
 *   confirmed, and never one confirmed twice.
 *
 *   The same key answers with what was done the first time, from those rows,
 *   whether or not the daemon restarted in between.
 *
 *   A fee above the wallet's ceiling, or above the one a mint request names,
 *   stops the transaction before anything is signed.
 */
const crypto = require('crypto');
const { sha256Hex } = require('./store');
const { STATES, ANCHOR_SATS, unhex } = require('./adapter');
const { NETWORKS, parseCourier, restFor } = require('./config');
const { refusal, mapError, isFenced, isNotYet, isCourierTrouble, isProofInvalid, plainMessage, codeOf, workingSats } = require('./errors');
const views = require('./views');
const { QUOTE_ID } = require('./service');

const MAX_UNITS = (1n << 64n) - 1n;
const MAX_SEEDLINGS = 50;
const MAX_DECIMALS = 12;
// One input, the asset output and change: what a mint weighs when the wallet
// cannot fund one to measure it.
const MINT_VBYTES_GUESS = 154;
const SEND_VBYTES_GUESS = 250;
const TAP_HRPS = ['tapbc', 'taptb', 'taprt', 'tapsb'];
// The largest proof file taken by hand. One transfer adds a few kilobytes.
const MAX_PROOF_FILE_BYTES = 4 * 1024 * 1024;

const isHex = (text, length) => typeof text === 'string' && text.length === length && /^[0-9a-f]+$/.test(text);
const hexKey = (value) => String(value || '').trim().toLowerCase();

function parseUnits(value) {
	const text = String(value === undefined || value === null ? '' : value).trim();
	if (!/^[0-9]{1,20}$/.test(text)) throw refusal('BAD_AMOUNT', 'The amount must be a whole number of units above zero.');
	const units = BigInt(text);
	if (units <= 0n || units > MAX_UNITS) throw refusal('BAD_AMOUNT', 'The amount must be a whole number of units above zero.');
	return units;
}

/* ------------------------------------------------------------- idempotency */

const journalKey = (route, key) => `idem/${route}/${sha256Hex(String(key)).slice(0, 40)}`;
const bodyHash = (body) => sha256Hex(JSON.stringify(body || {}));

/** The first answer to this key on this route, or null when there was none. */
function replay(host, route, key, body) {
	if (!key) return null;
	const entry = host.rows.get(journalKey(route, key));
	if (!entry) return null;
	if (entry.body !== bodyHash(body)) {
		throw refusal('IDEMPOTENCY_KEY_REUSED', 'That request key was already used for a different request.', 409);
	}
	if (entry.rowId) {
		const row = host.getRow(entry.rowId);
		if (!row) throw refusal('IDEMPOTENCY_KEY_REUSED', 'That request was already made, and what it did is no longer on record.', 409);
		return { row: host.view(row) };
	}
	return entry.answer;
}

/** Record a key's answer. Call inside the transaction that makes the action durable. */
function journal(host, route, key, body, entry) {
	if (!key) return;
	host.rows.put(journalKey(route, key), { at: host.now(), body: bodyHash(body), ...entry });
}

/* ------------------------------------------------------------------- reads */

async function balances(host) {
	const assets = await host.assets();
	const anchors = new Set();
	for (const r of await host.tap.stores.assets.listAssets()) if (views.isLive(r)) anchors.add(r.anchorOutPoint);
	return {
		assets,
		btc: {
			anchorSats: host.mem.lockedKey === null ? anchors.size * ANCHOR_SATS : host.mem.lockedSats,
			anchorCount: anchors.size,
			spendableSats: host.spendable()
		}
	};
}

async function assetDetail(host, query) {
	const key = hexKey(query && query.get ? query.get('key') : '');
	const assets = await host.assets();
	const asset = assets.find((a) => a.key === key || a.assetId === key || a.groupKey === key);
	if (!asset) throw refusal('ASSET_NOT_FOUND', 'This wallet does not hold that asset.', 404);
	const registry = host.registry();
	const inFamily = (assetId, groupKey) => (asset.groupKey ? (groupKey || (registry.get(assetId) || {}).groupKey) === asset.groupKey : assetId === asset.assetId);
	const records = (await host.tap.stores.assets.listAssets()).filter((r) => views.isLive(r) && inFamily(r.assetId, r.groupKey));
	let depth = 0;
	for (const r of records.slice(0, 16)) {
		const file = await host.tap.stores.proofs.getProofFile(r.assetId, r.scriptKey, r.anchorOutPoint);
		if (file) depth = Math.max(depth, host.lib.fileFacts(file).depth || 0);
	}
	const issuances = [...registry.values()]
		.filter((r) => r.issued != null && inFamily(r.assetId, r.groupKey))
		.map((r) => ({ assetId: r.assetId, amount: String(r.issued), at: r.point ? r.point.timestamp : null, heldHere: records.some((x) => x.assetId === r.assetId) }));
	return { ...asset, meta: (registry.get(asset.assetId) || {}).meta || null, proofs: { count: records.length, depth }, issuances };
}

function activity(host, query) {
	const q = query && query.get ? query : new URLSearchParams();
	let list = host.listRows().sort((a, b) => b.at.created - a.at.created || (a.id < b.id ? 1 : -1));
	const key = hexKey(q.get('key'));
	if (key) list = list.filter((r) => (r.assets || []).some((a) => a.key === key || a.assetId === key));
	const kind = q.get('kind');
	if (kind) list = list.filter((r) => r.kind === kind);
	if (q.get('pending')) list = list.filter((r) => r.state !== 'complete' && r.state !== 'cancelled');
	const before = Number(q.get('before'));
	if (Number.isFinite(before) && before > 0) list = list.filter((r) => r.at.created < before);
	const limit = Math.max(1, Math.min(200, parseInt(q.get('limit'), 10) || 50));
	const page = list.slice(0, limit);
	return { rows: page.map(host.view), nextBefore: list.length > limit ? page[page.length - 1].at.created : null };
}

/* ------------------------------------------------------------------ lookup */

/** Ask the proof server for an asset this wallet has no record of, and remember the answer. */
async function lookupAndLearn(host, wanted) {
	if (!isHex(wanted, 64) && !isHex(wanted, 66)) {
		throw refusal('INVALID_PARAMS', 'An asset is named by its 64-character ID or its 66-character group key.');
	}
	if (!host.lib.canLookup) throw refusal('ASSET_NOT_FOUND', 'This wallet does not know that asset and cannot look one up.', 404);
	const universe = host.cfg.defaultUniverse;
	let found;
	try {
		found = await host.tap.freighter.lookupAsset({
			...(wanted.length === 66 ? { groupKey: unhex(wanted) } : { assetId: unhex(wanted) }),
			...(universe ? { proofCourierAddr: universe.courier } : {})
		});
	} catch (err) {
		if (isFenced(err)) throw err;
		const code = codeOf(err);
		if (/PROOF_NOT_FOUND$/.test(code) || (code === 'ERR_COURIER_HTTP' && [404, 500].includes(Number(err.status)))) {
			throw refusal('ASSET_NOT_FOUND', 'No asset with that ID was found on the proof server.', 404);
		}
		if (isCourierTrouble(err)) {
			throw refusal('PROOF_SERVER_UNREACHABLE', `The proof server could not be asked: ${plainMessage(err, 'it did not answer')}.`, 502);
		}
		throw refusal(
			'ASSET_NOT_VERIFIED',
			'The proof server answered, but its proof of that asset could not be checked against the chain. If the asset was created moments ago, try again once it has confirmed.',
			502
		);
	}
	return host.lock.run(() => host.learnIssuance(found, { supplyKnown: !found.groupKey }));
}

async function lookup(host, body) {
	host.requireUp();
	const reg = await lookupAndLearn(host, hexKey(body.id));
	return {
		asset: {
			key: reg.groupKey || reg.assetId,
			assetId: reg.assetId,
			groupKey: reg.groupKey || null,
			name: reg.name,
			type: reg.type,
			decimalDisplay: reg.type === 'collectible' ? null : reg.decimalDisplay,
			supply: { issued: reg.issued == null ? null : String(reg.issued), burned: '0', known: !reg.groupKey && reg.issued != null }
		}
	};
}

/* -------------------------------------------------------------------- mint */

async function mintQuote(host, body) {
	const { cfg, tap } = host;
	const feeRate = await host.feeRate(body.feeRate);
	const count = Math.max(1, Math.min(MAX_SEEDLINGS, parseInt(body.count, 10) || 1));
	return host.lock.run(async () => {
		host.requireReady();
		const spendableSats = await host.settledSpendable();
		let fee = null;
		// The figure is the wallet's own: the same funding a mint does, with
		// the coins it picks released again straight away. Every asset of a
		// mint shares one output, so the count does not change it.
		try {
			await tap.anchor.releaseFunding(QUOTE_ID);
			const funded = await tap.anchor.fundGenesis({
				reservationId: QUOTE_ID,
				anchorValue: BigInt(ANCHOR_SATS),
				feeRate,
				maxFee: BigInt(cfg.limits.maxFeeSats)
			});
			if (funded && funded.fee !== undefined) fee = { sats: Number(funded.fee), vbytes: funded.vsize === undefined ? null : Number(funded.vsize) };
		} catch (err) {
			if (isFenced(err)) throw err;
			const mapped = mapError(err);
			if (mapped.extensionCode === 'FEE_TOO_HIGH') throw mapped;
		} finally {
			try {
				await tap.anchor.releaseFunding(QUOTE_ID);
			} catch (err) {
				if (isFenced(err)) throw err;
			}
		}
		const feeSats = fee ? fee.sats : Math.ceil(MINT_VBYTES_GUESS * feeRate);
		const totalSats = feeSats + ANCHOR_SATS;
		const quote = {
			feeSats,
			vsize: fee && fee.vbytes ? fee.vbytes : MINT_VBYTES_GUESS,
			anchorSats: ANCHOR_SATS,
			totalSats,
			spendableSats,
			sufficient: !!fee && spendableSats >= totalSats,
			count
		};
		// A wallet that could not fund it though it holds the cost: what it
		// has to hold to build the transaction is more (errors.js).
		const working = workingSats(feeRate, feeSats);
		if (!quote.sufficient && working > totalSats && spendableSats < working) quote.onHandSats = working;
		return quote;
	});
}

/** The request's seedlings as the library takes them. Refuses what cannot be minted. */
async function prepareSeedlings(host, list) {
	const { lib, tap } = host;
	const names = new Set();
	const out = [];
	for (const s of list) {
		const name = String((s && s.name) || '').trim();
		const type = s && s.type === 'collectible' ? 'collectible' : 'normal';
		if (!name || Buffer.byteLength(name, 'utf8') > 64 || /[\r\n]/.test(name)) {
			throw refusal('INVALID_PARAMS', 'An asset needs a name of up to 64 bytes, with no line breaks.');
		}
		if (names.has(name)) throw refusal('INVALID_PARAMS', `This transaction already has an asset called ${name}.`);
		names.add(name);
		const amount = type === 'collectible' ? 1n : parseUnits(s.amount);
		let decimals = 0;
		if (type === 'normal' && s.decimalDisplay !== undefined && s.decimalDisplay !== null) {
			decimals = Number(s.decimalDisplay);
			if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
				throw refusal('INVALID_PARAMS', `An asset shows between 0 and ${MAX_DECIMALS} decimal places.`);
			}
		}
		const mode = (s.group && s.group.mode) || 'none';
		let groupKey = null;
		if (mode === 'existing') {
			groupKey = hexKey(s.group.groupKey);
			const group = isHex(groupKey, 66) ? await tap.stores.assets.getGroup(groupKey) : null;
			if (!group) throw refusal('INVALID_PARAMS', 'This wallet cannot mint more of that asset: it did not create it.');
			// More of an asset keeps the decimals the asset was created with.
			decimals = Number.isInteger(group.decimalDisplay) ? group.decimalDisplay : 0;
		} else if (mode !== 'none' && mode !== 'new') {
			throw refusal('INVALID_PARAMS', 'An asset is either fixed in supply, open to more, or more of one this wallet created.');
		}
		const meta = s.meta && s.meta.data != null && String(s.meta.data) !== '' ? { type: s.meta.type === 'json' ? 'json' : 'text', data: String(s.meta.data) } : null;
		if (meta && meta.type === 'json') {
			let parsed;
			try {
				parsed = JSON.parse(meta.data);
			} catch (_) {
				parsed = null;
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw refusal('INVALID_PARAMS', 'The metadata is not valid. JSON metadata has to be a JSON object.');
			}
		}
		const reveal = lib.metaReveal(meta, decimals);
		out.push({
			name,
			type,
			decimals,
			meta,
			seedling: {
				name,
				type: type === 'collectible' ? lib.AssetType.Collectible : lib.AssetType.Normal,
				amount,
				...(reveal ? { meta: reveal } : {}),
				...(mode === 'new' ? { newGroup: true } : {}),
				...(groupKey ? { groupKey: unhex(groupKey) } : {})
			}
		});
	}
	return out;
}

/** Cancel a batch this request made, and whatever is still queued. */
async function abandonBatch(host, batchId) {
	const tries = [];
	if (batchId) tries.push(batchId);
	try {
		const pending = await host.tap.minter.pendingBatch();
		if (pending && pending.id !== batchId && !host.rows.get(`committed/${pending.id}`)) tries.push(pending.id);
	} catch (err) {
		if (isFenced(err)) throw err;
	}
	for (const id of tries) {
		try {
			await host.tap.minter.cancel(id);
		} catch (err) {
			if (isFenced(err)) throw err;
			host.say('warn', `assets: a mint that was not sent could not be cancelled: ${plainMessage(err)}`);
		}
	}
}

async function mint(host, body, key) {
	const { cfg, tap, lib } = host;
	const B = STATES.Batch;
	return host.lock.run(async () => {
		const again = replay(host, 'mint', key, body);
		if (again) return again;
		host.requireReady();
		const list = Array.isArray(body.seedlings) ? body.seedlings : [];
		if (list.length === 0) throw refusal('INVALID_PARAMS', 'A mint needs at least one asset.');
		if (list.length > MAX_SEEDLINGS) throw refusal('INVALID_PARAMS', `One transaction mints at most ${MAX_SEEDLINGS} assets.`);
		const feeRate = await host.feeRate(body.feeRate);
		let ceiling = cfg.limits.maxFeeSats;
		if (body.maxFeeSats !== undefined && body.maxFeeSats !== null) {
			const asked = Number(body.maxFeeSats);
			if (!Number.isFinite(asked) || asked < 0) throw refusal('INVALID_PARAMS', 'The most this mint may pay in fees must be a number of sats.');
			ceiling = Math.min(ceiling, Math.floor(asked));
		}
		const prepared = await prepareSeedlings(host, list);
		const spendable = await host.settledSpendable();
		const guess = Math.ceil(MINT_VBYTES_GUESS * feeRate);

		// Whatever an earlier request left queued is not part of this one.
		await abandonBatch(host, null);
		let batchId = null;
		let funded;
		let fee;
		try {
			for (const p of prepared) batchId = (await tap.minter.queue(p.seedling)).batchId;
			batchId = (await tap.minter.freeze({ feeRate, maxFee: BigInt(ceiling) })).id;
			funded = await tap.minter.advance(batchId, B.Committed);
			fee = lib.batchFee(funded);
			if (!fee) throw refusal('FEE_UNKNOWN', 'The wallet could not work out the fee, so nothing was minted.', 500);
			if (fee.sats > ceiling) {
				throw refusal('FEE_TOO_HIGH', `The fee is ${fee.sats} sats, above the ${ceiling} this request allows.`, 400, { feeSats: fee.sats, maxFeeSats: ceiling });
			}
		} catch (err) {
			if (isFenced(err)) throw err;
			await abandonBatch(host, batchId);
			throw mapError(err, { spendable, needed: guess + ANCHOR_SATS, feeSats: guess, anchorSats: ANCHOR_SATS, feeRate });
		}

		const minted = lib.batchAssets(funded);
		const rowId = `mint-${batchId}`;
		const of = (name) => prepared.find((p) => p.name === name) || {};
		const row = views.newRow({
			id: rowId,
			kind: 'mint',
			ref: batchId,
			created: host.now(),
			assets: minted.map((a) => views.brief({ ...a, type: views.typeName(a.type), decimalDisplay: of(a.name).decimals }, a.amount)),
			feeSats: fee.sats,
			vbytes: fee.vbytes,
			satsPerVbyte: feeRate,
			anchorSats: ANCHOR_SATS,
			clientRef: key || null
		});
		const fresh = minted.filter((a) => !host.rows.get(`asset/${a.assetId}`)).map((a) => a.assetId);
		// From here the mint is the user's decision: the loop finishes it.
		host.rows.tx(() => {
			host.rows.put(`committed/${batchId}`, { kind: 'mint', at: host.now() });
			journal(host, 'mint', key, body, { rowId });
			host.rows.put(`row/${rowId}`, row);
			for (const a of minted) {
				const p = of(a.name);
				host.learn({
					assetId: a.assetId,
					groupKey: a.groupKey,
					name: a.name,
					type: views.typeName(a.type),
					decimalDisplay: p.decimals || 0,
					genesis: a.genesis,
					issued: a.amount.toString(),
					meta: p.meta ? { type: p.meta.type, text: p.meta.data, bytes: Buffer.byteLength(p.meta.data, 'utf8') } : null,
					mintedHere: true,
					supplyKnown: true
				});
			}
		});

		try {
			await tap.minter.advance(batchId, B.Broadcast);
		} catch (err) {
			if (isFenced(err)) throw err;
			let now = null;
			try {
				now = await tap.minter.getBatch(batchId);
			} catch (_) {
				now = null;
			}
			const signed = !!(now && now.genesis && now.genesis.signedTx);
			if (now && !signed && now.state < B.Broadcast) {
				// Nothing was signed, so nothing can have been sent: undo it all.
				await abandonBatch(host, batchId);
				host.rows.tx(() => {
					host.rows.del(`committed/${batchId}`);
					if (key) host.rows.del(journalKey('mint', key));
					host.rows.del(`row/${rowId}`);
					for (const id of fresh) host.rows.del(`asset/${id}`);
				});
				throw mapError(err, { spendable, needed: fee.sats + ANCHOR_SATS, feeSats: fee.sats, anchorSats: ANCHOR_SATS, feeRate });
			}
			// A signed transaction may have reached the network. It is kept,
			// and the loop sends it again until the network has it.
			host.mem.failures.set(rowId, { code: 'BROADCAST_FAILED', message: plainMessage(err, 'The network did not take the transaction'), retrying: true });
		}
		const stored = await host.refreshMint(batchId);
		host.markDirty();
		host.nudge();
		return { row: host.view(stored) };
	});
}

/* ----------------------------------------------------------------- receive */

/** Read an address, or refuse it in the dashboard's terms. */
function wrongNetwork(host, hrp) {
	const theirs = Object.keys(NETWORKS).find((n) => NETWORKS[n].hrp === hrp);
	return refusal('WRONG_NETWORK', `That address is for ${theirs || 'another network'}, and this wallet is on ${host.cfg.network}.`);
}

function readAddress(host, raw) {
	const text = String(raw || '').trim();
	if (!text) throw refusal('BAD_ADDRESS', 'A Taproot Assets address is needed.');
	const cut = text.lastIndexOf('1');
	const hrp = cut > 0 ? text.slice(0, cut).toLowerCase() : '';
	if (TAP_HRPS.includes(hrp) && hrp !== host.cfg.hrp) throw wrongNetwork(host, hrp);
	let decoded;
	try {
		decoded = host.lib.decodeAddress(text);
	} catch (err) {
		const mapped = mapError(err);
		if (mapped.extensionCode) throw mapped;
		throw refusal('BAD_ADDRESS', 'That is not a Taproot Assets address this wallet can read.');
	}
	// Whatever the text looked like, what it decodes to decides.
	if (decoded.hrp !== host.cfg.hrp) throw wrongNetwork(host, decoded.hrp);
	return decoded;
}

async function createAddress(host, body) {
	const { cfg, tap, lib } = host;
	host.requireUp();
	const universe = cfg.defaultUniverse;
	if (!universe) throw refusal('NO_PROOF_SERVER', 'This wallet has no proof server, so it cannot make an address to receive at.', 503);
	const wanted = hexKey(body.assetId || body.key);
	const held = views.heldByAsset(await tap.stores.assets.listAssets());
	let reg = host.known(wanted, held);
	if (!reg || !reg.genesis) reg = await lookupAndLearn(host, wanted);
	const amount = reg.type === 'collectible' ? 1n : parseUnits(body.amount);
	return host.lock.run(async () => {
		host.requireUp();
		let raw;
		try {
			raw = await tap.freighter.createAddress({
				genesis: lib.decodeGenesis(reg.genesis),
				amount,
				version: lib.AddressVersion.V1,
				proofCourierAddr: universe.courier,
				...(reg.groupKey ? { groupKey: unhex(reg.groupKey) } : {})
			});
		} catch (err) {
			throw mapError(err);
		}
		const encoded = lib.encodeAddress(raw);
		const id = host.receiveRowId(encoded);
		const row = views.newRow({
			id,
			kind: 'receive',
			ref: encoded,
			created: host.now(),
			state: 'waiting',
			assets: [views.brief(reg, amount)],
			address: encoded,
			courier: universe.host
		});
		host.rows.put(`row/${id}`, row);
		host.markDirty();
		host.emitRow(row);
		host.nudge();
		return {
			address: {
				id,
				encoded,
				assetId: reg.assetId,
				groupKey: reg.groupKey || null,
				amount: amount.toString(),
				version: 1,
				courier: universe.courier,
				createdAt: row.at.created
			},
			row: host.view(row)
		};
	});
}

async function decodeAddress(host, body) {
	const { cfg, tap } = host;
	const addr = readAddress(host, body.address);
	const own = !!(await tap.stores.receives.getReceive(addr.encoded));
	const reg = host.registry().get(addr.assetId);
	const key = addr.groupKey || addr.assetId;
	const asset = (await host.assets()).find((a) => a.key === key || a.assetId === addr.assetId) || null;
	const parsed = parseCourier(addr.courier);
	return {
		network: cfg.network,
		assetId: addr.assetId,
		groupKey: addr.groupKey,
		amount: addr.amount.toString(),
		type: reg ? reg.type : asset ? asset.type : 'normal',
		version: addr.version,
		courier: { uri: addr.courier, host: parsed ? parsed.hostPort : null, known: !!restFor(cfg, addr.courier) },
		asset,
		own
	};
}

/** Look now, for one row: its payment, its proof, or its place in a block. */
async function look(host, body, { publish = false } = {}) {
	host.requireUp();
	const row = host.findRow(body.id);
	if (publish && row.kind === 'mint' && host.mem.guarded) await host.publishPending({ force: true });
	return host.lock.run(async () => {
		if (!views.isTerminal(row.state) && host.mem.guarded) {
			if (row.kind === 'receive') await host.stepReceive(row.ref, { force: true });
			else if (!host.rows.get(`committed/${row.ref}`)) {
				// Only work this wallet committed to is ever moved on.
			} else if (row.kind === 'mint') await host.stepBatch(row.ref, { force: true });
			else await host.stepParcel(row.ref, row.kind, { force: true });
		}
		const fresh = (await host.refreshRow(row)) || row;
		host.nudge();
		return { row: host.view(fresh) };
	});
}

const checkAddress = (host, body) => look(host, body);
const retryProof = (host, body) => look(host, body, { publish: true });

/* ------------------------------------------------- proofs handed over by file */

/*
 * A transfer is complete for the person receiving once they hold its proof.
 * A proof server is the usual way it reaches them, and not the only one: the
 * sender's wallet has the file, and can hand it over by any means. These two
 * are that hand-over. Nothing about a file is trusted for where it came
 * from: the library verifies an imported one against the chain and against
 * the address it pays, exactly as it does one a server gave it.
 */

/** The proof file of a send's payment, for the sender to give to the recipient. */
async function exportProof(host, query) {
	const { tap, cfg } = host;
	const S = STATES.Send;
	host.requireUp();
	const row = host.findRow(query && query.get ? query.get('id') : '');
	if (row.kind !== 'send') throw refusal('NO_PROOF_FILE', 'Only a send has a proof file to hand to someone.', 400);
	const parcel = await tap.freighter.getParcel(row.ref);
	const built = parcel.state >= S.TransferProofs && parcel.state !== S.Cancelled ? (parcel.proofs || []).filter((p) => p.address) : [];
	const out = built.find((p) => p.address === row.address) || built[0];
	if (!out) {
		const n = cfg.minConfirmations;
		throw refusal('PROOF_NOT_READY', `The proof file exists once the transaction is ${n} block${n === 1 ? '' : 's'} deep.`, 409);
	}
	const l = out.locator;
	let bytes;
	try {
		bytes = Buffer.from(await tap.freighter.exportProof(unhex(l.assetId), unhex(l.scriptKey), l.anchorOutPoint));
	} catch (err) {
		if (isFenced(err)) throw err;
		throw refusal('PROOF_NOT_READY', 'This wallet does not have that proof file any more.', 404);
	}
	const txid = l.anchorOutPoint.split(':')[0];
	return {
		id: row.id,
		fileName: `proof-${l.assetId.slice(0, 8)}-${txid.slice(0, 8)}.assetproof`,
		file: bytes.toString('base64'),
		bytes: bytes.length,
		assetId: l.assetId,
		address: out.address,
		txid
	};
}

/**
 * The sender's word that the recipient was given a send's proof as a file,
 * or that word taken back (`handedOver: false`). It changes how the send
 * reads and nothing else: the wallet cannot know what the recipient did
 * with a file, and goes on offering the proof to the proof server.
 */
async function markProofHandedOver(host, body) {
	return host.lock.run(async () => {
		host.requireReady();
		const row = host.findRow(body.id);
		if (row.kind !== 'send') throw refusal('NO_PROOF_FILE', 'Only a send has a proof file to hand to someone.', 400);
		if (row.state === 'complete') return { row: host.view(row) };
		if (row.state !== 'proofs') {
			const n = host.cfg.minConfirmations;
			throw refusal('PROOF_NOT_READY', `The proof file exists once the transaction is ${n} block${n === 1 ? '' : 's'} deep.`, 409);
		}
		const at = body.handedOver === false ? null : row.handedOver || host.now();
		if ((row.handedOver || null) === at) return { row: host.view(row) };
		const next = { ...row, handedOver: at };
		host.rows.put(`row/${row.id}`, next);
		host.markDirty();
		host.emitRow(next);
		// The count beside the tab's name is worked out on the loop's next pass.
		host.nudge();
		return { row: host.view(next) };
	});
}

function proofFileBytes(body) {
	const text = typeof body.file === 'string' ? body.file.trim() : '';
	if (!text) throw refusal('BAD_PROOF_FILE', 'A proof file is needed.');
	// Four characters of base64 carry three bytes.
	if (text.length > Math.ceil(MAX_PROOF_FILE_BYTES / 3) * 4) {
		throw refusal('BAD_PROOF_FILE', `That file is larger than a proof file this wallet takes (${MAX_PROOF_FILE_BYTES / 1024 / 1024} MB).`, 413);
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) throw refusal('BAD_PROOF_FILE', 'That file is not a Taproot Assets proof file this wallet can read.');
	return Buffer.from(text, 'base64');
}

/**
 * Take the proof file of a payment to one of this wallet's addresses. The
 * answer says what became of it: `complete` (verified and the asset is
 * held), `kept` (it will be verified once the payment is deep enough, or
 * once what the check needs can be reached), or `already`.
 */
async function importProof(host, body) {
	const { tap, lib } = host;
	const R = STATES.Receive;
	host.requireReady();
	const bytes = proofFileBytes(body || {});
	let facts;
	try {
		facts = lib.proofFacts(bytes);
	} catch (err) {
		if (isFenced(err)) throw err;
		throw refusal('BAD_PROOF_FILE', 'That file is not a Taproot Assets proof file this wallet can read.');
	}
	const xOnly = (key) => String(key).slice(-64);
	return host.lock.run(async () => {
		host.requireReady();
		let addr = null;
		for (const r of await tap.stores.receives.listReceives()) {
			let candidate;
			try {
				candidate = lib.decodeAddress(r.id);
			} catch (_) {
				continue;
			}
			if (xOnly(candidate.scriptKey) === xOnly(facts.scriptKey)) {
				addr = candidate;
				break;
			}
		}
		if (!addr) {
			throw refusal('PROOF_NOT_OURS', 'This proof is not for an address this wallet made. It has to be the file of a payment to this wallet.', 404);
		}
		const encoded = addr.encoded;
		const rowId = host.receiveRowId(encoded);
		const answer = async (extra) => {
			const row = (await host.refreshReceive(encoded)) || host.getRow(rowId);
			host.nudge();
			return { ...extra, row: row ? host.view(row) : null };
		};
		let record = await tap.stores.receives.getReceive(encoded);
		if (record.state >= R.Complete) return answer({ result: 'already' });
		if (record.state === R.Registered) {
			// The payment is found first. A proof is only ever taken for an
			// output this wallet has itself seen on the chain.
			try {
				await tap.freighter.receive(addr.raw, R.Located);
			} catch (err) {
				if (isFenced(err)) throw err;
				if (isNotYet(err)) {
					throw refusal('PAYMENT_NOT_SEEN', 'The payment this proof is for is not in a block yet. Import the file once its transaction has confirmed.', 409);
				}
				throw mapError(err);
			}
			record = await tap.stores.receives.getReceive(encoded);
		}
		const l = record.locator || {};
		if (l.anchorOutPoint !== facts.anchorOutPoint || l.assetId !== facts.assetId) {
			throw refusal('PROOF_OTHER_PAYMENT', 'This proof is for a different payment than the one this wallet found for that address.', 409);
		}
		if (record.state === R.Located) host.keepHanded(l, bytes.toString('hex'), encoded);
		let error = null;
		try {
			await tap.freighter.receive(addr.raw);
		} catch (err) {
			if (isFenced(err)) throw err;
			error = err;
		}
		if (error && isProofInvalid(error)) {
			host.dropHanded(l);
			// The library's reason when it gives one; some of its errors are a code alone.
			const why = plainMessage(error, '');
			throw refusal('PROOF_INVALID', `This proof file did not pass verification, so nothing was taken from it${why ? `: ${why}` : ''}.`.replace(/\.\.$/, '.'), 422);
		}
		// Whatever the proof server said about this payment before is over.
		host.mem.failures.delete(rowId);
		host.mem.retries.delete(rowId);
		if (!error) {
			host.dropHanded(l);
			return answer({ result: 'complete' });
		}
		// Kept: the loop finishes it from the file, with no server asked.
		return answer({ result: 'kept', waitingFor: isNotYet(error) ? 'confirmations' : 'check', reason: isNotYet(error) ? null : plainMessage(error) });
	});
}

/* ------------------------------------------------------------ send and burn */

function insufficientAsset(needed, held) {
	const free = held ? held.free : 0n;
	const busy = held && held.total >= needed;
	return refusal(
		'INSUFFICIENT_ASSET_BALANCE',
		busy
			? 'Part of this asset is in a send that has not confirmed yet. Wait for it to confirm, then try again.'
			: 'This wallet does not hold that much of the asset on-chain.',
		409,
		{ needed: needed.toString(), available: free.toString() }
	);
}

/**
 * Fund and sign a transfer without sending it, and keep it as the wallet's
 * one open preview. The caller holds the lock and has dropped the last one.
 */
async function buildPreview(host, { kind, route, key, body, queue, asset, amount, feeRate, anchorSats, courier, onchain, extra }) {
	const { cfg, tap, lib } = host;
	const spendableSats = await host.settledSpendable();
	const guess = Math.ceil(SEND_VBYTES_GUESS * feeRate);
	let parcelId = null;
	try {
		parcelId = (await queue()).id;
		const ready = await tap.freighter.advance(parcelId, STATES.Send.StorePreBroadcast);
		const fee = lib.parcelFee(ready);
		if (!fee) throw refusal('FEE_UNKNOWN', 'The wallet could not work out the fee, so nothing was prepared.', 500);
		if (fee.sats > cfg.limits.maxFeeSats) {
			throw refusal('FEE_TOO_HIGH', `The fee is ${fee.sats} sats, above the ${cfg.limits.maxFeeSats} this wallet allows for an asset transaction.`, 400, {
				feeSats: fee.sats,
				maxFeeSats: cfg.limits.maxFeeSats
			});
		}
		const expiresAt = host.now() + cfg.previewTtlMs;
		const answer = {
			previewId: crypto.randomBytes(12).toString('hex'),
			expiresAt,
			asset,
			amount: amount.toString(),
			change: (onchain > amount ? onchain - amount : 0n).toString(),
			fee: { sats: fee.sats, vbytes: fee.vbytes, feeRate },
			btc: { anchorSats, totalSats: fee.sats + anchorSats, spendableSats },
			courier: courier || null,
			warnings: courier && courier.reachable === false ? ['COURIER_UNREACHABLE'] : []
		};
		host.rows.tx(() => {
			host.rows.put('preview', { previewId: answer.previewId, kind, parcelId, expiresAt, answer, ...extra });
			journal(host, route, key, body, { answer });
		});
		host.armPreview(expiresAt);
		return answer;
	} catch (err) {
		if (isFenced(err)) throw err;
		if (parcelId) {
			try {
				await tap.freighter.cancel(parcelId);
			} catch (cancelErr) {
				if (isFenced(cancelErr)) throw cancelErr;
				host.say('warn', `assets: a preview that failed could not be cancelled: ${plainMessage(cancelErr)}`);
			}
		}
		throw mapError(err, { spendable: spendableSats, needed: guess + anchorSats, feeSats: guess, anchorSats, feeRate });
	}
}

async function prepareSend(host, body, key) {
	const { cfg, tap, lib } = host;
	const addr = readAddress(host, body.address);
	const feeRate = await host.feeRate(body.feeRate);
	if (addr.version === lib.AddressVersion.V2) {
		throw refusal(
			'UNSUPPORTED_ADDRESS',
			'That is a version 2 address, and this wallet cannot deliver a proof to one yet. Ask for a version 1 address.'
		);
	}
	const parsed = parseCourier(addr.courier);
	if (!restFor(cfg, addr.courier)) {
		throw refusal(
			'UNKNOWN_COURIER',
			'This address names a proof server this wallet does not know how to reach, so the proof could not be delivered. Nothing was sent.'
		);
	}
	const reachable = await host.reachable(addr.courier);
	return host.lock.run(async () => {
		const again = replay(host, 'send/prepare', key, body);
		if (again) return again;
		host.requireReady();
		if (await tap.stores.receives.getReceive(addr.encoded)) {
			throw refusal('OWN_ADDRESS', "That is one of this wallet's own addresses. Sending to it would only pay a fee.");
		}
		await host.dropPreview();
		const held = views.heldByAsset(await tap.stores.assets.listAssets()).get(addr.assetId);
		if (!held || held.total === 0n) throw refusal('ASSET_NOT_FOUND', 'This wallet does not hold that asset.', 404);
		if (addr.amount > held.free) throw insufficientAsset(addr.amount, held);
		const reg = host.registry().get(addr.assetId) || { assetId: addr.assetId, groupKey: addr.groupKey, type: 'normal' };
		const asset = views.brief(reg);
		const mine = (await host.assets()).find((a) => a.key === asset.key);
		return buildPreview(host, {
			kind: 'send',
			route: 'send/prepare',
			key,
			body,
			queue: () => tap.freighter.queueSend({ addresses: [addr.raw], feeRate, maxFee: BigInt(cfg.limits.maxFeeSats) }),
			asset,
			amount: addr.amount,
			feeRate,
			anchorSats: ANCHOR_SATS,
			courier: { uri: addr.courier, host: parsed ? parsed.hostPort : null, reachable },
			onchain: mine ? BigInt(mine.balance.onchain) : held.total,
			extra: { address: addr.encoded }
		});
	});
}

async function prepareBurn(host, body, key) {
	const { cfg, tap } = host;
	const feeRate = await host.feeRate(body.feeRate);
	return host.lock.run(async () => {
		const again = replay(host, 'burn/prepare', key, body);
		if (again) return again;
		host.requireReady();
		const held = views.heldByAsset(await tap.stores.assets.listAssets());
		const registry = host.registry();
		const groupOf = (id) => (held.get(id) && held.get(id).groupKey) || (registry.get(id) || {}).groupKey || null;
		// A burn destroys units of one issuance. Of a group, the one named, or
		// the one the wallet can spend most of.
		let assetId = hexKey(body.assetId);
		const wanted = hexKey(body.key);
		if (!held.has(assetId)) assetId = held.has(wanted) ? wanted : '';
		if (!assetId && wanted) {
			const family = [...held.keys()].filter((id) => groupOf(id) === wanted);
			family.sort((a, b) => (held.get(a).free === held.get(b).free ? 0 : held.get(a).free > held.get(b).free ? -1 : 1));
			assetId = family[0] || '';
		}
		if (!assetId) throw refusal('ASSET_NOT_FOUND', 'This wallet does not hold that asset.', 404);
		const reg = registry.get(assetId) || { assetId, groupKey: groupOf(assetId), type: 'normal' };
		const amount = reg.type === 'collectible' ? 1n : parseUnits(body.amount);
		await host.dropPreview();
		const mineHeld = views.heldByAsset(await tap.stores.assets.listAssets()).get(assetId);
		if (!mineHeld || amount > mineHeld.free) throw insufficientAsset(amount, mineHeld);
		const asset = views.brief(reg);
		const mine = (await host.assets()).find((a) => a.key === asset.key);
		return buildPreview(host, {
			kind: 'burn',
			route: 'burn/prepare',
			key,
			body,
			queue: () => tap.freighter.queueBurn({ assetId: unhex(assetId), amount, feeRate, maxFee: BigInt(cfg.limits.maxFeeSats) }),
			asset,
			amount,
			feeRate,
			anchorSats: 0,
			courier: null,
			onchain: mine ? BigInt(mine.balance.onchain) : mineHeld.total,
			extra: {}
		});
	});
}

const expired = () => refusal('PREVIEW_EXPIRED', 'That preview has expired. Prepare it again.', 410);

async function commit(host, kind, body, key) {
	const { tap } = host;
	const S = STATES.Send;
	const route = `${kind}/commit`;
	return host.lock.run(async () => {
		const again = replay(host, route, key, body);
		if (again) return again;
		host.requireReady();
		const preview = host.rows.get('preview');
		if (!preview || preview.previewId !== body.previewId || preview.kind !== kind) throw expired();
		if (preview.expiresAt < host.now()) {
			await host.dropPreview();
			throw expired();
		}
		if (kind === 'burn' && String(body.confirmAmount) !== preview.answer.amount) {
			throw refusal('INVALID_PARAMS', 'The amount to confirm does not match the amount that was previewed.');
		}
		const parcelId = preview.parcelId;
		const rowId = `${kind}-${parcelId}`;
		const answer = preview.answer;
		const row = views.newRow({
			id: rowId,
			kind,
			ref: parcelId,
			created: host.now(),
			assets: [{ ...answer.asset, amount: answer.amount }],
			feeSats: answer.fee.sats,
			vbytes: answer.fee.vbytes,
			satsPerVbyte: answer.fee.feeRate,
			anchorSats: answer.btc.anchorSats,
			address: preview.address || null,
			courier: answer.courier ? answer.courier.host : null,
			clientRef: key || null
		});
		// The user's yes, on disk before the transaction is sent.
		host.rows.tx(() => {
			host.rows.put(`committed/${parcelId}`, { kind, at: host.now() });
			journal(host, route, key, body, { rowId });
			host.rows.put(`row/${rowId}`, row);
			host.rows.del('preview');
		});
		host.disarmPreview();
		try {
			await tap.freighter.advance(parcelId, S.WaitTxConf);
		} catch (err) {
			if (isFenced(err)) throw err;
			let now = null;
			try {
				now = await tap.freighter.getParcel(parcelId);
			} catch (_) {
				now = null;
			}
			if (!now || now.state < S.Broadcast || now.state === S.Cancelled) {
				// The library sends only once it has stored that it will, so a
				// parcel short of that was never on the network: undo it all.
				try {
					await tap.freighter.cancel(parcelId);
				} catch (cancelErr) {
					if (isFenced(cancelErr)) throw cancelErr;
				}
				host.rows.tx(() => {
					host.rows.del(`committed/${parcelId}`);
					if (key) host.rows.del(journalKey(route, key));
					host.rows.del(`row/${rowId}`);
				});
				throw mapError(err, { spendable: host.spendable(), needed: answer.btc.totalSats, feeSats: answer.fee.sats, anchorSats: answer.btc.anchorSats, feeRate: answer.fee.feeRate });
			}
			host.mem.failures.set(rowId, { code: 'BROADCAST_FAILED', message: plainMessage(err, 'The network did not take the transaction'), retrying: true });
		}
		const stored = await host.refreshTransfer(parcelId, kind);
		host.markDirty();
		host.emitEvent('balance', { key: answer.asset.key });
		host.nudge();
		return { row: host.view(stored) };
	});
}

async function cancelPreview(host, kind, body) {
	return host.lock.run(async () => {
		const preview = host.rows.get('preview');
		if (preview && preview.previewId === body.previewId && preview.kind === kind) await host.dropPreview();
		return { cancelled: true };
	});
}

async function rebroadcast(host, body) {
	const { tap, lib } = host;
	const S = STATES.Send;
	return host.lock.run(async () => {
		host.requireReady();
		const row = host.findRow(body.id);
		let signed = null;
		if (row.kind === 'mint') {
			const batch = await tap.minter.getBatch(row.ref);
			signed = (batch.genesis && batch.genesis.signedTx) || null;
		} else if (row.kind === 'send' || row.kind === 'burn') {
			const parcel = await tap.freighter.getParcel(row.ref);
			if (parcel.state >= S.Broadcast && parcel.state !== S.Cancelled) signed = parcel.signedTx || null;
		}
		if (!signed || !host.rows.get(`committed/${row.ref}`)) {
			throw refusal('NOT_BROADCAST', 'This has no transaction to send again.', 409);
		}
		try {
			await tap.anchor.broadcast(lib.decodeTx(signed));
		} catch (err) {
			if (isFenced(err)) throw err;
			throw refusal('BROADCAST_FAILED', `The network did not take the transaction: ${plainMessage(err, 'it could not be reached')}.`, 502);
		}
		const next = { ...row, seenHeight: host.tip(), sentAgainAt: host.now() };
		host.rows.put(`row/${row.id}`, next);
		host.emitRow(next);
		host.nudge();
		return { row: host.view(next) };
	});
}

/* ---------------------------------------------------------------- settings */

async function testProofServer(host, body) {
	const rest = String(body.rest || '').trim();
	if (!rest) throw refusal('INVALID_PARAMS', 'A proof server address is needed to test it.');
	return host.net.test(rest);
}

async function exportBackup(host) {
	host.requireUp();
	return host.exportNow();
}

async function importBackup(host, body) {
	const backup = require('./backup');
	host.requireUp();
	const source = body && body.backup && typeof body.backup === 'object' ? body.backup : null;
	if (!source && !host.cfg.importFile) throw refusal('BAD_BACKUP', 'There is no assets backup waiting to be restored.', 404);
	const res = await host.lock.run(async () => {
		// Only reads, and the node's word on its channels: nothing of the
		// Lightning service that could call back is asked under the lock.
		require('./lightning').refuseImportWhileLive(host);
		const out = await host.importNow(source || backup.readBackupFile(host.cfg.importFile));
		host.mem.importError = null;
		return out;
	});
	await host.guard();
	host.nudge();
	host.emitStatus();
	return { imported: res.imported, same: res.same };
}

module.exports = {
	parseUnits,
	replay,
	journal,
	journalKey,
	lookupAndLearn,
	balances,
	assetDetail,
	activity,
	lookup,
	mintQuote,
	mint,
	createAddress,
	decodeAddress,
	checkAddress,
	retryProof,
	exportProof,
	importProof,
	markProofHandedOver,
	MAX_PROOF_FILE_BYTES,
	prepareSend,
	prepareBurn,
	commit,
	cancelPreview,
	rebroadcast,
	testProofServer,
	exportBackup,
	importBackup
};
