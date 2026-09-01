import { spawnSync } from 'node:child_process';

const command = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const env = {
  ...process.env,
  ORCA_E2E_REAL: '1',
};
// The focused real run proves native DRC import through Electron without
// substituting its small fixture into unrelated 20 mm STL regressions.
const args = ['e2e/app.e2e.ts', '-g', 'real DRC flow'];

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
