// scripts/stage-wasm.mjs — copy the built WASM module into the renderer's
// public dir so the worker can load it. Run after `bash packages/slicer-wasm/build.sh`.
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/slicer-wasm/out');
const dst = join(root, 'apps/desktop/src/renderer/public/wasm');

if (!existsSync(src)) {
  console.error('no WASM build found — run: bash packages/slicer-wasm/build.sh');
  process.exit(1);
}
await mkdir(dst, { recursive: true });
for (const f of ['orca_slice.js', 'orca_slice.wasm']) {
  if (!existsSync(join(src, f))) {
    console.error(`missing ${f} in ${src}`);
    process.exit(1);
  }
  await copyFile(join(src, f), join(dst, f));
  console.log(`staged ${f}`);
}
