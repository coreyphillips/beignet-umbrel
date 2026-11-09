import { useEffect, useRef, useState } from 'react';
import { useToast } from './Toast.jsx';
import { AmountField, Badge, Button, CopyText, Field } from './ui.jsx';
import { fmtSats, shortId } from '../lib/format.js';
import { beginOwnPayment, endOwnPayment } from '../lib/own-payments.js';
import { createReceiveInvoice } from '../lib/receive-invoice.js';
import { manager } from '../api.js';

const RESOLVE_DEBOUNCE_MS = 350;

/** What a login link asks to do, in words. LUD-04's actions. */
const LOGIN_ACTION = {
	register: 'Create an account on',
	login: 'Log in to',
	link: 'Link this wallet to an account on',
	auth: 'Confirm an action on'
};

/**
 * Read an LNURL or Lightning address through the manager once the box has
 * settled, keeping only the newest answer. `input` null clears it.
 * Returns `{ link, error, resolving, again }`; `again()` reads the same input
 * afresh (a session lapses after ten minutes).
 */
export function useLnurlResolve(id, input) {
	const [state, setState] = useState({ link: null, error: null, resolving: false });
	const latest = useRef(0);
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		const seq = ++latest.current;
		if (!input) {
			setState({ link: null, error: null, resolving: false });
			return () => {};
		}
		setState({ link: null, error: null, resolving: true });
		const timer = setTimeout(() => {
			manager
				.lnurlResolve(id, input)
				.then((link) => seq === latest.current && setState({ link, error: null, resolving: false }))
				.catch((e) => seq === latest.current && setState({ link: null, error: e.message, resolving: false }));
		}, RESOLVE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [id, input, nonce]);
	return { ...state, again: () => setNonce((n) => n + 1) };
}

/**
 * Ask a pay link for its invoice, reading the link again once if its
 * session has lapsed in the meantime. Returns the manager's answer, the
 * invoice already checked against what was shown.
 */
export async function lnurlInvoice(id, link, input, amountSats, comment) {
	try {
		return await manager.lnurlPay(id, { session: link.session, amountSats, comment });
	} catch (e) {
		if (e.code !== 'LNURL_EXPIRED' || !input) throw e;
		const fresh = await manager.lnurlResolve(id, input);
		if (fresh.tag !== 'pay') throw e;
		return { ...(await manager.lnurlPay(id, { session: fresh.session, amountSats, comment })), session: fresh.session };
	}
}

/** Who a link is from, as the reader should check it. */
export function LnurlFrom({ link }) {
	return (
		<span>
			{link.lightningAddress || link.domain}
			{link.lightningAddress && link.domain && !link.lightningAddress.endsWith(`@${link.domain}`) ? ` (${link.domain})` : ''}
		</span>
	);
}

/**
 * What a paid LNURL sends back (LUD-09): a message, a link on the service's
 * own domain, or a message sealed with the payment's preimage (LUD-10),
 * opened by the manager on request.
 */
