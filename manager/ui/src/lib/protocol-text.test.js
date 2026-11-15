/**
 * Run with: npm test (from manager/ui).
 *
 * What an invoice or offer description is cleaned of before the engine sees
 * it (coreyphillips/beignet#2074).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { protocolText } from './protocol-text.js';

test('line breaks and tabs become one space, joiners and bidi controls are left out', () => {
	const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
	assert.equal(protocolText('Lunch\r\nwith\tAlex ' + family + '\u202E!'), 'Lunch with Alex \u{1F468}\u{1F469}\u{1F467}!');
});

test('plain text, accents and a lone emoji pass unchanged', () => {
	for (const s of ['Donations', 'Café crème', 'Coffee ☕️', '日本']) assert.equal(protocolText(s), s);
});

test('nothing left is an empty string, and a missing value is one too', () => {
	assert.equal(protocolText('\u200B\u200D\n'), '');
	assert.equal(protocolText(undefined), '');
	assert.doesNotMatch(protocolText('a\u0000b\u{F0000}c\u2028d'), /[\p{C}\u2028\u2029]/u);
});
