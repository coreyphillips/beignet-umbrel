'use strict';

const state = { config: null, wallets: [], pollTimer: null };

async function api(method, path, body) {
	const res = await fetch(`/api${path}`, {
		method,
		headers: body ? { 'Content-Type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok || data.ok === false) {
		const message = (data.error && data.error.message) || `Request failed (${res.status})`;
		throw new Error(message);
	}
	return data.result;
}

function el(tag, attrs = {}, children = []) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (key === 'class') node.className = value;
		else if (key === 'html') node.innerHTML = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value);
	}
	for (const child of [].concat(children)) {
		if (child == null) continue;
		node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
	}
	return node;
}

function toast(message, isError) {
	const node = el('div', { class: `toast${isError ? ' error' : ''}` }, message);
	document.body.appendChild(node);
	requestAnimationFrame(() => node.classList.add('show'));
	setTimeout(() => {
		node.classList.remove('show');
		setTimeout(() => node.remove(), 250);
	}, 3200);
}

function openModal(title, bodyNode) {
	document.getElementById('modal-title').textContent = title;
	const body = document.getElementById('modal-body');
	body.innerHTML = '';
	body.appendChild(bodyNode);
	document.getElementById('modal').classList.remove('hidden');
}

function closeModal() {
	document.getElementById('modal').classList.add('hidden');
}

// --- Electrum override block (shared by create & import forms) ---
function buildElectrumBlock(container) {
	const def = state.config.defaultElectrum;
	const hasDefault = def && def.host;
	const fields = el('div', { class: 'electrum-fields' }, [
		el('label', {}, ['Host', el('input', { name: 'electrumHost', placeholder: 'electrum.example.com' })]),
		el('label', {}, ['Port', el('input', { name: 'electrumPort', value: String(def.port || 50001) })]),
		el('label', { class: 'checkbox' }, [el('input', { type: 'checkbox', name: 'electrumTls' }), 'Use TLS'])
	]);
	const toggle = el('label', { class: 'electrum-toggle' }, [
		el('input', {
			type: 'checkbox',
			name: 'customElectrum',
			onchange: (e) => fields.classList.toggle('show', e.target.checked)
		}),
		'Use a custom Electrum server'
	]);
	container.appendChild(toggle);
	const note = hasDefault
		? `Default: ${def.host}:${def.port} (Umbrel Electrum, TLS ${def.tls ? 'on' : 'off'})`
		: 'No default Electrum server detected. A custom server is required.';
	container.appendChild(el('div', { class: 'electrum-default' }, note));
	container.appendChild(fields);
	if (!hasDefault) {
		toggle.querySelector('input').checked = true;
		fields.classList.add('show');
	}
}

function readElectrum(form) {
	if (!form.customElectrum || !form.customElectrum.checked) return undefined;
	return {
		host: form.electrumHost.value.trim(),
		port: parseInt(form.electrumPort.value, 10),
		tls: form.electrumTls.checked
	};
}

function fillNetworks() {
	for (const select of document.querySelectorAll('select.network')) {
		select.innerHTML = '';
		for (const net of state.config.supportedNetworks) {
			const opt = el('option', { value: net }, net);
			if (net === state.config.defaultNetwork) opt.selected = true;
			select.appendChild(opt);
		}
	}
}

// --- Wallet list rendering ---
function statusBadge(w) {
	const cls = w.status === 'running' ? 'running' : w.status;
	return el('span', { class: `badge ${cls}` }, [el('span', { class: 'dot' }), w.status]);
}

function walletCard(w) {
	const meta = `${w.network} · port ${w.port} · electrum ${w.electrum.host}:${w.electrum.port}`;
	const actions = el('div', { class: 'wallet-actions' });

	if (w.status === 'running' || w.status === 'starting' || w.status === 'restarting') {
		actions.appendChild(
			el('button', { class: 'ghost', onclick: () => act(w.id, 'stop') }, 'Stop')
		);
		actions.appendChild(
			el('button', { class: 'ghost', onclick: () => window.open(`swagger.html?id=${w.id}`, '_blank') }, 'API explorer')
		);
	} else {
		actions.appendChild(
			el('button', { class: 'ghost', onclick: () => act(w.id, 'start') }, 'Start')
		);
	}
	actions.appendChild(el('button', { class: 'ghost', onclick: () => showLogs(w.id) }, 'Logs'));
	actions.appendChild(el('button', { class: 'ghost', onclick: () => confirmDelete(w) }, 'Delete'));

	return el('div', { class: 'wallet' }, [
		el('div', { class: 'wallet-main' }, [
			el('div', { class: 'wallet-name' }, w.name),
			el('div', { class: 'wallet-meta' }, meta)
		]),
		el('div', { class: 'wallet-actions' }, [statusBadge(w), actions])
	]);
}

function renderWallets() {
	const container = document.getElementById('wallets');
	container.innerHTML = '';
	if (!state.wallets.length) {
		container.appendChild(el('div', { class: 'empty' }, 'No wallets yet. Create or import one above.'));
		return;
	}
	for (const w of state.wallets) container.appendChild(walletCard(w));
}

async function refresh() {
	try {
		state.wallets = await api('GET', '/wallets');
		renderWallets();
	} catch (err) {
		toast(err.message, true);
	}
}

