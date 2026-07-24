import { useEffect, useMemo, useRef, useState } from 'react';
import { usePoll } from '../../hooks/usePoll.js';
import { useToast } from '../../components/Toast.jsx';
import { AmountField, Button, Card, Field, FeeField, Badge, Segmented } from '../../components/ui.jsx';
import { fmtDuration, fmtSats, shortId } from '../../lib/format.js';
import { FEE_CAP_MULTIPLE } from '../../lib/fees.js';
import { formatInvoiceWarning } from '../../lib/hints.js';
import { parsePayment } from '../../lib/payment-uri.js';
import { useQuote } from '../../hooks/useQuote.js';
import { useSettledRefusal } from '../../hooks/useSettledRefusal.js';
import { manager, walletApi } from '../../api.js';

// beignet 0.6.0 pays during splices: the daemon marks each channel with
// htlcUsable, true for NORMAL and for a channel mid-splice that carries
// payments through its confirmation window. Older daemons lack the flag, so
// NORMAL remains the fallback.
const usable = (c) => c.htlcUsable ?? c.state === 'NORMAL';

export default function SendTab({ id, api, info, rec, tick, bump }) {
	const [mode, setMode] = useState('onchain');
	// Both input boxes live here rather than in the cards below, because what is
	// pasted into one of them regularly belongs to the other. A Lightning invoice
	// in the on-chain box is not a mistake to correct, it is a payment on the
	// other rail, and moving it there is the whole of the correction.
	const [onchainInput, setOnchainInput] = useState('');
	const [lnInput, setLnInput] = useState('');
	const { data: channels } = usePoll(() => api.get('/channels').catch(() => null), 15000, [id, tick]);
	// splicingOnly covers the rare parked splice (e.g. taproot), where "open a
	// channel first" would still be the wrong message.
	const splicingOnly = channels
		? channels.length > 0 &&
		  !channels.some(usable) &&
		  channels.some((c) => c.state === 'SPLICING')
		: false;
	const canLightning = channels
		? channels.some(usable)
		: (info?.channelCount ?? 0) > 0;

	useEffect(() => {
		if (!canLightning && mode !== 'onchain') setMode('onchain');
	}, [canLightning, mode]);

	// Handing a payment string to the rail it belongs on. The refusal is a return
	// value rather than a thrown error: with no channel open there is nowhere for
	// an invoice to go, and the card that took the paste is the one that has to
	// say so.
	const toLightning = (text) => {
		if (!canLightning) return false;
		setLnInput(text);
		setOnchainInput('');
		setMode('lightning');
		return true;
	};
	const toOnchain = (text) => {
		setOnchainInput(text);
		setLnInput('');
		setMode('onchain');
	};

	return (
		<div>
			<Segmented
				id="send-mode"
				value={mode}
				onChange={setMode}
				options={[
					['onchain', 'On-chain'],
					['lightning', 'Lightning', !canLightning, splicingOnly ? 'A splice is confirming' : 'Open a channel first'],
					['keysend', 'Keysend', !canLightning, splicingOnly ? 'A splice is confirming' : 'Open a channel first']
				]}
			/>
			{channels && !canLightning && (
				<div className="info-note" style={{ marginBottom: 14 }}>
					{splicingOnly
						? 'Your channel is mid-splice. Its funds are safe, and Lightning payments resume when the splice transaction confirms and locks.'
						: 'Lightning payments need an open channel. Open one in the Channels tab.'}
				</div>
			)}
			{mode === 'onchain' && (
				<OnChain
					id={id}
					api={api}
					info={info}
					rec={rec}
					bump={bump}
					value={onchainInput}
					onChange={setOnchainInput}
					onLightning={toLightning}
					canLightning={canLightning}
				/>
			)}
			{mode === 'lightning' && (
				<Lightning
					api={api}
					rec={rec}
					channels={channels}
					bump={bump}
					value={lnInput}
					onChange={setLnInput}
					onOnchain={toOnchain}
				/>
			)}
			{mode === 'keysend' && <Keysend api={api} channels={channels} bump={bump} />}
		</div>
	);
}

