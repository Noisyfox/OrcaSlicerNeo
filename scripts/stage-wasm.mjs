// scripts/stage-wasm.mjs — copy the built WASM module into the renderer's
// public dir so the worker can load it. Run after `bash packages/slicer-wasm/build.sh`
// (or `build-windows.bat build`). Also copies the profile packages from
// packages/profile-resources/dist, which must be built first:
//   pnpm --filter @orca/profile-resources build
// --soft: warn and exit 0 when the build is missing — used by the desktop `predev`
// hook so mock-mode UI dev (VITE_USE_MOCK=1) still boots on a fresh checkout
// with no wasm build.
import { copyFile, cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidWasm } from './validate-wasm.mjs';

const soft = process.argv.includes('--soft');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(root, 'packages/slicer-wasm/out');
const dstRoot = join(root, 'apps/desktop/src/renderer/public/wasm');
const profileSrc = join(root, 'packages/profile-resources/dist');
const profileDst = join(root, 'apps/desktop/src/renderer/public/profiles');

if (!existsSync(outRoot)) {
  if (soft) {
    console.warn('[stage-wasm] no WASM build — skipping (mock-mode / UI-only dev)');
    process.exit(0);
  }
  console.error('no WASM build found — run: bash packages/slicer-wasm/build.sh');
  process.exit(1);
}
if (existsSync(profileSrc)) {
  await cp(profileSrc, profileDst, { recursive: true, force: true });
} else if (soft) {
  console.warn('[stage-wasm] no profile packages — skipping (build with: pnpm --filter @orca/profile-resources build)');
} else {
  console.error('no profile packages in packages/profile-resources/dist — run: pnpm --filter @orca/profile-resources build');
  process.exit(1);
}
for (const variant of ['threaded', 'serial']) {
  const src = join(outRoot, variant);
  const dst = join(dstRoot, variant);
  if (!existsSync(src)) {
    if (soft) { console.warn(`[stage-wasm] missing ${variant} artifact directory — skipping`); continue; }
    console.error(`missing ${variant} artifact directory in ${outRoot}`);
    process.exit(1);
  }
  const files = ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'];
  let complete = true;
  for (const f of files) {
    if (!existsSync(join(src, f))) {
      if (soft) {
        console.warn(`[stage-wasm] missing ${variant}/${f} — skipping (mock-mode / UI-only dev)`);
        complete = false;
        break;
      }
      console.error(`missing ${variant}/${f} in ${src}`);
      process.exit(1);
    }
  }
  if (!complete) continue;
  try {
    await assertValidWasm(join(src, 'orca_slice.wasm'));
  } catch (error) {
    const message = `[stage-wasm] ${error instanceof Error ? error.message : String(error)} — refusing to stage a module that browsers cannot instantiate`;
    if (soft) {
      console.warn(message);
      continue;
    }
    console.error(message);
    process.exit(1);
  }
  await mkdir(dst, { recursive: true });
  for (const f of files) {
    await copyFile(join(src, f), join(dst, f));
    console.log(`staged ${variant}/${f}`);
  }
}
