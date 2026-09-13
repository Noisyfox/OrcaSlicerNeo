import { spawnSync } from 'node:child_process';
import { cp } from 'node:fs/promises';
import { resolve } from 'node:path';

const command = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const projectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
if (!projectPath) {
  throw new Error('ORCA_E2E_PRIME_TOWER_PROJECT must name the exact real 3MF used by acceptance');
}
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
  ORCA_E2E_PRIME_TOWER_PROJECT: projectPath,
};
// The focused real run proves native DRC import through Electron without
// substituting its small fixture into unrelated 20 mm STL regressions.
const testRuns = [
  ['e2e/app.e2e.ts', '-g', 'real DRC flow'],
  ['e2e/app.e2e.ts', '-g', 'real STEP flow'],
  ['e2e/multi-filament.e2e.ts', '-g', 'filament rack remains enabled during history restore'],
  ['e2e/project-load-proof.e2e.ts', '-g', 'commits the requested multi-plate project'],
  ['e2e/prime-tower-project.e2e.ts', '-g', 'opened project keeps prime-tower UI'],
  ['e2e/prime-tower-history-performance.e2e.ts', '-g', 'measures Odyssey Prime Tower commit'],
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
  const result = spawnSync(command('playwright'), ['test', ...args], {
    cwd: process.cwd(), env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
