import { spawnSync } from 'node:child_process';
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), desktop = resolve(root, 'apps/desktop');
const require = createRequire(resolve(desktop, 'package.json'));
const env = { ...process.env, ORCA_E2E_REAL: '1', VITE_E2E: '1', VITE_USE_MOCK: '0',
  // Reuse the existing qualification-only variant selector. Production still
  // follows capabilities; this journey proves the current serial artifact.
  VITE_SCOPED_CONFIGURATION_GATE: '1', VITE_SCOPED_CONFIGURATION_GATE_VARIANT: 'serial',
  ORCA_E2E_PAINTED_FACET_PROJECT: resolve(root, 'packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf') };
function run(name, args, cwd = root) {
  const result = spawnSync(name, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ['packages/slicer-wasm/harness/painted-facet-fixture-smoke.mjs']);
run(process.execPath, ['scripts/stage.mjs']);
run(process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite', ['build', '--mode', 'e2e'], desktop);
await cp(resolve(desktop, 'src/renderer/public'), resolve(desktop, 'out/renderer'), { recursive: true, force: true });
for (const name of ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']) {
  const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
  const source = await hash(resolve(root, 'packages/slicer-wasm/out/serial', name));
  if (source !== await hash(resolve(desktop, 'out/renderer/wasm/serial', name))) throw new Error(`Staged ${name} differs from current artifact`);
  console.log(`painting serial artifact ${name}: ${source}`);
}
run(process.execPath, [require.resolve('@playwright/test/cli'), 'test', 'e2e/painting.e2e.ts'], desktop);
