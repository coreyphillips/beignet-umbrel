/**
 * Run with: npm test (from manager/ui).
 *
 * The lightning-first block shared by the create form and the edit dialog:
 * what it posts, when it is complete, who may be a primary, and what the
 * form shows for each choice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement, useState } from 'react';
import { click, render, select, type } from '../../test/render.mjs';
import LfbwFields, { EMPTY_LFBW, lfbwBody, lfbwComplete, primaryCandidates } from './LfbwFields.jsx';

const PK = '02' + 'ab'.repeat(32);

test('lfbwBody posts the internal or the external shape, and nothing when off', () => {
	assert.deepEqual(lfbwBody({ ...EMPTY_LFBW }), { enabled: false });
	assert.deepEqual(lfbwBody({ enabled: true, primaryWalletId: 'p1', trusted: true, initialChannelSats: '200000' }), {
		enabled: true,
		trusted: true,
		primaryWalletId: 'p1',
		initialChannelSats: 200000
	});
	assert.deepEqual(lfbwBody({ enabled: true, primaryWalletId: 'p1', trusted: false, initialChannelSats: '' }), {
		enabled: true,
		trusted: false,
		primaryWalletId: 'p1'
	});
	assert.deepEqual(lfbwBody({ enabled: true, primaryWalletId: 'external', primaryUri: ` ${PK}@lsp.example:9735 `, trusted: false }), {
		enabled: true,
		trusted: false,
		primaryUri: `${PK}@lsp.example:9735`
	});
});

test('lfbwComplete needs a primary picked, and a well-formed URI for an external one', () => {
	assert.equal(lfbwComplete({ ...EMPTY_LFBW }), true);
	assert.equal(lfbwComplete({ enabled: true, primaryWalletId: '' }), false);
	assert.equal(lfbwComplete({ enabled: true, primaryWalletId: 'p1' }), true);
	assert.equal(lfbwComplete({ enabled: true, primaryWalletId: 'external', primaryUri: 'nope' }), false);
	assert.equal(lfbwComplete({ enabled: true, primaryWalletId: 'external', primaryUri: `${PK}@lsp.example:9735` }), true);
});

test('a primary candidate is running, on the network, with Lightning on, and not lightning-first itself', () => {
	const wallets = [
		{ id: 'a', status: 'running', network: 'mainnet' },
		{ id: 'b', status: 'stopped', network: 'mainnet' },
		{ id: 'c', status: 'running', network: 'testnet' },
		{ id: 'd', status: 'running', network: 'mainnet', onchainOnly: true },
		{ id: 'e', status: 'running', network: 'mainnet', lfbw: { enabled: true } },
		{ id: 'self', status: 'running', network: 'mainnet' }
	];
	assert.deepEqual(
		primaryCandidates(wallets, { network: 'mainnet', selfId: 'self' }).map((w) => w.id),
		['a']
	);
});

function Harness({ initial, candidates, editing }) {
	const [value, setValue] = useState(initial);
	return createElement(LfbwFields, { value, onChange: setValue, candidates, editing });
}

test('ticking the box reveals the primary picker; a sibling shows trust and the starting channel, external shows the URI', async () => {
	const candidates = [{ id: 'p1', name: 'Main', network: 'mainnet' }];
	const r = await render(Harness, { initial: { ...EMPTY_LFBW }, candidates });
	try {
		assert.equal(r.$('select'), null, 'nothing but the checkbox until it is ticked');
		await click(r.$('input[type="checkbox"]'));
		assert.ok(r.$('select'));
		assert.match(r.text(), /One balance, held in a single channel/);
		await select(r.$('select'), 'p1');
		assert.match(r.text(), /Zero-conf both ways/);
		assert.match(r.text(), /Starting channel/);
		await select(r.$('select'), 'external');
		assert.match(r.text(), /External node URI/);
		assert.doesNotMatch(r.text(), /Starting channel/, 'a starting channel is opened FROM the primary, which is not ours to command');
		await type(r.$('input[placeholder^="02abc"]'), `${PK}@lsp.example:9735`);
		assert.match(r.text(), /Trust this node for zero-conf/);
		assert.match(r.text(), /provide inbound capacity just in time for a payment/, 'trusted by default, and says what for');
	} finally {
		await r.unmount();
	}
});

test('with no candidate the picker says why, and editing hides the starting channel', async () => {
	const r = await render(Harness, { initial: { ...EMPTY_LFBW, enabled: true, primaryWalletId: 'p1' }, candidates: [], editing: true });
	try {
		assert.match(r.text(), /No wallet of yours can serve as primary right now/);
		assert.doesNotMatch(r.text(), /Starting channel/);
	} finally {
		await r.unmount();
	}
});
