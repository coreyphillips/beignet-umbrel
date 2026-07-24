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

/**
 * A span of seconds in the largest unit that still reads as a number rather
 * than a measurement: "3 minutes" and "2 days", never "0.05 hours".
 */
export function fmtDuration(seconds) {
	const s = Math.abs(Math.round(Number(seconds) || 0));
	if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
	const minutes = Math.round(s / 60);
	if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
	const days = Math.round(hours / 24);
	return `${days} day${days === 1 ? '' : 's'}`;
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
