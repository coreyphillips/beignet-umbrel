/**
 * A module loader that teaches node the two Vite-isms this app is written in.
 *
 * `resolve` adds the `.jsx` extension node will not guess at, so
 * `'../../components/ui.jsx'` works unchanged and a bare `'./Toast'` would too.
 *
 * `load` runs JSX through esbuild, which is the same transform Vite uses, and
 * substitutes `import.meta.env` for the object Vite injects at build time. Only
 * VITE_DEMO is read anywhere, and a test wants it off.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';

const VITE_ENV = JSON.stringify({ MODE: 'test', DEV: false, PROD: false, VITE_DEMO: '0' });

export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (err) {
		// Only relative specifiers get a second guess. A bare one that cannot be
		// found is a missing dependency, and hiding that would be worse.
		if (!specifier.startsWith('.')) throw err;
		return next(`${specifier}.jsx`, context);
	}
}

export async function load(url, context, next) {
	if (!url.endsWith('.jsx') && !url.endsWith('.js')) return next(url, context);
	if (url.includes('/node_modules/')) return next(url, context);
	const path = fileURLToPath(url);
	const source = await readFile(path, 'utf8');
	if (!url.endsWith('.jsx') && !source.includes('import.meta.env')) return next(url, context);
	const { code } = await transform(source, {
		loader: url.endsWith('.jsx') ? 'jsx' : 'js',
		jsx: 'automatic',
		format: 'esm',
		sourcefile: path,
		define: { 'import.meta.env': VITE_ENV }
	});
	return { format: 'module', shortCircuit: true, source: code };
}

export { pathToFileURL };
