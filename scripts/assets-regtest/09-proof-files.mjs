// A proof handed over as a file. The proof server is told to take no
// transfer proofs from outside, which is what a public server that refuses
// this app's transfers does: the sender is told no, and the recipient's
// wallet waits for a proof that never comes. The sender then takes the proof
// file out and the recipient takes it in, with no server between them.
//
// tapd judges the result three ways. Each exported file is given to its own
// `tapcli proofs verify`. An asset whose history went through two files is
// sent to it, and it credits a transfer only after verifying every proof in
// that history. And once the server takes proofs again, the sends it refused
// are offered again and finish by themselves.
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { newWallet, x, post, idem, mine, rowOf, rowReaches, onchain, status, refusal, waitFor, check, done, mintAndConfirm, tapcli, tapdKnows, tapdBalance, tapdVerifies } from './lib.mjs';

/** Whether tapd's universe takes transfer proofs from outside. It always hands out what it has. */
const serverTakesTransfers = (allow) =>
	tapcli('universe', 'federation', 'config', 'global', '--proof_type', 'transfer', `--allow_insert=${allow}`, '--allow_export=true');
const exportProof = (id, rowId) => x(id, `/proofs/export?id=${rowId}`);

// A forged proof file: a real one decoded, changed, and put back together
// with every checksum of the file right, so that only verifying what it
// claims can tell it from a true one. Built with the library the wallets
// run, from the engine prefix the manager uses.
const PREFIX = process.env.ENGINE_PREFIX || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.engine-prefix');
function forger() {
	const tap = createRequire(path.join(PREFIX, 'node_modules', 'noop.js'))('ts-tap');
	return (fileBytes, change) => {
		const file = tap.proof.decodeFile(Buffer.from(fileBytes));
		const proofs = tap.proof.fileProofs(file);
		change(proofs);
		return Buffer.from(tap.proof.encodeFile(tap.proof.newFile(file.version, proofs))).toString('base64');
	};
}
const refusedBy = (row) => !!row && row.state === 'proofs' && !!row.failure && row.failure.code === 'PROOF_REFUSED';
const waitingOn = (row) => !!row && row.state === 'proofs' && !!row.failure && row.failure.code === 'PROOF_UNAVAILABLE';

const A = await newWallet('Files sender');
const B = await newWallet('Files receiver');
const C = await newWallet('Files bystander');
const mint = await mintAndConfirm(A.id, [{ name: `by-file-${Date.now().toString(36)}`, type: 'normal', amount: '1000' }]);
const assetId = mint.assets[0].assetId;
await waitFor('tapd knows the asset from the universe', () => tapdKnows(assetId));

const made = await post(B.id, '/addresses', { key: assetId, amount: '300' });
const other = await post(C.id, '/addresses', { key: assetId, amount: '300' });