function OnChain({ id, api, info, rec, bump, value, onChange, onLightning, canLightning }) {
	const toast = useToast();
	const address = value;
	const [amount, setAmount] = useState('');
	const [feeRate, setFeeRate] = useState('');
	const [dest, setDest] = useState('custom');
	const [maxMode, setMaxMode] = useState(false);
	const [focused, setFocused] = useState(false);
	const [fetchingAddr, setFetchingAddr] = useState(false);
	const [busy, setBusy] = useState(false);
	const [txid, setTxid] = useState('');
	// What was read out of a pasted payment request, kept so the form can show
	// the payee's own numbers back to them and hold itself to them.
	const [request, setRequest] = useState(null);
	const [note, setNote] = useState(null);
	const { data: fees } = usePoll(() => api.get('/fees/estimates').catch(() => null), 30000, []);
	const { data: wallets } = usePoll(() => manager.listWallets().catch(() => []), 15000, []);
	const { data: utxos } = usePoll(() => api.get('/utxos').catch(() => null), 30000, [id]);

	const others = (wallets || []).filter(
		(w) => w.id !== id && w.status === 'running' && w.network === rec?.network
	);
	const balance = info?.onchainBalanceSats;
	const effRate = parseInt(feeRate, 10) || fees?.normal || null;
	const typed = parseInt(amount, 10) || 0;

	// Anything can be pasted into the recipient box: a bare address, a payment
	// request with an amount and a message attached, an invoice meant for the
	// other rail. Reading it costs nothing and happens on every change rather
	// than on paste alone, so typing and pasting behave identically.
	const parsed = useMemo(() => parsePayment(value, { network: rec?.network }), [value, rec?.network]);
	const mayRefuse = useSettledRefusal(value, focused);

	// The two ways a payee's amount stops binding this form, which are not the
	// same thing and must not be treated as one.
	//
	// The user takes the amount over by typing or dragging: the figure stands,
	// it is simply theirs now, so only the request's claim on it is released.
	const releaseAmount = () => {
		if (request?.amountSats != null) setRequest({ ...request, amountSats: null });
	};
	// The request itself goes away, because the box no longer holds the address
	// it named. Then its amount goes with it. Leaving the number behind is what
	// turns a refused "asks for more than you have" into an armed sweep: the
	// guard below only watches amounts it knows came from a request, and the
	// fallback below that only arms on amounts it thinks the user typed. An
	// orphaned figure moves from one to the other without anyone touching it.
	const dropRequest = () => {
		if (request?.amountSats != null) setAmount('');
		setRequest(null);
	};

	// The box is rewritten to the plain address the moment a paste is understood,
	// which runs this effect a second time over a string that has nothing left to
	// say: no scheme, no parameters, no repairs to report. What was read out of
	// the original paste is still the answer for the address now in the box, so
	// the echo of our own rewrite is skipped rather than allowed to erase it.
	// Without this every warning about the paste is cleared before it is painted.
	const rewritten = useRef(null);

	useEffect(() => {
		const echo = rewritten.current;
		rewritten.current = null;
		if (echo !== null && echo === value) return;
		// Whatever is in the box now is what the form is about, so a request read
		// out of a previous paste stops applying here, before anything else, and
		// its amount and its message go with it.
		//
		// An unreadable string is the exception. Half an address is what a field
		// holds while it is being edited, and dropping the request over it would
		// mean a stray keystroke in the middle of a long address quietly discarded
		// what the payee asked for. The request is held until the box holds a
		// different address, or nothing at all.
		if (parsed.kind === 'empty' || parsed.kind === 'bolt11' || parsed.kind === 'bolt12') dropRequest();
		if (parsed.kind === 'bolt11' || parsed.kind === 'bolt12') {
			const text = parsed.kind === 'bolt11' ? parsed.invoice : parsed.offer;
			if (onLightning(text)) return;
			setNote({
				tone: 'error',
				text: 'That is a Lightning invoice, and this wallet has no channel to pay it with yet.'
			});
			return;
		}
		if (parsed.kind === 'invalid') {
			// The refusal is rendered straight from the parse rather than stored,
			// because it has to be held back while the field is still being typed
			// into, and a note in state cannot be un-said. The request is kept: half
			// an address is what a field holds while it is being edited.
			setNote(null);
			return;
		}
		if (parsed.kind !== 'onchain') {
			setNote(null);
			return;
		}
		setNote(
			parsed.warnings.length > 0
				? { tone: 'info', text: parsed.warnings.map((w) => w.message).join(' ') }
				: null
		);
		// The box is made to hold the address the parser settled on, whatever
		// arrived. That is the string this form reasons about, the string the notes
		// above describe, and the string that goes to the daemon, and the three
		// being one string is the whole point: a note saying the full stop was
		// dropped, over a field that still holds it, is a note about money that is
		// not true. Doing it for every reading rather than for requests alone also
		// strips the scheme and the parameters, which the daemon's send has no
		// place for and reports as a fee error deep inside transaction building.
		if (value !== parsed.address) {
			rewritten.current = parsed.address;
			onChange(parsed.address);
		}
		if (!parsed.isRequest) {
			// A request goes on applying while the box still holds the address it
			// named, and stops the moment it does not.
			if (request && request.address !== parsed.address) dropRequest();
			return;
		}
		setRequest({
			address: parsed.address,
			amountSats: parsed.amountSats,
			message: parsed.message || parsed.label,
			lightning: parsed.lightning
		});
		// The payee's amount is not a preference for the form to reinterpret, so
		// it is set directly rather than through setAmountManually, which would
		// press Max the moment the request happened to ask for the whole balance.
		// It replaces whatever the field held outright: a figure left over from
		// the last request belongs to the last payee, not to this one.
		setMaxMode(false);
		setAmount(parsed.amountSats != null ? String(parsed.amountSats) : '');
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [parsed]);

	// What this transaction really costs, from the wallet, which is the only place
	// that knows. The fee turns on which UTXOs coin selection picks, on their
	// script types and on whether change is needed, so it is asked for rather than
	// guessed at, and asked for again whenever the amount, the rate or the mode
	// changes. The destination is part of the question: paying a taproot address
	// costs more than paying a P2WPKH one.
	const { quote } = useQuote(
		api,
		{
			// The address the parser settled on, never the raw box: a half typed
			// string is not a destination to price, and the price turns on the
			// destination's script type.
			address: parsed.kind === 'onchain' ? parsed.address : undefined,
			// A probe of 1 sat when nothing is typed yet: the ceiling of the amount
			// slider is the balance less the fee, so there has to be a fee before
			// there is a slider to type into. The wallet consolidates its UTXOs, so
			// the fee does not turn on the amount, and this re-quotes as it changes.
			amountSats: maxMode ? undefined : typed || 1,
			satsPerVbyte: effRate || undefined,
			max: maxMode
		},
		balance > 0 && effRate > 0
	);

	// A sweep spends everything and needs no change output, so it is smaller, pays
	// less, and sends more than any ordinary payment can. The wallet works out that
	// amount exactly; it is not balance minus a guess.
	const sweepAmount = maxMode ? (quote?.maxSendSats ?? null) : null;
	const feeSats = quote?.feeSats ?? null;
	const vsize = quote?.vsize ?? null;

	// The most an ordinary payment can send: everything the fee leaves behind.
	const ordinaryMax =
		balance != null && feeSats != null ? Math.max(0, balance - feeSats) : 0;

	// Pressing Max asks a new question, and the answer takes a moment to come back.
	// The range must not collapse to nothing while it does: a slider that drops to
	// zero mid-drag hands back a zero, which reads as "the user asked for nothing"
	// and knocks Max straight off again. Hold the last ceiling until the real one
	// arrives; it is a few hundred sats out for one frame, and never zero.
	const sliderMax = maxMode ? sweepAmount ?? ordinaryMax : ordinaryMax;

	// In max mode the amount is derived, never stored: storing it would freeze the
	// number taken at the moment Max was pressed, and it would then disagree with
	// the fee rate the payment actually goes out at.
	const shownAmount = maxMode
		? String(sweepAmount ?? ordinaryMax)
		: amount;
	const amountNum = maxMode ? sweepAmount || 0 : typed;

	// The one rule the form holds to: amount + fee never exceeds the balance. It is
	// enforced by refusing input that would break it rather than by accepting the
	// input and complaining afterwards, so the form is never in a state that cannot
	// be broadcast.
	//
	// The fee is the transaction's size times the rate, and the size is the quote's,
	// not an approximation of it. Sweeping has no amount to leave room for, only the
	// fee itself; otherwise the fee may grow into the gap between the amount and the
	// balance, and no further.
	const affordableRate =
		balance == null || !vsize
			? 0
			: maxMode
			? Math.floor(balance / vsize)
			: Math.floor(Math.max(0, balance - typed) / vsize);

	// Where the slider *ends*, which is a different question. A slider has to stop
	// somewhere, and a few times the fast estimate is a sane place for it, but that
	// is a convenience and not a rule: type 200 and the range grows to meet you,
	// rather than the form pretending 200 is not a fee rate. Affordability still
	// binds, because that one is arithmetic.
	const typedRate = parseInt(feeRate, 10) || 0;
	const feeMax = Math.max(
		1,
		Math.min(
			Math.max(fees?.fast ? fees.fast * FEE_CAP_MULTIPLE : 100, typedRate),
			affordableRate || Infinity
		)
	);

	// Reaching the top of the amount range means "everything", which is what Max is,
	// so arriving there presses it rather than leaving a number that Max would beat.
	// Coming back down leaves max mode, clamped to what an ordinary payment can send.
	const setAmountManually = (val) => {
		// Touching the amount takes it back from the request: from here on it is
		// the user's number, and the form treats it as one.
		releaseAmount();
		const next = parseInt(val, 10) || 0;
		if (maxMode) {
			// Still waiting on the sweep's own figure: nothing said now is a real
			// choice of amount, so it must not be taken as one.
			if (sweepAmount == null) return;
			if (next >= sweepAmount) return; // still at the top
			setMaxMode(false);
			setAmount(String(Math.min(next, ordinaryMax)));
			return;
		}
		if (ordinaryMax > 0 && next >= ordinaryMax) {
			setMaxMode(true);
			return;
		}
		setAmount(val);
	};

	// A fee the balance cannot cover alongside the amount is not accepted. Anything
	// it can cover is, however large, and the slider stretches to show it. An empty
	// field means "let the wallet pick" and always passes.
	const setFeeRateManually = (val) => {
		const next = parseInt(val, 10) || 0;
		if (affordableRate > 0 && next > affordableRate) return;
		setFeeRate(val);
	};

	// A request for more than the wallet holds is refused rather than reshaped.
	// The fallback below turns an unaffordable amount into a sweep, which is the
	// right answer when the number was the user's own reach for "everything", and
	// the wrong one when it is a payee's figure: a sweep pays a different amount
	// than was asked for, and the payment would be short.
	// The balance alone settles it before the quote lands, and the quote sharpens
	// it once it has: waiting for a fee to say "this is more than you have" would
	// leave the button live in the meantime.
	const requestedAmount = request?.amountSats ?? null;
	const requestTooLarge =
		requestedAmount != null &&
		balance != null &&
		(requestedAmount > balance || (feeSats != null && requestedAmount > ordinaryMax));

	// A balance that drops, or a fee that climbs, can still strand an amount that
	// was affordable when it was entered. Rather than leave the form unsendable,
	// fall back to sweeping, which is what the amount was reaching for.
	const stranded =
		!maxMode &&
		requestedAmount == null &&
		typed > 0 &&
		balance != null &&
		feeSats != null &&
		typed + feeSats > balance;
	useEffect(() => {
		if (stranded) setMaxMode(true);
	}, [stranded]);

	// Offering to sweep is good advice for someone reaching for everything they
	// have, and bad advice when a payee named the figure: sweeping would pay a
	// different amount than was asked for.
	const nearMax =
		!maxMode && requestedAmount == null && amountNum > 0 && balance != null && feeSats != null &&
		amountNum >= balance - feeSats * 2;

	const onDest = async (val) => {
		setDest(val);
		if (val === 'custom') {
			onChange('');
			return;
		}
		setFetchingAddr(true);
		try {
			const r = await walletApi(val).post('/address/new', {});
			onChange(r.address);
		} catch (e) {
			toast(`Could not get address: ${e.message}`, 'error');
			setDest('custom');
		} finally {
			setFetchingAddr(false);
		}
	};

	const send = async () => {
		setBusy(true);
		setTxid('');
		try {
			// What was read, not what was typed. The box is kept canonical above, so
			// the two agree; posting the parsed address is what makes that a
			// guarantee rather than an arrangement, since this is the last place the
			// two could ever part company.
			const base = { address: parsed.address };
			const rate = parseInt(feeRate, 10);
			if (rate > 0) base.satsPerVbyte = rate;
			const r = maxMode
				? await api.post('/send-max', base)
				: await api.post('/send', { ...base, amountSats: parseInt(amount, 10) });
			setTxid(r.txid);
			setMaxMode(false);
			setAmount('');
			setRequest(null);
			setNote(null);
			if (dest !== 'custom') setDest('custom');
			toast('Sent', 'success');
			bump();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title="Send on-chain">
			<div className="wallet-meta" style={{ marginBottom: 12 }}>
				Available: {fmtSats(balance)}
			</div>
			{others.length > 0 && (
				<Field label="Send to">
					<select value={dest} onChange={(e) => onDest(e.target.value)}>
						<option value="custom">Custom address</option>
						{others.map((w) => (
							<option key={w.id} value={w.id}>
								{w.name} ({w.network})
							</option>
						))}
					</select>
				</Field>
			)}
			<Field
				label="Recipient address or payment request"
				hint={
					parsed.kind === 'onchain' && !parsed.isRequest && parsed.addressType
						? `${parsed.addressType} address.`
						: undefined
				}
			>
				<input
					value={address}
					onChange={(e) => {
						onChange(e.target.value);
						if (dest !== 'custom') setDest('custom');
					}}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					placeholder={fetchingAddr ? 'Fetching address…' : 'bc1… or bitcoin:bc1…?amount=…'}
				/>
			</Field>
			{parsed.kind === 'invalid' && mayRefuse && <div className="error-note">{parsed.message}</div>}
			{note && <div className={note.tone === 'error' ? 'error-note' : 'info-note'}>{note.text}</div>}
			{/* While the box holds something unreadable, that is the only thing worth
			    saying about it. The request is still held, and says its piece again
			    as soon as the address is back. */}
			{request && parsed.kind === 'onchain' && (
				<div className="info-note">
					Read from a payment request
					{request.amountSats != null ? `, which asks for ${fmtSats(request.amountSats)}` : ''}.
					{request.lightning && canLightning ? ' It also carries a Lightning invoice.' : ''}
					{request.lightning && canLightning && (
						<div className="center-actions">
							<Button className="sm" onClick={() => onLightning(request.lightning.invoice)}>
								Pay over Lightning instead
							</Button>
						</div>
					)}
				</div>
			)}
			{request?.message && (
				<Field
					label="Message"
					hint="From the payment request. It is for your records, and does not travel with the transaction."
				>
					<input value={request.message} readOnly />
				</Field>
			)}
			<AmountField
				label="Amount (sats)"
				value={shownAmount}
				onChange={setAmountManually}
				max={maxMode ? sweepAmount || 0 : sliderMax}
				isMax={maxMode}
				onMax={() => {
					// Pressing Max is choosing an amount, the same as typing one, so
					// the payee's figure stops binding here too. Otherwise the form
					// would sweep the wallet while still claiming to pay their sum.
					releaseAmount();
					setMaxMode((v) => !v);
				}}
				hint={
					maxMode
						? 'Sweeps the whole balance. The wallet works out the exact amount when it broadcasts, so this follows the fee rate you pick.'
						: 'The slider stops at the most you can send at this fee rate, so it leaves room for the fee.'
				}
			/>
			{requestTooLarge && parsed.kind === 'onchain' && (
				<div className="error-note">
					This request asks for {fmtSats(requestedAmount)}, which is more than this wallet can send.{' '}
					{feeSats != null
						? `The most it can send at this fee rate is ${fmtSats(ordinaryMax)}, with the fee coming out of the rest. Ask for a smaller amount, or lower the fee rate.`
						: `It holds ${fmtSats(balance)}. Ask for a smaller amount.`}
				</div>
			)}
			<FeeField
				label="Fee rate (sat/vB)"
				value={feeRate}
				onChange={setFeeRateManually}
				rate={effRate}
				max={feeMax}
				hint={
					maxMode
						? 'With Max on, raising the fee takes sats off the amount above, so the total never exceeds your balance.'
						: 'Stops where the fee would eat into the amount above. Lower the amount to raise it further, or leave empty to let the wallet pick.'
				}
			/>
			{fees && (
				<div className="preset-row" style={{ marginBottom: 14 }}>
					{[
						['Fast', fees.fast],
						['Normal', fees.normal],
						['Slow', fees.slow]
					].map(([label, rate]) => (
						<button
							key={label}
							type="button"
							className="btn sm"
							// A preset above the headroom would break the same rule the
							// slider is held to, so it is offered but not selectable.
							disabled={rate > feeMax}
							title={rate > feeMax ? 'Lower the amount to afford this fee rate' : undefined}
							onClick={() => setFeeRateManually(String(rate))}
						>
							{label} · {rate} sat/vB
						</button>
					))}
				</div>
			)}
			{feeSats != null && (
				<div className="wallet-meta" style={{ marginBottom: 12 }}>
					Fee: {fmtSats(feeSats)} at {effRate} sat/vB over {vsize} vB. This is what the
					transaction pays, not an estimate of it.
				</div>
			)}
			{nearMax && (
				<div className="info-note" style={{ marginBottom: 12 }}>
					This is close to your full balance. Use Max to sweep everything without leaving dust behind.
				</div>
			)}
			<Button
				variant="primary"
				busy={busy}
				onClick={send}
				// Nothing but a destination the parser could read goes to the daemon.
				// It refuses the rest anyway, but it refuses them from inside
				// transaction building, with a message about fees rather than about
				// the address, long after the note above said what was wrong.
				disabled={
					parsed.kind !== 'onchain' ||
					amountNum <= 0 ||
					balance === 0 ||
					fetchingAddr ||
					requestTooLarge
				}
			>
				{maxMode ? 'Send max' : 'Send'}
			</Button>
			{txid && (
				<div className="info-note" style={{ marginTop: 12 }}>
					Broadcast: <span className="mono">{txid}</span>
				</div>
			)}
		</Card>
	);
}

// Long enough that a typed invoice is not decoded character by character, short
// enough that a pasted one answers before the eye leaves the field.
const DECODE_DEBOUNCE_MS = 300;

function Lightning({ api, rec, channels, value, onChange, onOnchain, bump }) {
	const toast = useToast();
	const [decoded, setDecoded] = useState(null);
	const [estimate, setEstimate] = useState(null);
	const [error, setError] = useState(null);
	const [decoding, setDecoding] = useState(false);
	const [amount, setAmount] = useState('');
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(null);
	const [now, setNow] = useState(() => Date.now());
	const [focused, setFocused] = useState(false);
	// Only the newest decode may write its answer: a slow one must not overwrite
	// a fresher one that landed first.
	const latest = useRef(0);
	const latestEstimate = useRef(0);

	const parsed = useMemo(() => parsePayment(value, { network: rec?.network }), [value, rec?.network]);
	const invoice = parsed.kind === 'bolt11' ? parsed.invoice : null;
	const mayRefuse = useSettledRefusal(value, focused);

	// An on-chain address in the invoice box belongs on the other rail.
	useEffect(() => {
		if (parsed.kind === 'onchain') onOnchain(value);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [parsed]);

	// Tidy what was pasted down to the invoice itself: the lightning: scheme and
	// the capitals a QR code arrives in are not part of it.
	useEffect(() => {
		if (invoice && value !== invoice) onChange(invoice);
	}, [invoice, value, onChange]);

	// Reading an invoice is the daemon's job and it is asked as soon as there is
	// something to ask about. There is no Decode button: pressing one to find out
	// what you are about to pay is a step that only ever had one right answer.
	useEffect(() => {
		if (!invoice) {
			// Anything in flight belongs to a string that is no longer in the box.
			latest.current += 1;
			setDecoded(null);
			setEstimate(null);
			setAmount('');
			setError(null);
			setDecoding(false);
			return () => {};
		}
		const id = ++latest.current;
		// The panel empties the moment the invoice changes, because everything in
		// it belongs to the invoice that has just left. Leaving the previous
		// amount, description, payee and expiry standing under a box that holds a
		// different invoice describes a payment nobody is about to make, and the
		// removal of the Decode button was the promise that what is on screen is
		// what you are about to pay.
		//
		// The payer's own amount goes with it. It was chosen for a different payee,
		// and carried over it arrives pre-filled against this one, looking exactly
		// as though this invoice had named it, with Pay enabled. One click then
		// sends a figure chosen for someone else.
		setDecoded(null);
		setEstimate(null);
		setAmount('');
		setDecoding(true);
		setError(null);
		setResult(null);
		const timer = setTimeout(() => {
			api
				.post('/invoice/decode', { bolt11: invoice })
				.then((d) => {
					if (id !== latest.current) return;
					setDecoded(d);
					setError(null);
				})
				.catch((e) => {
					if (id !== latest.current) return;
					setDecoded(null);
					setError(e.message);
				})
				.finally(() => {
					if (id === latest.current) setDecoding(false);
				});
		}, DECODE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [api, invoice]);

	// An invoice with no amount in it leaves the amount to the payer, so it has to
	// be asked for before anything can be estimated or paid.
	const needsAmount = decoded != null && decoded.amountSats == null;
	const typedAmount = parseInt(amount, 10) || 0;
	const amountSats = needsAmount ? typedAmount : decoded?.amountSats ?? 0;

	// The expiry is seconds since the epoch, counted from the invoice's own
	// timestamp, and an invoice without an expiry tag has none to show. The clock
	// is ticked while one is on screen so that "expires in a minute" becomes
	// "expired" on its own rather than when something else happens to re-render.
	// Read before the estimate below, which must not be asked for at all once the
	// answer cannot be acted on.
	const expiresAt =
		decoded && decoded.timestamp != null && decoded.expiry != null
			? (decoded.timestamp + decoded.expiry) * 1000
			: null;
	useEffect(() => {
		if (expiresAt == null) return () => {};
		const timer = setInterval(() => setNow(Date.now()), 15000);
		setNow(Date.now());
		return () => clearInterval(timer);
	}, [expiresAt]);
	const expired = expiresAt != null && expiresAt <= now;

	useEffect(() => {
		// An expired invoice is not routable, so there is nothing to estimate. The
		// estimate is the most reassuring row in the panel, and offering one for a
		// payment this same card has just refused puts two statements on screen that
		// cannot both be acted on, which makes the refusal look arguable. It also
		// spends a daemon round trip on a payment that cannot happen.
		if (!invoice || !decoded || expired || amountSats <= 0) {
			// The sequence has to move even on the way out, or an estimate already in
			// flight still matches and writes its answer after the amount it was
			// asked about has gone. The decode effect above gets this right, which is
			// what made the omission here look accidental.
			latestEstimate.current += 1;
			setEstimate(null);
			return () => {};
		}
		const id = ++latestEstimate.current;
		const timer = setTimeout(() => {
			api
				.post('/payment/estimate', needsAmount ? { bolt11: invoice, amountSats } : { bolt11: invoice })
				.then((e) => {
					if (id === latestEstimate.current) setEstimate(e);
				})
				.catch(() => {
					if (id === latestEstimate.current) setEstimate(null);
				});
		}, DECODE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [api, invoice, decoded, expired, needsAmount, amountSats]);

	// The most that can leave over Lightning, for the amount slider a zero-amount
	// invoice needs. Routing fees and each channel's reserve come out of it, so
	// this is a ceiling rather than a promise.
	const outbound = (channels || [])
		.filter(usable)
		.reduce((sum, c) => sum + (c.localBalanceSats || 0), 0);

	const pay = async () => {
		setBusy(true);
		setResult(null);
		try {
			const body = { bolt11: invoice };
			if (needsAmount) body.amountSats = typedAmount;
			const r = await api.post('/invoice/pay-safe', body);
			setResult(r);
			toast(r.status === 'COMPLETED' ? 'Payment sent' : `Payment ${r.status}`, r.status === 'COMPLETED' ? 'success' : 'error');
			bump();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	const clear = () => {
		onChange('');
		setAmount('');
		setResult(null);
	};

	return (
		<Card title="Pay a Lightning invoice">
			<Field label="BOLT11 invoice">
				<textarea
					rows={3}
					value={value}
					onChange={(e) => onChange(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					placeholder="lnbc…"
				/>
			</Field>
			{parsed.kind === 'invalid' && mayRefuse && <div className="error-note">{parsed.message}</div>}
			{parsed.kind === 'bolt12' && (
				<div className="info-note">
					That is a BOLT12 offer rather than an invoice. Pay it from the Offers tab.
				</div>
			)}
			{error && <div className="error-note">{error}</div>}
			{/* Not `decoding && !decoded`: the panel is emptied the moment the invoice
			    changes, and the one moment the reader most needs to be told "this is
			    not your invoice yet" was exactly the moment that gate said nothing. */}
			{decoding && <div className="wallet-meta">Reading the invoice…</div>}
			{decoded && (
				<>
					<table style={{ marginTop: 4 }}>
						<tbody>
							<tr>
								<td className="wallet-meta">Amount</td>
								<td>{decoded.amountSats ? fmtSats(decoded.amountSats) : 'any (you choose below)'}</td>
							</tr>
							<tr>
								<td className="wallet-meta">Description</td>
								<td>{decoded.description || '-'}</td>
							</tr>
							<tr>
								<td className="wallet-meta">Payee</td>
								<td className="mono">{shortId(decoded.payeeNodeKey)}</td>
							</tr>
							{expiresAt != null && (
								<tr>
									<td className="wallet-meta">Expires</td>
									<td>
										{expired
											? `Expired ${fmtDuration((now - expiresAt) / 1000)} ago`
											: `In ${fmtDuration((expiresAt - now) / 1000)}`}
									</td>
								</tr>
							)}
							{estimate && !expired && (
								<tr>
									<td className="wallet-meta">Estimate</td>
									<td>
										~{fmtSats(estimate.estimatedFeeSats)} fee · {estimate.successProbabilityPct}% success ·{' '}
										{estimate.hopCount} hops
									</td>
								</tr>
							)}
						</tbody>
					</table>
					{decoded.warnings?.length > 0 && (
						<div className="info-note" style={{ marginTop: 12 }}>
							{decoded.warnings.map(formatInvoiceWarning).join(' ')}
						</div>
					)}
					{needsAmount && (
						<div style={{ marginTop: 12 }}>
							<AmountField
								label="Amount to pay (sats)"
								value={amount}
								onChange={setAmount}
								max={outbound}
								onMax={() => setAmount(String(outbound))}
								isMax={outbound > 0 && typedAmount === outbound}
								hint="This invoice names no amount, so it is yours to choose. Bounded by your outbound channel balance, which routing fees and the channel reserve come out of."
							/>
						</div>
					)}
					{expired && (
						<div className="error-note">
							This invoice has expired, so it can no longer be paid. Ask for a new one.
						</div>
					)}
				</>
			)}
			<div className="center-actions">
				<Button
					variant="primary"
					busy={busy}
					onClick={pay}
					disabled={!decoded || decoding || expired || (needsAmount && typedAmount <= 0)}
				>
					{decoded?.amountSats ? `Pay ${fmtSats(decoded.amountSats)}` : 'Pay'}
				</Button>
				{value && <Button onClick={clear}>Clear</Button>}
			</div>
			{result && (
				<div className={result.status === 'COMPLETED' ? 'info-note' : 'error-note'} style={{ marginTop: 12 }}>
					Payment {result.status}
					{result.feeSats != null ? ` · fee ${fmtSats(result.feeSats)}` : ''}
					{result.failureDescription ? ` · ${result.failureDescription}` : ''}
				</div>
			)}
		</Card>
	);
}

function Keysend({ api, channels, bump }) {
	const toast = useToast();
	const [pubkey, setPubkey] = useState('');
	const [amount, setAmount] = useState('');
	const [busy, setBusy] = useState(false);

	// The most that can leave over Lightning is the local side of the usable
	// channels. Routing fees and each channel's reserve come out of that, so this
	// is a ceiling rather than a promise, and the slider is bounded by it only to
	// keep the amount in the right order of magnitude.
	const outbound = (channels || [])
		.filter(usable)
		.reduce((sum, c) => sum + (c.localBalanceSats || 0), 0);

	const send = async () => {
		setBusy(true);
		try {
			const r = await api.post('/keysend/safe', {
				pubkey: pubkey.trim(),
				amountSats: parseInt(amount, 10)
			});
			toast(r.status === 'COMPLETED' ? 'Keysend sent' : `Keysend ${r.status}`, r.status === 'COMPLETED' ? 'success' : 'error');
			bump();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<Card title="Keysend (spontaneous payment)">
			<Field label="Destination node pubkey">
				<input value={pubkey} onChange={(e) => setPubkey(e.target.value)} placeholder="02…" />
			</Field>
			<AmountField
				label="Amount (sats)"
				value={amount}
				onChange={setAmount}
				max={outbound}
				onMax={() => setAmount(String(outbound))}
				isMax={outbound > 0 && parseInt(amount, 10) === outbound}
				hint="Bounded by your outbound channel balance. Routing fees and the channel reserve come out of it, so the very top of the range may not go through."
			/>
			<Button variant="primary" busy={busy} onClick={send} disabled={!pubkey || !amount}>
				Send keysend
			</Button>
		</Card>
	);
}
