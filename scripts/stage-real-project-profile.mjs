import { copyFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidWasm } from './validate-wasm.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'packages/slicer-wasm/out/profile-threaded');
const dst = join(root, 'apps/desktop/src/renderer/public/wasm/profile-threaded');
const files = ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'];

for (const file of files) {
  if (!existsSync(join(src, file)))
    throw new Error(`missing dedicated profile artifact: ${join(src, file)}`);
}
await assertValidWasm(join(src, 'orca_slice.wasm'));
await mkdir(dst, { recursive: true });
for (const file of files) {
  await copyFile(join(src, file), join(dst, file));
  console.log(`staged profile-threaded/${file}`);
}
