/**
 * Text that goes into an invoice or offer: a description, an offer issuer.
 *
 * Beignet 0.41.0 applies BOLT 1's string rule to these and answers
 * INVALID_PARAMS for one holding a control, format (zero-width, bidi, the
 * U+200D that joins emoji), surrogate, private-use or unassigned character
 * (coreyphillips/beignet#2074). A note can hold a pasted line break, a joined
 * emoji carries U+200D, and an LNURL service names its own default
 * description, so line breaks and tabs become a space and the other
 * characters are left out. A joined emoji comes out as its parts side by side.
 */
export function protocolText(value) {
	return String(value ?? '')
		.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
		.replace(/\p{C}/gu, '')
		.trim();
}
