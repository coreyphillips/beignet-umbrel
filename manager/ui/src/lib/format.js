export function fmtSats(n) {
	if (n === null || n === undefined) return '-';
	return Number(n).toLocaleString('en-US') + ' sats';
}

export function fmtBtc(sats) {
	if (sats === null || sats === undefined) return '-';
	const btc = Number(sats) / 1e8;
	return `${btc.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 8 })} BTC`;
}

export function shortId(hex, n = 6) {
	if (!hex) return '-';
	const s = String(hex);
	if (s.length <= n * 2 + 1) return s;
	return `${s.slice(0, n)}…${s.slice(-n)}`;
}

export function fmtDate(ts) {
	if (!ts) return '-';
	const d = new Date(Number(ts));
	if (Number.isNaN(d.getTime())) return '-';
	return d.toLocaleString();
}

export function pct(n) {
	if (n === null || n === undefined) return '-';
	return `${Math.round(Number(n))}%`;
}

export async function copy(text) {
	// Umbrel serves apps over plain HTTP on the LAN, which is not a secure
	// context, so navigator.clipboard is often unavailable. Fall back to a
	// hidden textarea + execCommand.
	try {
		if (navigator.clipboard && window.isSecureContext) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch (_) {
		/* fall through */
	}
	try {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.top = '-1000px';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(ta);
		return ok;
	} catch (_) {
		return false;
	}
}
