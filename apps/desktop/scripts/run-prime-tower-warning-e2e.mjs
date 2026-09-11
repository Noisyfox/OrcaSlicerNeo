import { spawnSync } from 'node:child_process';

const command = (name) => process.platform === 'win32' ? `${name}.cmd` : name;
const env = {
  ...process.env,
  ORCA_E2E: '1',
  ORCA_E2E_PRIME_TOWER_WARNINGS: '1',
  // This fixture is enabled only for this focused warning run.  The normal
  // e2e build deliberately has no advisory warnings so unrelated slices prove
  // the default no-warning contract.
  VITE_MOCK_PRIME_TOWER_WARNINGS: '1',
};

for (const [name, args] of [
  ['electron-vite', ['build', '--mode', 'e2e']],
  ['playwright', ['test', 'e2e/prime-tower.e2e.ts', '-g', 'collision and outside']],
]) {
  const result = spawnSync(command(name), args, {
    cwd: process.cwd(), env, stdio: 'inherit', shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
