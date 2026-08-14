// scripts/stage-stub-wasm.mjs — temp staging for the packaged-app e2e probe:
// copies the plain-JS stub module (e2e/stub/orca_slice.js) into the renderer
// public dir in place of a real WASM build. Run before package:dir +
// packaged.e2e.ts; the stub is gitignored (public/wasm/) and never ships.
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'apps/desktop/e2e/stub/orca_slice.js');
const dst = join(root, 'apps/desktop/src/renderer/public/wasm/orca_slice.js');
await mkdir(dirname(dst), { recursive: true });
await copyFile(src, dst);
console.log('staged stub module — packaged probe only; run stage:wasm to replace with the real build');
