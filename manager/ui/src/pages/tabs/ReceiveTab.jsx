import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { usePoll } from '../../hooks/usePoll.js';
import { useQuote } from '../../hooks/useQuote.js';
import { useToast } from '../../components/Toast.jsx';
import { Button, Card, CopyText, Field, Help, QR, Badge } from '../../components/ui.jsx';
import { fmtSats, shortId } from '../../lib/format.js';
import { buildBip21 } from '../../lib/payment-uri.js';
import { INBOUND_HEADROOM_SATS, planInvoice } from '../../lib/lfbw.js';
import OfflineReceiveCard from '../../components/OfflineReceiveCard.jsx';
import { manager } from '../../api.js';

// A direct-funding request is re-minted when the amount changes (the
// receiver signs the amount into it), after the hand has settled.
const FUNDING_DEBOUNCE_MS = 400;
// A JIT invoice's lifetime, and with it the intent the primary holds open.
const JIT_INVOICE_EXPIRY_SECS = 15 * 60;
// The smallest amount an offline receive slot can hold (the engine's dust limit).
const OFFLINE_MIN_SATS = 354;

export default function ReceiveTab({ id, api, rec, tick, lastReceive, config, info }) {
	const onchainOnly = !!rec?.onchainOnly;
	// A lightning-first wallet's on-chain request also carries a direct-funding
	// request, and its invoices are provisioned by the primary node just in
	// time when the home channel cannot take the amount as it stands.
	// Receiving offline is an opt-in on top of that, for every wallet kind:
	// the invoice is then prepared with the primary (or a chosen receiving
	// node) before it is shown, and stays payable with the wallet stopped.
	const isLfbw = !!rec?.lfbw?.enabled;
	const lfbwReady = isLfbw && rec.lfbw.setup === 'ready';
	const toast = useToast();
	const [funding, setFunding] = useState(null);
	const [jitInfo, setJitInfo] = useState(null);
	const [address, setAddress] = useState('');
	const [onchainAmount, setOnchainAmount] = useState('');
	const [onchainMessage, setOnchainMessage] = useState('');
	const [invoice, setInvoice] = useState(null);
	const [includeInvoice, setIncludeInvoice] = useState(true);
	const [amount, setAmount] = useState('');
	const [description, setDescription] = useState('');
	const [busy, setBusy] = useState(false);
	const [offlineRequested, setOfflineRequested] = useState(false);
	const [selectedPeer, setSelectedPeer] = useState('');
	const wantsOffline = offlineRequested;
	useEffect(() => {
		setOfflineRequested(false);
		setSelectedPeer('');
		setInvoice(null);
		setJitInfo(null);
	}, [id]);
	const { data: invoices, refresh } = usePoll(
		() => (onchainOnly ? Promise.resolve([]) : api.get('/invoices').catch(() => [])),
		10000,
		[id, tick, onchainOnly]
	);
	// The home channel's inbound decides whether an invoice is plain or
	// provisioned through the primary, so it is read here and kept fresh.
	const { data: channels } = usePoll(
		() => (isLfbw ? api.get('/channels').catch(() => null) : Promise.resolve(null)),
		15000,
		[id, tick, isLfbw]
	);
	// Whether the primary is on the other end of a live peer connection: a
	// primary whose daemon runs but whose connection is down cannot
	// provision, so the invoice is refused before it is minted (umbrel #89).
	// A regular wallet receiving offline picks its receiving node from the
	// same list.
	const { data: peers } = usePoll(
		() => (isLfbw || wantsOffline ? api.get('/peers').catch(() => null) : Promise.resolve(null)),
		15000,
		[id, tick, isLfbw, wantsOffline]
	);
	const { data: candidates } = usePoll(
		() => (wantsOffline && !isLfbw ? manager.fforCandidates(id).catch(() => []) : Promise.resolve([])),
		15000,
		[id, tick, wantsOffline, isLfbw]
	);
	const connectedPeers = useMemo(
		() => (peers || []).filter((p) => p.state === 'connected' || p.state === 'ready' || p.connected === true),
		[peers]
	);
	const receivingNodes = useMemo(
		() =>
			connectedPeers
				.map((p) => {
					const known = (candidates || []).find((c) => c.nodeId === p.pubkey);
					return { pubkey: p.pubkey, name: known?.name || p.alias || shortId(p.pubkey), settles: !!known?.settles };
				})
				.sort((a, b) => Number(b.settles) - Number(a.settles) || a.pubkey.localeCompare(b.pubkey)),
		[connectedPeers, candidates]
	);
	const primaryConnected = useMemo(
		() => !isLfbw || !peers || connectedPeers.some((p) => p.pubkey === rec.lfbw.primaryPubkey),
		[isLfbw, peers, connectedPeers, rec?.lfbw?.primaryPubkey]
	);
	// The node an offline receive is prepared with: a lightning-first wallet's
	// primary, or the receiving node picked (or first offered) on a regular one.
	const receivePeer = isLfbw ? rec?.lfbw?.primaryPubkey : selectedPeer || receivingNodes[0]?.pubkey;
	const peerConnected = isLfbw ? primaryConnected : receivingNodes.some((p) => p.pubkey === receivePeer);
	const nodeLabel = isLfbw ? 'primary node' : 'receiving node';

	// Which invoice the amount typed would mint, read off the polled channels
	// so the price can be said before anything exists. The primary's
	// running state is asked at creation, where it decides the refusal text.
	const wantedSats = parseInt(amount, 10) || 0;
	const plan = useMemo(
		() =>
			isLfbw && channels
				? planInvoice({ wantedSats, channels, primaryPubkey: rec.lfbw.primaryPubkey, setup: rec.lfbw.setup, primaryConnected })
				: null,
		[isLfbw, channels, wantedSats, rec?.lfbw?.primaryPubkey, rec?.lfbw?.setup, primaryConnected]
	);
	// The price of a just-in-time receive, asked of the primary before the
	// invoice exists (beignet #687): the quote registers nothing with it, so
	// asking is free, and the answer says whether the primary would front
	// this at all right now. Engines before the route get no line.
	const jitQuote = useQuote(
		api,
		{
			lspPubkey: rec?.lfbw?.primaryPubkey,
			amountSats: wantedSats > 0 ? wantedSats : undefined,
			targetRemainingInboundSat: INBOUND_HEADROOM_SATS
		},
		!wantsOffline && !!config?.jitQuoteAvailable && lfbwReady && plan?.kind === 'jit',
		'/jit/quote',
		'GET'
	);
	const jitLine = useMemo(() => {
		if (lfbwReady && plan?.kind === 'refuse' && plan.code === 'PRIMARY_DOWN') {
			return {
				tone: 'error',
				blocks: true,
				text: 'Your primary node is not connected, and this invoice needs it to provide inbound capacity. Wait for it to reconnect, or ask for an amount the channel already covers.'
			};
		}
		if (!config?.jitQuoteAvailable || !lfbwReady || plan?.kind !== 'jit') return null;
		const { quote, error, errorCode } = jitQuote;
		if (errorCode === 'PEER_NOT_CONNECTED') {
			return { tone: 'error', blocks: true, text: 'Your primary node is not connected, and this invoice needs it to provide inbound capacity.' };
		}
		if (error && !quote) {
			return { tone: 'error', blocks: false, text: `Could not get a price from your primary node: ${error}` };
		}
		if (!quote) return null;
		if (quote.accepted === false) {
			return {
				tone: 'error',
				blocks: true,
				text: `Your primary cannot fund this invoice right now${quote.reason ? `: ${quote.reason}` : '.'}`
			};
		}
		const flat = quote.flatFeeSat || 0;
		const ppm = quote.feePpm || 0;
		// The provider would front it, but at a price this wallet's own
		// ceilings refuse (the daemon refuses the invoice on the same
		// numbers), so it is a refusal with its own reason.
		if (quote.withinCeilings === false) {
			const c = quote.client || {};
			return {
				tone: 'error',
				blocks: true,
				text: `Your primary asks ${fmtSats(flat)}${ppm > 0 ? ` plus ${ppm} ppm` : ''} for this, more than this wallet accepts${
					c.maxFlatFeeSat != null || c.maxFeePpm != null
						? ` (up to ${fmtSats(c.maxFlatFeeSat || 0)}${c.maxFeePpm > 0 ? ` plus ${c.maxFeePpm} ppm` : ''})`
						: ''
				}.`
			};
		}
		const terms = flat > 0 || ppm > 0 ? `${fmtSats(flat)}${ppm > 0 ? ` plus ${ppm} ppm` : ''}` : null;
		if (wantedSats > 0) {
			const fee = quote.feeSats ?? flat + Math.floor((wantedSats * ppm) / 1_000_000);
			return {
				tone: 'info',
				blocks: false,
				text: terms
					? `Your primary will fund this receive for ${fmtSats(fee)} (${terms}), taken from the delivery.`
					: 'Your primary will fund this receive at no charge.'
			};
		}
		return {
			tone: 'info',
			blocks: false,
			text: terms
				? `Your primary funds what the channel cannot take for ${terms}, taken from the delivery.`
				: 'Your primary funds what the channel cannot take, at no charge.'
		};
	}, [config?.jitQuoteAvailable, lfbwReady, plan, jitQuote, wantedSats]);

	// Receiving offline needs a fixed amount the engine's slot can hold and a
	// node that is connected and prepared to settle it. A lightning-first
	// wallet knows its primary's connection before the box is ticked, so the
	// box waits for it; a regular wallet learns its receiving nodes once
	// ticked, and the quote line says the rest.
	const offlineEligible =
		!!config?.offlineReceiveAvailable &&
		(!isLfbw || lfbwReady) &&
		peerConnected &&
		Number.isSafeInteger(wantedSats) &&
		wantedSats >= OFFLINE_MIN_SATS;
	const [quoteTick, setQuoteTick] = useState(0);
	useEffect(() => {
		if (!wantsOffline) return;
		const timer = setInterval(() => setQuoteTick((n) => n + 1), 45000);
		return () => clearInterval(timer);
	}, [wantsOffline]);
	const receiveQuote = useQuote(
		api,
		{ peer: receivePeer, amountSats: wantedSats, refresh: quoteTick },
		wantsOffline && offlineEligible,
		'/receive/quote',
		'GET'
	);
	const offlineLine = useMemo(() => {
		if (!wantsOffline) return null;
		const block = (text) => ({ tone: 'error', blocks: true, text });
		if (!config?.offlineReceiveAvailable) return block('Update the app engine to enable offline receiving.');
		if (isLfbw && !lfbwReady)
			return block('Your primary node connection is being prepared. Try again when it is ready.');
		if (!peerConnected)
			return block(
				isLfbw
					? 'Your primary node is not connected. Wait for it to reconnect.'
					: 'Connect a node that supports offline receiving in Peers.'
			);
		if (!Number.isSafeInteger(wantedSats) || wantedSats < OFFLINE_MIN_SATS)
			return block(`Enter an amount of at least ${OFFLINE_MIN_SATS} sats.`);
		if (receiveQuote.error) {
			// The engine hands the primary's own sentence through (beignet #920),
			// full stop included: drop it before adding ours.
			const reason = String(receiveQuote.error).replace(/[.\s]+$/, '');
			return block(
				isLfbw
					? `Your primary node cannot prepare an offline receive right now: ${reason}. It has to offer offline settlement in its own settings, or untick Receive offline for an ordinary invoice.`
					: receiveQuote.error
			);
		}
		const q = receiveQuote.quote;
		if (receiveQuote.pending || !q || q.amountSats !== wantedSats || q.peer !== receivePeer)
			return { tone: 'info', blocks: true, text: 'Checking receive availability…' };
		// Since beignet 0.21.10 an offline receive is only for a channel that
		// already exists with the node and has room for the amount; it never
		// has the node open one. With no such channel the engine answers the
		// quote with mode 'direct-funding' (an on-chain request instead of an
		// invoice) and no terms, which is not what this box promises.
		if (q.mode === 'direct-funding')
			return block(
				`No channel with your ${nodeLabel} has room to receive ${wantedSats.toLocaleString()} sats offline yet, and receiving offline never opens one. Untick Receive offline for an ordinary invoice, which your ${nodeLabel} provisions just in time.`
			);
		return {
			tone: 'info',
			blocks: false,
			text:
				q.terms.feeBaseMsat || q.terms.feePpm
					? `You receive the full amount. The payer covers your ${nodeLabel}'s fee of ${q.terms.feeBaseMsat} msat plus ${q.terms.feePpm} ppm.`
					: `You receive the full amount. Your ${nodeLabel} charges no receive fee.`
		};
	}, [
		isLfbw,
		config?.offlineReceiveAvailable,
		lfbwReady,
		peerConnected,
		wantsOffline,
		nodeLabel,
		wantedSats,
		receiveQuote.quote,
		receiveQuote.pending,
		receiveQuote.error,
		receivePeer
	]);
	const quoteLine = wantsOffline ? offlineLine : jitLine;

	const newAddress = async () => {
		try {
			const r = await api.post('/address/new', {});
			setAddress(r.address);
		} catch (e) {
			toast(e.message, 'error');
		}
	};

	useEffect(() => {
		newAddress();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [id]);

	// An on-chain request is the address plus what is being asked for, written as
	// a BIP21 URI. It is derived here rather than fetched: the daemon can encode
	// one, but it mints a fresh address every time it is asked, and this changes
	// on every keystroke. With nothing attached it comes back as the bare
	// address, which is what should be shared when nothing is being asked for.
	const onchainSats = parseInt(onchainAmount, 10) || 0;
	const trimmedMessage = onchainMessage.trim();

	// The direct-funding request minted for this address and amount. Minted by
	// the daemon (the receiver signs it), with the wallet's reachable address
	// when it has one; without one, payers reach the wallet through the
	// primary's relay. A mint that fails leaves a plain request, which is what
	// the address is anyway.
	useEffect(() => {
		if (!lfbwReady || !address) {
			setFunding(null);
			return undefined;
		}
		let alive = true;
		const t = setTimeout(() => {
			const body = {};
			if (rec.reach) {
				body.host = rec.reach.host;
				body.port = rec.reach.port;
			}
			if (onchainSats > 0) body.amountSats = onchainSats;
			api
				.post('/direct-funding/request', body)
				.then((r) => alive && setFunding({ ...r, address, amountSats: onchainSats }))
				.catch(() => alive && setFunding(null));
		}, FUNDING_DEBOUNCE_MS);
		return () => {
			alive = false;
			clearTimeout(t);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [lfbwReady, address, onchainSats, rec?.reach?.host, rec?.reach?.port, api]);
	const carriesFunding =
		!invoice?.offlineReceive &&
		!!funding &&
		funding.address === address &&
		funding.amountSats === onchainSats &&
		funding.expiresAt > Date.now();

	// A request can carry the invoice from the card beside it, which makes it one
	// thing to hand out that a payer can settle on either rail: the address for a
	// wallet that only reads BIP21, the invoice for one that would rather use
	// Lightning. That is the shape the Send tab has always been able to read, and
	// until now nothing here could write one.
	//
	// The two amounts have to agree. A payer's wallet is entitled to treat the
	// BIP21 amount as binding on both rails, and our own parser refuses a request
	// whose halves disagree rather than guess which was meant, so a request this
	// tab could mint and the Send tab would refuse is not one to mint. An
	// amountless invoice agrees with anything: it leaves the figure to the payer,
	// and the request supplies it.
	const invoiceConflicts =
		!!invoice && onchainSats > 0 && invoice.amountSats != null && invoice.amountSats !== onchainSats;

	// Whether the invoice on screen has been paid, learned two ways: the page's
	// receive watcher hands settled hashes down the moment they settle, and the
	// invoice list below is polled anyway and marks it PAID within its interval
	// even when every event was missed. This is the moment the tab exists for.
	// Someone showing this QR across a table is watching this screen, not their
	// balance, and the payer's phone saying "sent" is the payer's wallet
	// talking; the receipt is ours to show.
	const paidInfo = useMemo(() => {
		if (!invoice) return null;
		if (
			lastReceive?.rail === 'lightning' &&
			lastReceive.paymentHash &&
			lastReceive.paymentHash === invoice.paymentHash
		) {
			return { amountSats: lastReceive.amountSats ?? invoice.amountSats ?? null };
		}
		const row = (invoices || []).find((i) => i.paymentHash === invoice.paymentHash);
		if (row && (row.status === 'PAID' || row.status === 'COMPLETED')) {
			return { amountSats: row.amountSats ?? invoice.amountSats ?? null };
		}
		return null;
	}, [invoice, invoices, lastReceive]);
	const paid = !!paidInfo;

	// A settled invoice cannot be paid again, so it has no place in a request
	// still being handed out.
	const carriesInvoice = !onchainOnly && !!invoice && !paid && includeInvoice && !invoiceConflicts;

	const request = useMemo(
		// `message` rather than `label`: BIP21 defines label as the recipient's own
		// name for themselves and message as the note to the payer, and a note to
		// the payer is what this field is for.
		() =>
			buildBip21({
				address,
				amountSats: onchainSats,
				message: trimmedMessage,
				lightning: carriesInvoice ? invoice.bolt11 : undefined,
				funding: carriesFunding ? funding.request : undefined
			}),
		[address, onchainSats, trimmedMessage, carriesInvoice, invoice, carriesFunding, funding]
	);
	const isRequest = request !== address;

	const createInvoice = async () => {
		setBusy(true);
		try {
			const body = { description };
			if (amount) body.amountSats = parseInt(amount, 10);
			let r;
			let jit = null;
			if (wantsOffline) {
				if (quoteLine?.blocks || !receiveQuote.quote) throw new Error(quoteLine?.text || 'Review the amount again.');
				const peer = receivePeer;
				const key = `receive-request:${id}`;
				const fingerprint = JSON.stringify({ peer, ...body });
				let saved;
				try {
					saved = JSON.parse(sessionStorage.getItem(key));
				} catch {
					/* No pending request. */
				}
				if (!saved || saved.fingerprint !== fingerprint) saved = { fingerprint, requestId: crypto.randomUUID() };
				sessionStorage.setItem(key, JSON.stringify(saved));
				r = await api.post('/receive/invoice', {
					...body,
					peer,
					requestId: saved.requestId,
					quote: receiveQuote.quote
				});
				if (r.offlineReceive !== true) throw new Error('Your payment request could not be prepared. Try again.');
				sessionStorage.removeItem(key);
			} else if (isLfbw) {
				// Provision inbound first when the home channel cannot take the
				// amount: the invoice is payable through a channel the primary
				// funds the moment the payment arrives (a zero-conf open, or a
				// splice of the home channel), minus the fee it quotes.
				const lf = rec.lfbw;
				let primaryRunning = true;
				if (lf.mode === 'internal' && lf.primaryWalletId) {
					primaryRunning = await manager
						.getWallet(lf.primaryWalletId)
						.then((w) => w.status === 'running')
						.catch(() => true);
				}
				const decided = planInvoice({
					wantedSats: body.amountSats || 0,
					channels: channels || (await api.get('/channels').catch(() => [])),
					primaryPubkey: lf.primaryPubkey,
					setup: lf.setup,
					primaryRunning,
					primaryConnected
				});
				if (decided.kind === 'refuse') {
					throw new Error(
						decided.code === 'PRIMARY_DOWN'
							? decided.reason === 'not-connected'
								? 'Your primary node is not connected, and this invoice needs it to provide inbound capacity. Wait for it to reconnect, or ask for an amount the channel already covers.'
								: 'Your primary node is not running, and this invoice needs it to provide inbound capacity. Start it, or ask for an amount the channel already covers.'
							: 'The link to your primary node is not set up yet. Retry setup from the Overview tab.'
					);
				}
				if (decided.kind === 'jit') {
					r = await api.post('/jit/invoice', {
						lspPubkey: lf.primaryPubkey,
						...(body.amountSats ? { amountSats: body.amountSats } : {}),
						description: body.description,
						targetRemainingInboundSat: INBOUND_HEADROOM_SATS,
						// The primary holds an intent open for as long as the invoice
						// lives and allows a few per wallet, so an unpaid invoice must
						// not hold its slot for an hour (beignet #674).
						expirySecs: JIT_INVOICE_EXPIRY_SECS
					});
					jit = { flatFeeSat: r.flatFeeSat || 0, feePpm: r.feePpm || 0 };
				}
			}
			if (!r) r = await api.post('/invoice/create', body);
			setInvoice(r);
			setJitInfo(jit);
			toast(
				jit
					? jit.flatFeeSat > 0 || jit.feePpm > 0
						? `Invoice created. Your primary node provides the capacity when it is paid, for ${fmtSats(jit.flatFeeSat)}${jit.feePpm > 0 ? ` plus ${jit.feePpm} ppm` : ''}.`
						: 'Invoice created. Your primary node provides the capacity when it is paid.'
					: 'Invoice created',
				'success'
			);
			// The list below polls every ten seconds, which is a long time to look
			// at a table that does not yet have the invoice you just made in it.
			refresh();
		} catch (e) {
			toast(e.message, 'error');
			if (wantsOffline) setQuoteTick((n) => n + 1);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className={onchainOnly ? undefined : 'grid cols-2'}>
			<Card
				title={isLfbw ? 'Deposit bitcoin' : 'On-chain'}
				actions={
					<Button className="sm" onClick={newAddress}>
						New address
					</Button>
				}>
				<div className="row">
					<Field label="Amount (sats, optional)">
						<input
							value={onchainAmount}
							onChange={(e) => setOnchainAmount(e.target.value.replace(/[^0-9]/g, ''))}
							placeholder="any amount"
						/>
					</Field>
				</div>
				<Field label="Message (optional)">
					<input value={onchainMessage} onChange={(e) => setOnchainMessage(e.target.value)} placeholder="Coffee" />
				</Field>
				<div style={{ textAlign: 'center' }}>
					<QR value={request} />
				</div>
				<div style={{ marginTop: 12, textAlign: 'center' }}>
					<CopyText value={request} truncate={isRequest} />
				</div>
				{/* Built out of what is actually attached, sentence by sentence. Said
				    as one fixed paragraph it described the message field whether or
				    not anything had been typed into it, so an empty box showing its
				    "Coffee" placeholder read as though the placeholder were being
				    handed out, and the hint is the only thing explaining what is being
				    shared. */}
				<div className="field-hint" style={{ marginTop: 10 }}>
					{!isRequest
						? 'Nothing attached, so this is a plain address. Anyone can pay it any amount.'
						: [
								onchainSats > 0 ? `A wallet that scans this fills in ${fmtSats(onchainSats)} for the payer.` : null,
								trimmedMessage ? 'The message travels with the request and is never written to the chain.' : null,
								carriesInvoice
									? 'It also carries the Lightning invoice below, so whoever scans it can settle on either rail.'
									: null,
								carriesFunding
									? 'It also carries a direct-funding request: a beignet wallet paying it funds your Lightning balance in one transaction, with no deposit to move afterwards.'
									: null
						  ]
								.filter(Boolean)
								.join(' ')}
					{isLfbw && !isRequest
						? ' Whatever lands here moves into your Lightning balance by itself once it confirms.'
						: ''}
				</div>
				{invoice && !paid && (
					<>
						<label className="checkbox field" style={{ marginTop: 10 }}>
							<input
								type="checkbox"
								checked={includeInvoice}
								disabled={invoiceConflicts}
								onChange={(e) => setIncludeInvoice(e.target.checked)}
							/>
							Carry the Lightning invoice in this request
						</label>
						{invoiceConflicts && (
							<div className="field-note">
								The invoice below asks for {fmtSats(invoice.amountSats)} and this request asks for{' '}
								{fmtSats(onchainSats)}.
								<Help>
									A payer's wallet reads the request's amount as binding on both rails, so the two have
									to agree before they can be handed out as one thing.
								</Help>
							</div>
						)}
					</>
				)}
			</Card>

			{!onchainOnly && (
				<Card title="Lightning invoice">
					<div className="row">
						<Field label={wantsOffline ? 'Amount (sats)' : 'Amount (sats, optional)'}>
							<input
								value={amount}
								disabled={busy}
								onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
								placeholder="any amount"
							/>
						</Field>
					</div>
					<Field label="Description">
						<input
							disabled={busy}
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Coffee"
						/>
					</Field>
					<label className="checkbox field">
						<input
							type="checkbox"
							data-testid="receive-offline"
							checked={offlineRequested}
							disabled={
								busy ||
								(!offlineRequested &&
									(!config?.offlineReceiveAvailable ||
										!Number.isSafeInteger(wantedSats) ||
										wantedSats < OFFLINE_MIN_SATS ||
										(isLfbw && (!lfbwReady || !primaryConnected))))
							}
							onChange={(e) => {
								setOfflineRequested(e.target.checked);
								setInvoice(null);
								setJitInfo(null);
							}}
						/>
						Receive offline
					</label>
					<div className="field-hint">
						{!config?.offlineReceiveAvailable
							? 'Update the app engine to enable offline receiving.'
							: wantedSats < OFFLINE_MIN_SATS
							? `Enter an amount of at least ${OFFLINE_MIN_SATS} sats to receive offline.`
							: isLfbw && !lfbwReady
							? 'Available once the link to your primary node is ready.'
							: isLfbw && !primaryConnected
							? 'Available while your primary node is connected.'
							: isLfbw
							? 'Accept this payment even while this wallet is stopped. Your primary node prepares it, so it has to offer offline settlement in its own settings.'
							: 'Accept this payment even while this wallet is stopped. Closing the browser alone does not stop the wallet.'}
					</div>
					{!isLfbw && offlineRequested && receivingNodes.length > 0 && (
						<Field label="Receiving node">
							<select
								value={receivePeer || ''}
								disabled={busy}
								onChange={(e) => {
									setSelectedPeer(e.target.value);
									setInvoice(null);
								}}>
								{selectedPeer && !peerConnected && <option value={selectedPeer}>Disconnected node</option>}
								{receivingNodes.map((p) => (
									<option key={p.pubkey} value={p.pubkey}>
										{p.name}
									</option>
								))}
							</select>
						</Field>
					)}
					<div className="field-hint">
						Changing this option requires a new invoice. Already shared invoices stay unchanged.
					</div>
					{quoteLine && (
						<div
							className={quoteLine.tone === 'error' ? 'error-note' : 'info-note'}
							role="status"
							data-testid={wantsOffline ? 'receive-quote' : 'jit-quote'}>
							{quoteLine.text}
						</div>
					)}
					<Button variant="primary" busy={busy} disabled={!!quoteLine?.blocks} onClick={createInvoice}>
						Create invoice
					</Button>
					<AnimatePresence mode="wait">
						{invoice && !paid && (
							<m.div
								key={invoice.bolt11}
								style={{ textAlign: 'center', marginTop: 16 }}
								initial={{ opacity: 0, scale: 0.92, y: 8 }}
								animate={{ opacity: 1, scale: 1, y: 0 }}
								exit={{ opacity: 0, scale: 0.96 }}>
								<QR value={invoice.bolt11} />
								<div style={{ marginTop: 12 }}>
									<CopyText value={invoice.bolt11} truncate />
								</div>
								{invoice.offlineReceive && (
									<div className="info-note" role="status">
										You can close your wallet. Payments will appear when you reopen it.
									</div>
								)}
								{jitInfo && (
									<div className="field-hint" style={{ marginTop: 10 }} role="status">
										Payable now: your primary node provides the inbound capacity the moment this is paid
										{jitInfo.flatFeeSat > 0 || jitInfo.feePpm > 0
											? `, and takes ${fmtSats(jitInfo.flatFeeSat)}${jitInfo.feePpm > 0 ? ` plus ${jitInfo.feePpm} ppm` : ''} from the delivery for it.`
											: ', at no charge.'}
									</div>
								)}
							</m.div>
						)}
						{invoice && paid && (
							// The receipt takes the QR's place outright. A paid invoice
							// cannot be paid again, so leaving its code on screen invites
							// the one scan that is guaranteed to fail.
							<m.div
								key={`paid-${invoice.bolt11}`}
								className="paid-receipt"
								role="status"
								initial={{ opacity: 0, scale: 0.9 }}
								animate={{ opacity: 1, scale: 1 }}>
								<div className="paid-check" aria-hidden="true">
									✓
								</div>
								<div className="paid-title">Paid</div>
								<div className="wallet-meta">
									{paidInfo.amountSats != null
										? `${fmtSats(paidInfo.amountSats)} received over Lightning.`
										: 'Received over Lightning.'}
								</div>
							</m.div>
						)}
					</AnimatePresence>
				</Card>
			)}

			{/* Receive while offline (FFOR): a voucher book pre-signed with a
			    sibling that stays online, one invoice per voucher, payable with
			    this wallet off. Only on an engine that carries the routes. */}
			{!onchainOnly && !isLfbw && config?.fforAvailable && (
				<details className="grid-full">
					<summary>Advanced offline receive</summary>
					<OfflineReceiveCard id={id} api={api} rec={rec} tick={tick} info={info} />
				</details>
			)}

			{!onchainOnly && (
				<Card title="Recent invoices" className="grid-full">
					{!invoices || invoices.length === 0 ? (
						<div className="empty">No invoices yet.</div>
					) : (
						<div className="table-wrap">
							<table>
								<thead>
									<tr>
										<th>Amount</th>
										<th>Description</th>
										<th>Invoice</th>
										<th>Status</th>
									</tr>
								</thead>
								<tbody>
									{invoices.slice(0, 20).map((inv) => (
										<tr key={inv.paymentHash}>
											<td>{inv.amountSats ? fmtSats(inv.amountSats) : 'any'}</td>
											<td>{inv.description || '-'}</td>
											{/* The invoice itself rather than its hash: an invoice you cannot
										    hand out again is of no use to anyone, and the hash never was. */}
											<td>
												{inv.bolt11 ? (
													<CopyText value={inv.bolt11} label={shortId(inv.bolt11)} />
												) : (
													<span className="mono">{shortId(inv.paymentHash)}</span>
												)}
											</td>
											<td>
												<Badge tone={inv.status === 'PAID' || inv.status === 'COMPLETED' ? 'green' : 'muted'}>
													{inv.status || 'open'}
												</Badge>
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</Card>
			)}
		</div>
	);
}
