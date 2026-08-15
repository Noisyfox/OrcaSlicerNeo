// scripts/stage-wasm.mjs — copy the built WASM module into the renderer's
// public dir so the worker can load it. Run after `bash packages/slicer-wasm/build.sh`
// (or `build-windows.bat build`). --soft: warn and exit 0 when the build is
// missing — used by the desktop `predev` hook so mock-mode UI dev
// (VITE_USE_MOCK=1) still boots on a fresh checkout with no wasm build.
import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const soft = process.argv.includes('--soft');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/slicer-wasm/out');
const dst = join(root, 'apps/desktop/src/renderer/public/wasm');

if (!existsSync(src)) {
  if (soft) {
    console.warn('[stage-wasm] no WASM build — skipping (mock-mode / UI-only dev)');
    process.exit(0);
  }
  console.error('no WASM build found — run: bash packages/slicer-wasm/build.sh');
  process.exit(1);
}
await mkdir(dst, { recursive: true });
for (const f of ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']) {
  if (!existsSync(join(src, f))) {
    if (soft) {
      console.warn(`[stage-wasm] missing ${f} in ${src} — skipping (mock-mode / UI-only dev)`);
      process.exit(0);
    }
    console.error(`missing ${f} in ${src}`);
    process.exit(1);
  }
  await copyFile(join(src, f), join(dst, f));
  console.log(`staged ${f}`);
}
