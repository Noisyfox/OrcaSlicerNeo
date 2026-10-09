import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = !process.argv.includes('--production');
const variant = profile ? 'profile-threaded' : 'threaded';
const env = { ...process.env };
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`);
}
if (process.argv.includes('--build')) {
  if (!profile || process.platform !== 'win32') throw new Error('--build uses the Windows dedicated profiling build');
  const found = spawnSync('where.exe', ['emsdk_env.bat'], { encoding: 'utf8' });
  const sdk = env.EMSDK ? join(env.EMSDK, 'emsdk_env.bat') : found.stdout?.split(/\r?\n/).find(Boolean)?.trim();
  if (!sdk || !existsSync(sdk)) throw new Error('set EMSDK or put emsdk_env.bat on PATH');
  Object.assign(env, { NEO_REAL_PROJECT_PROFILE: '1', WASM_THREADING: '1', WASM_ARTIFACT_VARIANT: variant,
    WASM_OUT_DIR: join(root, 'packages/slicer-wasm/out', variant), JOBS: env.JOBS || '4',
    DRACO_INCLUDE: join(root, 'packages/slicer-wasm/.work/deps/draco-1.5.7/stage-wasm64-threaded/include'),
    DRACO_ARCHIVE: join(root, 'packages/slicer-wasm/.work/deps/draco-1.5.7/stage-wasm64-threaded/lib/libdraco.a'),
    NLOPT_ROOT: join(root, 'packages/slicer-wasm/.work/deps/nlopt-2.5.0/stage-wasm64-threaded'),
    OCCT_ROOT: join(root, 'packages/slicer-wasm/.work/deps/occt-7.6.0/stage-wasm64-threaded') });
  run('cmd.exe', ['/d', '/c', `call "${sdk}" && call packages\\slicer-wasm\\build.bat`]);
}
env.ORCA_SETUP_PROFILE_MODULE = join(root, 'packages/slicer-wasm/out', variant, 'orca_slice.js');
env.ORCA_SETUP_PROFILE_MEMORY = profile ? '1' : '0';
env.ORCA_SETUP_PROFILE_OUTPUT = join(root, 'packages/slicer-wasm/.work', `setup-wizard-${variant}-measurement.json`);
if (!existsSync(env.ORCA_SETUP_PROFILE_MODULE)) throw new Error(`missing ${env.ORCA_SETUP_PROFILE_MODULE}`);
// The current pnpm launcher supplies its portable JS entry point; avoid Windows .cmd spawning.
const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['pnpm'], { encoding: 'utf8' });
const launcher = lookup.stdout?.split(/\r?\n/).find(path => path.trim().endsWith('pnpm'))?.trim();
const pnpm = env.npm_execpath || (launcher && join(dirname(launcher), 'pnpm.cjs'));
if (pnpm && existsSync(pnpm)) run(process.execPath, [pnpm, '--filter', '@orca/slicer-runtime', 'exec', 'vitest', 'run', 'src/setupWizardPerformance.test.ts']);
else if (process.platform === 'win32') run('cmd.exe', ['/d', '/c', 'pnpm --filter @orca/slicer-runtime exec vitest run src/setupWizardPerformance.test.ts']);
else run('pnpm', ['--filter', '@orca/slicer-runtime', 'exec', 'vitest', 'run', 'src/setupWizardPerformance.test.ts']);
