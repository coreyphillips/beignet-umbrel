import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	channelStateLabel,
	humanize,
	invoiceStatusLabel,
	paymentStatusLabel,
	walletStatusLabel
} from './labels.js';

test('channel states read as words and keep the raw code', () => {
	assert.deepEqual(channelStateLabel('AWAITING_FUNDING_CONFIRMED'), {
		label: 'Confirming',
		tone: 'yellow',
		raw: 'AWAITING_FUNDING_CONFIRMED'
	});
	assert.equal(channelStateLabel('NORMAL').label, 'Active');
	assert.equal(channelStateLabel('FORCE_CLOSED').tone, 'red');
});

test('an unknown code is humanized rather than shown raw', () => {
	assert.deepEqual(channelStateLabel('WAITING_FOR_PEER'), {
		label: 'Waiting for peer',
		tone: 'muted',
		raw: 'WAITING_FOR_PEER'
	});
	assert.equal(humanize('restore-required'), 'Restore required');
	assert.equal(humanize(null), '');
});

test('payment, invoice and wallet statuses map in any case', () => {
	assert.equal(paymentStatusLabel('completed').label, 'Completed');
	assert.equal(paymentStatusLabel('FAILED').tone, 'red');
	assert.equal(invoiceStatusLabel(undefined).label, 'Open');
	assert.equal(invoiceStatusLabel('PAID').tone, 'green');
	assert.equal(walletStatusLabel('restore-required').label, 'Restore needed');
	assert.equal(walletStatusLabel('running').tone, 'green');
});
