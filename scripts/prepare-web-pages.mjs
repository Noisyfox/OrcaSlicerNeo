// Keep the Pages artifact limited to production assets. Vite copies the
// Web host's staged public directory, which can contain local debug WASM files.
import { readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(process.argv[2] ?? fileURLToPath(new URL('../apps/web/dist', import.meta.url)));
const wasmRoot = join(dist, 'wasm');
// Pages cannot supply COOP/COEP headers, so neither threaded build is usable.
const variants = ['serial', 'wasm32/serial'];
const runtimeFiles = new Set(['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']);
const productionFiles = new Set(variants.flatMap(variant => [...runtimeFiles].map(file => `${variant}/${file}`)));

for (const variant of variants) {
  const directory = join(wasmRoot, variant);
  for (const file of runtimeFiles) {
    const entry = await stat(join(directory, file));
    if (!entry.isFile() || entry.size === 0 && file !== 'orca_slice.data') {
      throw new Error(`missing production WASM asset: ${variant}/${file}`);
    }
  }
}
await stat(join(dist, 'index.html'));
await stat(join(dist, 'profiles', 'manifest.json'));

async function pruneWasm(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    const path = join(directory, entry.name);
    if (entry.isDirectory() && [...productionFiles].some(file => file.startsWith(`${relative}/`))) {
      await pruneWasm(path, `${relative}/`);
    } else if (!entry.isFile() || !productionFiles.has(relative)) {
      await rm(path, { recursive: true, force: true });
    }
  }
}
await pruneWasm(wasmRoot);

await writeFile(join(dist, '.nojekyll'), '');

async function sizeOf(path) {
  const entry = await stat(path);
  if (entry.isFile()) return entry.size;
  let bytes = 0;
  for (const child of await readdir(path)) bytes += await sizeOf(join(path, child));
  return bytes;
}

const bytes = await sizeOf(dist);
const limit = 1_000_000_000;
if (bytes > limit) throw new Error(`GitHub Pages artifact exceeds 1 GB: ${bytes} bytes`);
console.log(`GitHub Pages artifact ready: ${bytes} bytes`);
