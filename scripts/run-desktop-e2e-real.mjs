import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const command = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const env = {
  ...process.env,
  ORCA_E2E_REAL: '1',
  // The real desktop regression is the host-level DRC check.  The ordinary
  // Electron e2e suite remains mock-backed for fast UI coverage.
  ORCA_E2E_MODEL: resolve('packages/slicer-wasm/fixtures/drc/test_nm.obj.edgebreaker.cl4.2.2.drc'),
};
const args = ['e2e/app.e2e.ts', 'e2e/slice-error.e2e.ts', 'e2e/select-scroll.e2e.ts'];

for (const [name, childArgs] of [
  ['electron-vite', ['build']],
  ['playwright', ['test', ...args]],
]) {
  const result = spawnSync(command(name), childArgs, {
    cwd: process.cwd(), env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
