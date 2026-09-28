// Deterministic profile packaging. Upstream's top-level vendor directories
// and matching root JSON files become vendor archives; other root files are core.
// No vendor file list is checked in or maintained by hand.
import { copyFile, mkdir, readdir, readFile, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = resolve(process.env.ORCA_REPO_ROOT ?? fileURLToPath(new URL('../../..', import.meta.url)));
const source = resolve(process.env.ORCA_PROFILES_DIR ?? join(root, 'packages/slicer-wasm/cpp/resources/profiles'));
const output = resolve(process.env.ORCA_PROFILE_OUTPUT ?? join(root, 'packages/profile-resources/dist'));

async function files(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const result = [];
  for (const entry of entries) { const p = join(dir, entry.name); if (entry.isDirectory()) result.push(...await files(p)); else result.push(p); }
  return result;
}
async function zip(dir, target, prefix = '', extraEntries = {}) {
  const entries = {};
  for (const file of await files(dir)) entries[prefix + relative(dir, file).split(sep).join('/')] = new Uint8Array(await readFile(file));
  Object.assign(entries, extraEntries);
  // Max-level deflate (fflate accepts level 0-9) with the earliest
  // DOS-encodable mtime keeps archives deterministic; the runtime reader
  // (fflate) inflates deflated entries.
  const archive = zipSync(entries, { level: 9, mtime: new Date(1980, 0, 1) });
  await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, archive);
}
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const entries = (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const packages = [];
const vendors = entries.filter((e) => e.isDirectory());
const rootFiles = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
const vendorNames = new Set(vendors.map((e) => e.name));
const core = [...rootFiles].filter((name) => !name.endsWith('.json') || !vendorNames.has(name.slice(0, -5)));
if (!core.length && !entries.some((e) => e.isDirectory())) throw new Error(`profile source is empty: ${source}`);
if (core.length) { const staging = await mkdtemp(join(output, '.staging-core-')); for (const f of core) await copyFile(join(source, f), join(staging, f)); const path = 'core.upstream.zip'; await zip(staging, join(output, path)); await rm(staging, { recursive: true, force: true }); packages.push({ id: 'core', kind: 'core', path }); }
for (const vendor of vendors) {
  const vendorFiles = await files(join(source, vendor.name));
  if (!vendorFiles.length) throw new Error(`vendor profile directory is empty: ${vendor.name}`);
  const metadata = `${vendor.name}.json`;
  if (!rootFiles.has(metadata)) throw new Error(`vendor profile metadata is missing: ${metadata}`);
  const metadataBytes = await readFile(join(source, metadata));
  let metadataValue;
  try { metadataValue = JSON.parse(metadataBytes.toString('utf8')); }
  catch { throw new Error(`invalid vendor profile metadata JSON: ${metadata}`); }
  const vendorVersion = metadataValue?.version;
  if (typeof vendorVersion !== 'string' || !/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/.test(vendorVersion)) {
    throw new Error(`invalid vendor profile version in ${metadata}: ${String(vendorVersion)}`);
  }
  const path = `vendors/${vendor.name}.${vendorVersion}.zip`;
  const extraEntries = { [metadata]: new Uint8Array(metadataBytes) };
  await zip(join(source, vendor.name), join(output, path), `${vendor.name}/`, extraEntries);
  packages.push({ id: vendor.name, kind: 'vendor', path });
}
await writeFile(join(output, 'manifest.json'), JSON.stringify({ version: 1, packages }, null, 2) + '\n');
console.log(`profile packages: ${packages.length} from ${source}`);
