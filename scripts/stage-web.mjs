// Build Web's private public directory, adding its serial and wasm32 fallbacks
// without placing them in Electron's public directory or packages.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidWasm } from './validate-wasm.mjs';
import { verifyWasm } from './artifact-version.mjs';

const soft = process.argv.includes('--soft');
const root = new URL('../', import.meta.url);
const staged = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/stage.mjs', root)), ...(soft ? ['--soft'] : [])], { stdio: 'inherit' });
if (staged.error) throw staged.error;
if (staged.status !== 0) process.exit(staged.status ?? 1);
const dst = new URL('apps/web/.generated/public/', root);
await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });
await cp(new URL('apps/desktop/src/renderer/public/', root), dst, { recursive: true });
// Older desktop stages left a single root-level WASM artifact here. Current
// hosts select variant directories, and copying that stale artifact without
// its build metadata breaks Web's loader rewrite. Remove only the generated
// Web copies; leave the source public directory untouched.
for (const file of ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data', 'build-info.json']) {
  await rm(new URL(`wasm/${file}`, dst), { force: true });
}
for (const variant of ['serial', 'wasm32/threaded', 'wasm32/serial']) {
  const src = new URL(`packages/slicer-wasm/out/${variant}/`, root);
  const files = ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data', 'build-info.json'];
  if (soft && files.some(file => !existsSync(new URL(file, src)))) {
    console.warn(`[stage-web] missing ${variant} artifact — skipping`);
    continue;
  }
  await assertValidWasm(new URL('orca_slice.wasm', src));
  await verifyWasm(fileURLToPath(src));
  const target = new URL(`wasm/${variant}/`, dst);
  await mkdir(target, { recursive: true });
  for (const file of files) await cp(new URL(file, src), new URL(file, target));
  await verifyWasm(fileURLToPath(target));
  console.log(`[stage-web] staged ${variant}`);
}
