import { spawnSync } from 'node:child_process';
import { cp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), desktop = resolve(root, 'apps/desktop');
const require = createRequire(resolve(desktop, 'package.json'));
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!['--web-only', '--desktop-only', '--serial', '--wasm32'].includes(flag)) throw new Error(`Unknown option: ${flag}`);
if (flags.has('--web-only') && flags.has('--desktop-only')) throw new Error('Choose one host or omit both host flags');
if (flags.has('--desktop-only') && (flags.has('--serial') || flags.has('--wasm32'))) throw new Error('Electron ships threaded wasm64; serial/wasm32 gates require Web');
const env = { ...process.env, ORCA_E2E_REAL: '1', ORCA_E2E_VISIBLE: '1', VITE_E2E: '1', VITE_USE_MOCK: '0',
  VITE_SCOPED_CONFIGURATION_GATE: '0', CI: '1',
  ORCA_E2E_PAINTED_FACET_PROJECT: resolve(root, 'packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf') };
function run(name, args, cwd = root) {
  const result = spawnSync(name, args, { cwd, env, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
run(process.execPath, ['packages/slicer-wasm/harness/painted-facet-fixture-smoke.mjs']);
if (!flags.has('--web-only')) {
  run(process.execPath, ['scripts/stage.mjs']);
  for (const pkg of ['@orca/color-sampler-native', '@orca/bambu-native']) run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['--filter', pkg, 'stage:runtime']);
  run(process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite', ['build', '--mode', 'e2e'], desktop);
  await cp(resolve(desktop, 'src/renderer/public'), resolve(desktop, 'out/renderer'), { recursive: true, force: true });
  await verify('apps/desktop/out/renderer', 'threaded', ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']);
  run(process.execPath, [require.resolve('@playwright/test/cli'), 'test', 'e2e/painting.e2e.ts'], desktop);
}
if (!flags.has('--desktop-only')) {
  const webEnv = { ...env, ORCA_WEB_NO_ISOLATION: flags.has('--serial') ? '1' : '0' };
  const config = flags.has('--wasm32') ? 'playwright.instance-isolation-wasm32.config.ts' : 'playwright.config.ts';
  const result = spawnSync(process.execPath, [require.resolve('@playwright/test/cli'), 'test', '--config', '../../apps/web/' + config, 'e2e/instance-isolation.e2e.ts'], { cwd: desktop, env: webEnv, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  const variant = `${flags.has('--wasm32') ? 'wasm32/' : ''}${flags.has('--serial') ? 'serial' : 'threaded'}`;
  await verify('apps/web/dist', variant, ['orca_slice.wasm', 'orca_slice.data']);
}

async function verify(host, variant, files) {
  for (const name of files) {
    const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
    const source = await hash(resolve(root, 'packages/slicer-wasm/out', variant, name));
    if (source !== await hash(resolve(root, host, 'wasm', variant, name))) throw new Error(`Staged ${variant}/${name} differs from current artifact`);
    console.log(`painting ${variant} artifact ${name}: ${source}`);
  }
}
