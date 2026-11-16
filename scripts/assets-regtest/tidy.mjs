// Stop the regtest wallets earlier runs left running. Every scenario makes
// its own wallets and leaves them up to be looked at, and each one holds a
// connection to the stack's Electrum server. Past a few dozen, that server
// stops answering after the reorganisation in 07-reorg.mjs. Nothing is
// deleted: a stopped wallet keeps its data and starts again from the
// dashboard. `node tidy.mjs --delete` removes them and their data instead.
import { api, log } from './lib.mjs';

const remove = process.argv.includes('--delete');
const wallets = (await api('/wallets')).filter((w) => w.network === 'regtest');
let n = 0;
for (const w of wallets) {
	try {
		if (remove) await api(`/wallets/${w.id}?purge=true`, { method: 'DELETE' });
		else if (w.status === 'running' || w.status === 'starting') await api(`/wallets/${w.id}/stop`, { method: 'POST', body: {} });
		else continue;
		n += 1;
	} catch (e) {
		log(`  ${w.name} (${w.id.slice(0, 8)}): ${e.message}`);
	}
}
log(`${remove ? 'deleted' : 'stopped'} ${n} of ${wallets.length} regtest wallets`);