async function act(id, action) {
	try {
		await api('POST', `/wallets/${id}/${action}`);
		await refresh();
	} catch (err) {
		toast(err.message, true);
	}
}

async function showLogs(id) {
	try {
		const logs = await api('GET', `/wallets/${id}/logs`);
		openModal('Wallet logs', el('div', { class: 'logs' }, logs.join('\n') || 'No logs yet.'));
	} catch (err) {
		toast(err.message, true);
	}
}

function confirmDelete(w) {
	const body = el('div', {}, [
		el('div', { class: 'seed-warning' },
			'Deleting removes this wallet from Beignet. If you also erase its data and you have not backed up the seed phrase, any funds will be lost permanently.'),
		el('label', { class: 'checkbox' }, [
			el('input', { type: 'checkbox', id: 'purge-check' }),
			'Also erase wallet data (seed, database) from disk'
		]),
		el('div', { style: 'margin-top:16px; display:flex; gap:8px;' }, [
			el('button', { class: 'primary', style: 'background:var(--red); color:#fff;', onclick: async () => {
				const purge = document.getElementById('purge-check').checked;
				try {
					await api('DELETE', `/wallets/${w.id}${purge ? '?purge=true' : ''}`);
					closeModal();
					toast('Wallet deleted');
					await refresh();
				} catch (err) {
					toast(err.message, true);
				}
			} }, 'Delete wallet'),
			el('button', { class: 'ghost', onclick: closeModal }, 'Cancel')
		])
	]);
	openModal(`Delete "${w.name}"`, body);
}

function showSeed(mnemonic, name) {
	const words = mnemonic.split(' ');
	const grid = el('div', { class: 'seed-grid' },
		words.map((word, i) => el('div', { class: 'seed-word' }, [el('span', {}, String(i + 1)), word]))
	);
	const body = el('div', {}, [
		el('div', { class: 'seed-warning' },
			'Write down these words in order and keep them somewhere safe and offline. Anyone with this phrase can spend your funds. Beignet stores it on your Umbrel, but this is the only time it is shown to you here.'),
		grid,
		el('div', { style: 'display:flex; gap:8px;' }, [
			el('button', { class: 'ghost', onclick: async () => {
				try { await navigator.clipboard.writeText(mnemonic); toast('Seed copied'); } catch (_) { toast('Copy failed', true); }
			} }, 'Copy phrase'),
			el('button', { class: 'primary', onclick: closeModal }, 'I have saved it')
		])
	]);
	openModal(`Backup seed for "${name}"`, body);
}

// --- Form handlers ---
function setupForms() {
	document.querySelectorAll('.tab').forEach((tab) => {
		tab.addEventListener('click', () => {
			document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
			document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
			tab.classList.add('active');
			document.getElementById(`${tab.dataset.tab}-form`).classList.add('active');
		});
	});

	buildElectrumBlock(document.querySelector('.electrum-block[data-for="create"]'));
	buildElectrumBlock(document.querySelector('.electrum-block[data-for="import"]'));

	const createForm = document.getElementById('create-form');
	createForm.addEventListener('submit', async (e) => {
		e.preventDefault();
		const btn = createForm.querySelector('button[type=submit]');
		btn.disabled = true;
		try {
			const result = await api('POST', '/wallets', {
				name: createForm.name.value,
				network: createForm.network.value,
				wordCount: parseInt(createForm.wordCount.value, 10),
				electrum: readElectrum(createForm)
			});
			createForm.reset();
			document.querySelectorAll('.electrum-fields').forEach((f) => f.classList.remove('show'));
			await refresh();
			showSeed(result.mnemonic, result.record.name);
		} catch (err) {
			toast(err.message, true);
		} finally {
			btn.disabled = false;
		}
	});

	const importForm = document.getElementById('import-form');
	importForm.addEventListener('submit', async (e) => {
		e.preventDefault();
		const btn = importForm.querySelector('button[type=submit]');
		btn.disabled = true;
		try {
			await api('POST', '/wallets/import', {
				name: importForm.name.value,
				network: importForm.network.value,
				mnemonic: importForm.mnemonic.value,
				electrum: readElectrum(importForm)
			});
			importForm.reset();
			document.querySelectorAll('.electrum-fields').forEach((f) => f.classList.remove('show'));
			toast('Wallet imported. It will sync in the background.');
			await refresh();
		} catch (err) {
			toast(err.message, true);
		} finally {
			btn.disabled = false;
		}
	});

	document.getElementById('refresh').addEventListener('click', refresh);
	document.getElementById('modal-close').addEventListener('click', closeModal);
	document.getElementById('modal').addEventListener('click', (e) => {
		if (e.target.id === 'modal') closeModal();
	});
}

async function boot() {
	try {
		state.config = await api('GET', '/config');
	} catch (err) {
		toast(`Failed to load config: ${err.message}`, true);
		return;
	}
	const def = state.config.defaultElectrum;
	document.getElementById('env').textContent =
		`Network: ${state.config.defaultNetwork}` +
		(def && def.host ? ` · Electrum: ${def.host}:${def.port}` : ' · Electrum: not set');
	fillNetworks();
	setupForms();
	await refresh();
	state.pollTimer = setInterval(refresh, 3000);
}

boot();
