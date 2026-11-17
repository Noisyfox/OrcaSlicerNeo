// Build and run the native Measure suites in an already configured WASM tree.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
let variant = 'serial', width = 64, jobs = 4;
for (let i = 0; i < args.length; ++i) {
  if (args[i] === '--help') {
    console.log('node scripts/run-measure-native-tests.mjs [--variant serial|threaded] [--wasm32] [--jobs N]');
    process.exit(0);
  } else if (args[i] === '--variant') variant = args[++i];
  else if (args[i] === '--wasm32') width = 32;
  else if (args[i] === '--jobs') jobs = Number(args[++i]);
  else throw new Error(`Unknown option: ${args[i]}`);
}
if (!['serial', 'threaded'].includes(variant) || !Number.isSafeInteger(jobs) || jobs < 1)
  throw new Error('Expected --variant serial|threaded and a positive --jobs value');

const pkg = resolve(root, 'packages/slicer-wasm');
const build = resolve(pkg, width === 32 ? `.work/wasm32/${variant}/build` : `.work/${variant}/build`);
const source = resolve(pkg, width === 32 ? '.work/wasm32/scaffold/packages/slicer-wasm' : '.');
const cache = readFileSync(resolve(build, 'CMakeCache.txt'), 'utf8');
const previous = /^NEO_MEASURE_TEST:BOOL=(ON|OFF)$/m.exec(cache)?.[1] ?? 'OFF';
const targets = ['measure_geometry_test', 'measure_session_test', 'measure_service_test'];
function run(program, params) {
  console.log(`\n> ${program} ${params.join(' ')}`);
  const result = spawnSync(program, params, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${program} exited ${result.status ?? result.signal}`);
}
let configured = false;
try {
  run('cmake', ['-S', source, '-B', build, '-DNEO_MEASURE_TEST=ON']);
  configured = true;
  run('cmake', ['--build', build, '--parallel', String(jobs), '--target', ...targets]);
  for (const target of targets) run(process.execPath, [resolve(build, `${target}.cjs`)]);
} finally {
  if (configured && previous !== 'ON') run('cmake', ['-S', source, '-B', build, `-DNEO_MEASURE_TEST=${previous}`]);
}
