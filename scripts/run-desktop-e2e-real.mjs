import { spawnSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { assertFixtureUnchanged, createFixtureCopy } from './real-project-fixture.mjs';

const command = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const require = createRequire(resolve(process.cwd(), 'package.json'));
const playwrightCli = require.resolve('@playwright/test/cli');
const fixture = await createFixtureCopy();
const env = {
  ...process.env,
  ORCA_E2E_REAL: '1',
  // apps/desktop/.env enables the mock for ordinary development; override it
  // explicitly so this runner always exercises the staged threaded/serial WASM
  // artifact selected by the Worker.
  VITE_USE_MOCK: '0',
  // Keep the stable semantic viewport hooks in the real acceptance bundle;
  // this is a test-only Vite flag and is never set by production hosts.
  VITE_E2E: '1',
  ORCA_E2E_PRIME_TOWER_PROJECT: fixture.copyPath,
  ORCA_E2E_PREPARE_COLOUR_PROJECT: fixture.copyPath,
};
// The focused real run proves native DRC import through Electron without
// substituting its small fixture into unrelated 20 mm STL regressions.
const testRuns = [
  ['e2e/app.e2e.ts', '-g', 'real DRC flow'],
  ['e2e/app.e2e.ts', '-g', 'real STEP flow'],
  ['e2e/multi-filament.e2e.ts', '-g', 'filament rack remains enabled during history restore'],
  ['e2e/project-load-proof.e2e.ts', '-g', 'commits the requested multi-plate project'],
  ['e2e/plate-switch-performance.e2e.ts', '-g', 'switches several non-current plates within the interactive budget'],
  ['e2e/prepare-colour-project.e2e.ts', '-g', 'imported opaque RGBA slots colour Prepare models like the filament rack'],
  ['e2e/prime-tower-project.e2e.ts', '-g', 'opened project keeps prime-tower UI'],
  ['e2e/prime-tower-history-performance.e2e.ts', '-g', 'measures real-project Prime Tower commit'],
  ['e2e/plate-add-history-profile.e2e.ts', '-g', 'profiles Add Plate click'],
  ['e2e/object-move-history-profile.e2e.ts', '-g', 'profiles a real object move'],
];

for (const [name, childArgs] of [['electron-vite', ['build']]]) {
  const result = spawnSync(command(name), childArgs, {
    cwd: process.cwd(), env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
// electron-vite emits the renderer bundle but this repository's generated
// public assets live under src/renderer/public. Copy the freshly staged WASM
// into the served out/renderer tree so the real test cannot boot stale bytes.
await cp(resolve(process.cwd(), 'src/renderer/public'), resolve(process.cwd(), 'out/renderer'), {
  recursive: true, force: true,
});
for (const args of testRuns) {
  const result = spawnSync(process.execPath, [playwrightCli, 'test', ...args], {
    cwd: process.cwd(), env, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
await assertFixtureUnchanged(fixture.sourcePath);
