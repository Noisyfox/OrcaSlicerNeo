// Build Web's private public directory; wasm32 assets never enter Electron's
// shared public directory or its packages, even when both hosts build locally.
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertValidWasm } from './validate-wasm.mjs';

const soft = process.argv.includes('--soft');
const root = new URL('../', import.meta.url);
const staged = spawnSync(process.execPath, [fileURLToPath(new URL('scripts/stage.mjs', root)), ...(soft ? ['--soft'] : [])], { stdio: 'inherit' });
if (staged.error) throw staged.error;
if (staged.status !== 0) process.exit(staged.status ?? 1);
const dst = new URL('apps/web/.generated/public/', root);
await rm(dst, { recursive: true, force: true });
await mkdir(dst, { recursive: true });
await cp(new URL('apps/desktop/src/renderer/public/', root), dst, { recursive: true });
for (const variant of ['threaded', 'serial']) {
  const src = new URL(`packages/slicer-wasm/out/wasm32/${variant}/`, root);
  const files = ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'];
  if (soft && files.some(file => !existsSync(new URL(file, src)))) {
    console.warn(`[stage-web] missing wasm32/${variant}; run node scripts/build-wasm32.mjs build`);
    continue;
  }
  await assertValidWasm(new URL('orca_slice.wasm', src));
  const target = new URL(`wasm/wasm32/${variant}/`, dst);
  await mkdir(target, { recursive: true });
  for (const file of files) await cp(new URL(file, src), new URL(file, target));
  console.log(`[stage-web] staged wasm32/${variant}`);
}