let restored = false;
try {
	serverTakesTransfers(false);

	// 1. The send confirms, and the server says no to its proof.
	const p = await post(A.id, '/send/prepare', { address: made.address.encoded, feeRate: 2 }, idem());
	const sent = await post(A.id, '/send/commit', { previewId: p.previewId }, idem());
	const early = await refusal(() => exportProof(A.id, sent.row.id));
	check('there is no proof file before the transaction is in a block', !!early && early.code === 'PROOF_NOT_READY' && early.status === 409, early ? `${early.status} ${early.code}` : 'answered');
	const earlyMark = await refusal(() => post(A.id, '/proofs/handed-over', { id: sent.row.id }));
	check('and nothing to mark as handed over', !!earlyMark && earlyMark.code === 'PROOF_NOT_READY', earlyMark ? earlyMark.code : 'accepted');
	mine(1);
	const refusedRow = await waitFor('the sender is told the server refused the proof', async () => {
		const row = await rowOf(A.id, sent.row.id);
		return refusedBy(row) ? row : null;
	});
	check('the refusal carries the server\'s own words, and the wallet goes on offering', refusedRow.failure.retrying === true && refusedRow.failed === false && refusedRow.failure.message.length > 0, refusedRow.failure.message);
	check('the sender kept its change', (await onchain(A.id, assetId)) === '700', await onchain(A.id, assetId));
	const stuck = await waitFor('the recipient sees the payment and waits for its proof', async () => {
		await post(B.id, '/addresses/check', { id: made.row.id }).catch(() => {});
		const row = await rowOf(B.id, made.row.id);
		return waitingOn(row) ? row : null;
	});
	check('the recipient holds nothing yet', (await onchain(B.id, assetId)) === '0' && stuck.txid === sent.row.txid, await onchain(B.id, assetId));

	// 2. The sender takes the proof file out.
	const out = await exportProof(A.id, sent.row.id);
	const bytes = Buffer.from(out.file, 'base64');
	check('the file is a Taproot Assets proof file for this payment', bytes.subarray(0, 4).toString('latin1') === 'TAPF' && out.bytes === bytes.length && out.txid === sent.row.txid && out.address === made.address.encoded && out.assetId === assetId, JSON.stringify({ bytes: out.bytes, name: out.fileName }));
	check('and is named for its asset and transaction', out.fileName === `proof-${assetId.slice(0, 8)}-${sent.row.txid.slice(0, 8)}.assetproof`, out.fileName);
	const verdict = tapdVerifies(bytes);
	check('tapd, handed the same file, verifies it', verdict.valid === true, JSON.stringify({ valid: verdict.valid, said: verdict.said }));

	// 3. Files the recipient must not take anything from.
	const junk = await refusal(() => post(B.id, '/proofs/import', { file: Buffer.from('not a proof file at all').toString('base64') }));
	check('a file that is not a proof is refused', !!junk && junk.code === 'BAD_PROOF_FILE' && junk.status === 400, junk ? `${junk.status} ${junk.code}` : 'accepted');
	const bent = Buffer.from(bytes);
	bent[bent.length - 40] ^= 0x01;
	const tampered = await refusal(() => post(B.id, '/proofs/import', { file: bent.toString('base64') }));
	check('a proof file with one bit changed is refused', !!tampered && ['BAD_PROOF_FILE', 'PROOF_INVALID', 'PROOF_NOT_OURS', 'PROOF_OTHER_PAYMENT'].includes(tampered.code), tampered ? `${tampered.status} ${tampered.code}` : 'accepted');
	const notTheirs = await refusal(() => post(C.id, '/proofs/import', { file: out.file }));
	check('a wallet that was not paid refuses a real proof of somebody else\'s payment', !!notTheirs && notTheirs.code === 'PROOF_NOT_OURS' && notTheirs.status === 404, notTheirs ? `${notTheirs.status} ${notTheirs.code}` : 'accepted');
	const short = await refusal(() => post(B.id, '/proofs/import', { file: bytes.subarray(0, 60).toString('base64') }));
	check('a proof file cut short is refused', !!short && short.code === 'BAD_PROOF_FILE', short ? short.code : 'accepted');
	check('nothing was taken from any of them', (await onchain(B.id, assetId)) === '0' && (await onchain(C.id, assetId)) === '0' && waitingOn(await rowOf(B.id, made.row.id)));

	// 3b. Forgeries: for the right payment, well formed, and untrue.
	const forge = forger();
	const forgeries = {
		'ten times the amount': forge(bytes, (proofs) => {
			proofs.at(-1).asset.amount *= 10n;
		}),
		'more of the asset created than was': forge(bytes, (proofs) => {
			proofs[0].asset.amount *= 1000n;
		}),
		'its history cut off before the payment': forge(bytes, (proofs) => {
			proofs.splice(0, proofs.length - 1);
		})
	};
	for (const [what, file] of Object.entries(forgeries)) {
		const no = await refusal(() => post(B.id, '/proofs/import', { file }));
		check(`a forged proof is refused by verification: ${what}`, !!no && no.code === 'PROOF_INVALID' && no.status === 422, no ? `${no.status} ${no.code}: ${String(no.message).slice(0, 140)}` : 'ACCEPTED');
	}
	await post(B.id, '/proofs/retry', { id: made.row.id }).catch(() => {});
	check('no forgery was kept or credited, and the wallet still asks the server', (await onchain(B.id, assetId)) === '0' && waitingOn(await rowOf(B.id, made.row.id)), `${await onchain(B.id, assetId)} ${JSON.stringify((await rowOf(B.id, made.row.id)).failure)}`);

	// 4. The recipient takes the real one in. No server is asked.
	const taken = await post(B.id, '/proofs/import', { file: out.file });
	check('the import verifies the proof and completes the receive', taken.result === 'complete' && taken.row.id === made.row.id && taken.row.state === 'complete' && taken.row.failure === null, JSON.stringify({ result: taken.result, state: taken.row.state }));
	check('the recipient holds the asset', (await onchain(B.id, assetId)) === '300', await onchain(B.id, assetId));
	// The wallet's summary is worked out on the loop's next pass, a moment later.
	await waitFor('the wallet says it holds assets', async () => (await status(B.id)).holdsAssets === true, { timeoutMs: 30000 });
	const twice = await post(B.id, '/proofs/import', { file: out.file });
	check('the same file again changes nothing', twice.result === 'already' && (await onchain(B.id, assetId)) === '300', twice.result);

	// 5. The sender settles its side by hand, and can take that back.
	const marked = await post(A.id, '/proofs/handed-over', { id: sent.row.id });
	check('the send is marked as handed over, and is still the server\'s to take', marked.row.state === 'proofs' && typeof marked.row.handedOver === 'number', JSON.stringify({ state: marked.row.state, handedOver: marked.row.handedOver }));
	await waitFor('it no longer counts as in progress', async () => (await status(A.id)).pending.sends === 0);
	const undone = await post(A.id, '/proofs/handed-over', { id: sent.row.id, handedOver: false });
	check('the mark can be taken back', undone.row.handedOver === null);
	await post(A.id, '/proofs/handed-over', { id: sent.row.id });

	// 6. What came by file is spent: part of it goes on to a wallet that also gets it by file.
	mine(1);
	const next = await post(C.id, '/addresses', { key: assetId, amount: '120' });
	const p2 = await post(B.id, '/send/prepare', { address: next.address.encoded, feeRate: 2 }, idem());
	const onward = await post(B.id, '/send/commit', { previewId: p2.previewId }, idem());
	mine(1);
	await waitFor('the second send is refused by the server too', async () => refusedBy(await rowOf(B.id, onward.row.id)));
	const out2 = await exportProof(B.id, onward.row.id);
	check('tapd verifies the second file, whose history holds the first', tapdVerifies(Buffer.from(out2.file, 'base64')).valid === true);
	await waitFor('the third wallet sees its payment and waits for its proof', async () => {
		await post(C.id, '/addresses/check', { id: next.row.id }).catch(() => {});
		return waitingOn(await rowOf(C.id, next.row.id));
	});
	// This one arrives with a block header that is not the chain's. That is
	// what a proof looks like after a reorganisation, so the wallet does what
	// it does then: it takes the header and the merkle path from the chain,
	// for the block that really holds the transaction, and verifies that.
	// tapd says below whether what was stored is right.
	const offChain = forge(Buffer.from(out2.file, 'base64'), (proofs) => {
		proofs.at(-1).blockHeader.nonce = (proofs.at(-1).blockHeader.nonce + 1) >>> 0;
	});
	check('tapd refuses the file with the wrong block as it stands', tapdVerifies(Buffer.from(offChain, 'base64')).valid !== true);
	const taken2 = await post(C.id, '/proofs/import', { file: offChain });
	check('a proof whose history itself came by file verifies, its block put right from the chain', taken2.result === 'complete' && taken2.row.id === next.row.id, JSON.stringify({ result: taken2.result }));
	check('the three wallets hold 700, 180 and 120', (await onchain(A.id, assetId)) === '700' && (await onchain(B.id, assetId)) === '180' && (await onchain(C.id, assetId)) === '120', `${await onchain(A.id, assetId)} / ${await onchain(B.id, assetId)} / ${await onchain(C.id, assetId)}`);
	check('the address nobody paid is still waiting, untouched by any file', (await rowOf(C.id, other.row.id)).state === 'waiting');

	// 7. The server takes proofs again: both refused sends finish by themselves when offered.
	serverTakesTransfers(true);
	restored = true;
	const first = await post(A.id, '/proofs/retry', { id: sent.row.id });
	const second = await post(B.id, '/proofs/retry', { id: onward.row.id });
	const doneA = first.row.state === 'complete' ? first.row : await rowReaches(A.id, sent.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
	const doneB = second.row.state === 'complete' ? second.row : await rowReaches(B.id, onward.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
	check('offered again, the server takes both proofs and the sends complete', doneA.state === 'complete' && doneB.state === 'complete' && doneA.failure === null && doneB.failure === null);
	check('the mark is kept as what happened', typeof doneA.handedOver === 'number');
	check('the file is still there to take once the send is complete', (await exportProof(A.id, sent.row.id)).file === out.file);

	// 8. tapd's word on it: the last wallet sends what it got by file to tapd.
	mine(1);
	const before = Number(tapdBalance(assetId));
	const toTapd = tapcli('addrs', 'new', '--asset_id', assetId, '--amt', '50');
	const p3 = await post(C.id, '/send/prepare', { address: toTapd.encoded, feeRate: 2 }, idem());
	const s3 = await post(C.id, '/send/commit', { previewId: p3.previewId }, idem());
	mine(1);
	await rowReaches(C.id, s3.row.id, 'complete', { mineEach: true, timeoutMs: 180000 });
	const out3 = await exportProof(C.id, s3.row.id);
	check('tapd verifies the history the wallet stored: the block it holds is the chain\'s', tapdVerifies(Buffer.from(out3.file, 'base64')).valid === true);
	await waitFor('tapd completes the receive', () => {
		const events = tapcli('addrs', 'receives', '--addr', toTapd.encoded).events || [];
		return events.some((e) => e.status === 'ADDR_EVENT_STATUS_COMPLETED');
	}, { timeoutMs: 180000 });
	check('tapd verified a history that passed through two files, and credited it', Number(tapdBalance(assetId)) === before + 50, `${before} -> ${tapdBalance(assetId)}`);
	check('the wallet keeps the rest', (await onchain(C.id, assetId)) === '70', await onchain(C.id, assetId));
} finally {
	// Whatever happened above, the stack's server is left taking proofs.
	if (!restored) serverTakesTransfers(true);
}

done({ A: A.id, B: B.id, C: C.id, assetId });