export function LnurlSuccess({ id, session, action, preimage }) {
	const toast = useToast();
	const [opened, setOpened] = useState(null);
	const [busy, setBusy] = useState(false);
	if (!action) return null;
	const open = async () => {
		setBusy(true);
		try {
			setOpened(await manager.lnurlSuccess(id, { session, preimage }));
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="info-note" role="status" style={{ marginTop: 12 }} data-testid="lnurl-success">
			{action.tag === 'message' && <div>{action.message}</div>}
			{action.tag === 'url' && (
				<div>
					{action.description ? `${action.description} ` : ''}
					<a href={action.url} target="_blank" rel="noopener noreferrer">
						{action.url}
					</a>
				</div>
			)}
			{action.tag === 'aes' &&
				(opened ? (
					<div>
						{opened.description ? `${opened.description}: ` : ''}
						<span className="mono">{opened.message}</span>
					</div>
				) : (
					<div>
						{action.description || 'The service sent a sealed message with the payment.'}{' '}
						<Button className="sm" busy={busy} onClick={open} disabled={!preimage}>
							Show it
						</Button>
					</div>
				))}
		</div>
	);
}

/**
 * Pay an LNURL-pay link or Lightning address: the amount inside its limits,
 * an optional comment when the service takes one, then the invoice it hands
 * back, checked by the manager and paid like any other.
 */
export function LnurlPay({ id, api, link, input, outbound, bump }) {
	const toast = useToast();
	const fixed = link.minSats === link.maxSats ? link.minSats : null;
	const [amount, setAmount] = useState(fixed != null ? String(fixed) : '');
	const [comment, setComment] = useState('');
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState(null);
	const typed = fixed ?? (parseInt(amount, 10) || 0);
	const ceiling = Math.min(link.maxSats, outbound > 0 ? outbound : link.maxSats);
	const outOfRange = typed > 0 && (typed < link.minSats || typed > link.maxSats);

	const pay = async () => {
		setBusy(true);
		setResult(null);
		try {
			const got = await lnurlInvoice(id, link, input, typed, comment);
			const own = beginOwnPayment();
			let r;
			try {
				r = await api.post('/invoice/pay-safe', { bolt11: got.bolt11 });
			} finally {
				endOwnPayment(own, r?.paymentHash);
			}
			setResult({ payment: r, session: got.session || link.session, successAction: got.successAction });
			toast(r.status === 'COMPLETED' ? 'Payment sent' : `Payment ${r.status}`, r.status === 'COMPLETED' ? 'success' : 'error');
			bump?.();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	return (
		<div>
			<table style={{ marginTop: 4 }}>
				<tbody>
					<tr>
						<td className="wallet-meta">Pay</td>
						<td>
							<LnurlFrom link={link} />
						</td>
					</tr>
					<tr>
						<td className="wallet-meta">Description</td>
						<td>{link.description || '-'}</td>
					</tr>
					<tr>
						<td className="wallet-meta">Amount</td>
						<td>
							{fixed != null ? fmtSats(fixed) : `${fmtSats(link.minSats)} to ${fmtSats(link.maxSats)}`}
						</td>
					</tr>
				</tbody>
			</table>
			{fixed == null && (
				<div style={{ marginTop: 12 }}>
					<AmountField
						label="Amount to pay (sats)"
						value={amount}
						onChange={setAmount}
						max={ceiling}
						onMax={() => setAmount(String(ceiling))}
						isMax={ceiling > 0 && typed === ceiling}
						hint={`${link.domain} takes ${fmtSats(link.minSats)} to ${fmtSats(link.maxSats)}.`}
					/>
				</div>
			)}
			{link.commentAllowed > 0 && (
				<Field label="Comment (optional)">
					<input
						value={comment}
						maxLength={link.commentAllowed}
						onChange={(e) => setComment(e.target.value)}
						placeholder={`Sent to ${link.domain} with the payment`}
					/>
				</Field>
			)}
			{outOfRange && (
				<div className="error-note" role="alert" style={{ marginTop: 12 }}>
					{link.domain} takes {fmtSats(link.minSats)} to {fmtSats(link.maxSats)}.
				</div>
			)}
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={pay} disabled={typed <= 0 || outOfRange}>
					{typed > 0 ? `Pay ${fmtSats(typed)}` : 'Pay'}
				</Button>
			</div>
			{result && (
				<div
					className={result.payment.status === 'COMPLETED' ? 'info-note' : 'error-note'}
					role={result.payment.status === 'COMPLETED' ? 'status' : 'alert'}
					style={{ marginTop: 12 }}
				>
					Payment {result.payment.status}
					{result.payment.feeSats != null ? ` · fee ${fmtSats(result.payment.feeSats)}` : ''}
					{result.payment.failureDescription ? ` · ${result.payment.failureDescription}` : ''}
				</div>
			)}
			{result?.payment.status === 'COMPLETED' && (
				<LnurlSuccess
					id={id}
					session={result.session}
					action={result.successAction}
					preimage={result.payment.preimage}
				/>
			)}
		</div>
	);
}

/**
 * Pull from an LNURL-withdraw link: this wallet makes the invoice (the way
 * the Receive tab would, just-in-time capacity included) and the manager
 * hands it to the service, which pays it.
 */
export function LnurlWithdraw({ id, api, rec, link, lastReceive, onDone, actions }) {
	const toast = useToast();
	const fixed = link.minSats === link.maxSats ? link.minSats : null;
	const [amount, setAmount] = useState(String(fixed ?? link.maxSats));
	const [busy, setBusy] = useState(false);
	const [asked, setAsked] = useState(null);
	const typed = fixed ?? (parseInt(amount, 10) || 0);
	const outOfRange = typed > 0 && (typed < link.minSats || typed > link.maxSats);
	const received =
		asked && lastReceive?.rail === 'lightning' && lastReceive.paymentHash && lastReceive.paymentHash === asked.paymentHash;

	const withdraw = async () => {
		setBusy(true);
		try {
			const { invoice } = await createReceiveInvoice({
				api,
				rec,
				amountSats: typed,
				description: link.defaultDescription || `Withdrawal from ${link.domain}`,
				getWallet: manager.getWallet
			});
			const r = await manager.lnurlWithdraw(id, { session: link.session, bolt11: invoice.bolt11 });
			setAsked({ amountSats: typed, paymentHash: r.paymentHash || invoice.paymentHash });
			toast(`${link.domain} is paying ${fmtSats(typed)} into this wallet`, 'success');
			onDone?.();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	if (asked) {
		return (
			<>
			<div className="info-note" role="status" data-testid="lnurl-withdrawn">
				{received ? (
					<>
						<Badge tone="green">received</Badge> {fmtSats(asked.amountSats)} from {link.domain}.
					</>
				) : (
					<>
						{link.domain} accepted the invoice for {fmtSats(asked.amountSats)} and pays it on its own. It shows
						in Activity when it arrives.
					</>
				)}
			</div>
			{actions && <div className="center-actions">{actions}</div>}
			</>
		);
	}

	return (
		<div>
			<table style={{ marginTop: 4 }}>
				<tbody>
					<tr>
						<td className="wallet-meta">Withdraw from</td>
						<td>{link.domain}</td>
					</tr>
					{link.defaultDescription && (
						<tr>
							<td className="wallet-meta">Description</td>
							<td>{link.defaultDescription}</td>
						</tr>
					)}
					<tr>
						<td className="wallet-meta">Available</td>
						<td>{fixed != null ? fmtSats(fixed) : `${fmtSats(link.minSats)} to ${fmtSats(link.maxSats)}`}</td>
					</tr>
				</tbody>
			</table>
			{fixed == null && (
				<div style={{ marginTop: 12 }}>
					<AmountField
						label="Amount to withdraw (sats)"
						value={amount}
						onChange={setAmount}
						max={link.maxSats}
						onMax={() => setAmount(String(link.maxSats))}
						isMax={typed === link.maxSats}
					/>
				</div>
			)}
			{outOfRange && (
				<div className="error-note" role="alert" style={{ marginTop: 12 }}>
					{link.domain} pays out {fmtSats(link.minSats)} to {fmtSats(link.maxSats)}.
				</div>
			)}
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={withdraw} disabled={typed <= 0 || outOfRange}>
					{typed > 0 ? `Withdraw ${fmtSats(typed)}` : 'Withdraw'}
				</Button>
				{actions}
			</div>
		</div>
	);
}

/**
 * Log in with LNURL-auth: a key this wallet derives for the one domain
 * (LUD-05), so the site sees the same key every time and no other site can
 * link it to this one.
 */
export function LnurlAuth({ id, link, onDone, actions }) {
	const toast = useToast();
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(null);
	const verb = LOGIN_ACTION[link.action] || LOGIN_ACTION.login;

	const login = async () => {
		setBusy(true);
		try {
			const r = await manager.lnurlAuth(id, { session: link.session });
			setDone(r);
			toast(`Signed in to ${r.domain}`, 'success');
			onDone?.();
		} catch (e) {
			toast(e.message, 'error');
		} finally {
			setBusy(false);
		}
	};

	if (done) {
		return (
			<>
			<div className="info-note" role="status" data-testid="lnurl-logged-in">
				{link.domain} accepted the signature. It knows this wallet by the key{' '}
				<CopyText value={done.linkingKey} label={shortId(done.linkingKey)} />, which this wallet uses for{' '}
				{link.domain} alone.
			</div>
			{actions && <div className="center-actions">{actions}</div>}
			</>
		);
	}

	return (
		<div>
			<div style={{ marginTop: 4 }}>
				{verb} <strong>{link.domain}</strong> with this wallet?
			</div>
			<div className="wallet-meta" style={{ marginTop: 6 }}>
				Check the site name is the one you meant. Nothing is paid.
			</div>
			<div className="center-actions">
				<Button variant="primary" busy={busy} onClick={login}>
					{link.action === 'register' ? 'Create account' : 'Log in'}
				</Button>
				{actions}
			</div>
		</div>
	);
}
