// Deterministic profile packaging. Upstream's top-level vendor directories
// become vendor archives; files directly under resources/profiles are core.
// No vendor file list is checked in or maintained by hand.
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.env.ORCA_REPO_ROOT ?? fileURLToPath(new URL('../../..', import.meta.url)));
const source = resolve(process.env.ORCA_PROFILES_DIR ?? join(root, 'packages/slicer-wasm/cpp/resources/profiles'));
const output = resolve(process.env.ORCA_PROFILE_OUTPUT ?? join(root, 'apps/desktop/public/profiles'));
const version = process.env.ORCA_PROFILE_VERSION ?? 'upstream';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
async function files(dir) {
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const result = [];
  for (const entry of entries) { const p = join(dir, entry.name); if (entry.isDirectory()) result.push(...await files(p)); else result.push(p); }
  return result;
}
async function zip(dir, target) {
  const chunks = []; const central = []; let offset = 0;
  for (const file of await files(dir)) {
    const name = relative(dir, file).split(sep).join('/'); const data = await readFile(file); const nameBytes = Buffer.from(name);
    const local = Buffer.concat([u32(0x04034b50), u16(10), u16(0), u16(0), u16(0), u16(0), u32(crc32(data)), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data]);
    chunks.push(local); central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(10), u16(0), u16(0), u16(0), u16(0), u32(crc32(data)), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes])); offset += local.length;
  }
  const body = Buffer.concat([...chunks, ...central, u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(Buffer.concat(central).length), u32(offset), u16(0)]);
  await mkdir(resolve(target, '..'), { recursive: true }); await (await import('node:fs/promises')).writeFile(target, body);
}
const entries = (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
const packages = [];
const core = entries.filter((e) => e.isFile()).map((e) => e.name);
if (core.length) { const staging = join(output, '.staging-core'); await mkdir(staging, { recursive: true }); for (const f of core) await (await import('node:fs/promises')).copyFile(join(source, f), join(staging, f)); const path = `core.${version}.zip`; await zip(staging, join(output, path)); packages.push({ id: 'core', kind: 'core', path }); }
for (const vendor of entries.filter((e) => e.isDirectory())) { const path = `vendors/${vendor.name}.${version}.zip`; await zip(join(source, vendor.name), join(output, path)); packages.push({ id: vendor.name, kind: 'vendor', path }); }
await (await import('node:fs/promises')).writeFile(join(output, 'manifest.json'), JSON.stringify({ version: 1, packages }, null, 2) + '\n');
console.log(`profile packages: ${packages.length} from ${source}`);
