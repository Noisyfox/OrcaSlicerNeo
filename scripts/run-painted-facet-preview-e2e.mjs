import { spawnSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const desktop = resolve(root, 'apps/desktop');
const fixture = resolve(root, 'packages/slicer-wasm/fixtures/painted-facet/painted-facet-instances.3mf');
const require = createRequire(resolve(desktop, 'package.json'));
const playwrightCli = require.resolve('@playwright/test/cli');
const command = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const env = {
  ...process.env,
  ORCA_E2E_REAL: '1',
  ORCA_E2E_PAINTED_FACET_PROJECT: fixture,
  VITE_E2E: '1',
  VITE_USE_MOCK: '0',
};

function run(name, args, cwd, runEnv = env) {
  const result = spawnSync(name, args, {
    cwd,
    env: runEnv,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, ['packages/slicer-wasm/harness/painted-facet-fixture-smoke.mjs'], root);
// stage.mjs verifies and copies the existing current threaded and serial WASM
// artifacts; Step 4 changes the shared renderer but does not change the bridge.
run(process.execPath, ['scripts/stage.mjs'], root);
run(command('electron-vite'), ['build', '--mode', 'e2e'], desktop);
run(process.execPath, ['scripts/check-renderer-css.mjs'], desktop);
await cp(resolve(desktop, 'src/renderer/public'), resolve(desktop, 'out/renderer'), {
  recursive: true,
  force: true,
});
run(process.execPath, [playwrightCli, 'test', 'e2e/painted-facet-preview.e2e.ts'], desktop);
run(process.execPath, [playwrightCli, 'test', '--config', '../../apps/web/playwright.config.ts',
  '../web/e2e/painted-facet-preview.e2e.ts'], desktop);
