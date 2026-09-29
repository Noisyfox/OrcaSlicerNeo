import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { cpus, totalmem, release, platform, arch } from 'node:os';

const root = resolve(import.meta.dirname, '..');
const desktop = resolve(root, 'apps/desktop');
const require = createRequire(resolve(desktop, 'package.json'));
const outputDir = resolve(root, 'packages/slicer-wasm/.work/painting-benchmark/results');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1];
};
const host = option('--host', 'both');
const ids = option('--cases', 'cube-12,cube-192,cube-3072,cube-3072-4parts,cube-12288,big-project-fixed').split(/[,\s]+/);
const trials = Number(option('--trials', '3'));
if (!['electron', 'web', 'both'].includes(host) || !Number.isInteger(trials) || trials < 1) throw new Error('invalid benchmark options');
const env = { ...process.env, VITE_E2E: '1', VITE_PAINTING_PROFILE: '1', VITE_USE_MOCK: '0', ORCA_E2E_REAL: '1',
  VITE_SCOPED_CONFIGURATION_GATE: '1', VITE_SCOPED_CONFIGURATION_GATE_VARIANT: 'serial', ORCA_WEB_NO_ISOLATION: '1' };
const run = (command, commandArgs, cwd = root, extra = {}) => {
  const result = spawnSync(command, commandArgs, { cwd, env: { ...env, ...extra }, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} failed with ${result.status}`);
};
const pnpm = (commandArgs, cwd = root, extra = {}) => run('cmd.exe', ['/d', '/c', 'pnpm', ...commandArgs], cwd, extra);
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const manifestPath = resolve(root, 'packages/slicer-wasm/.work/painting-benchmark/corpus/manifest.json');
run(process.execPath, ['scripts/painting-benchmark-corpus.mjs']);
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const cases = ids.map((id) => {
  const value = manifest.cases.find((item) => item.id === id);
  if (!value) throw new Error(`unknown case ${id}`);
  return value;
});
for (const value of cases) if (await hash(value.path) !== value.sha256) throw new Error(`corrupt benchmark corpus ${value.id}`);
const nativeCache = await readFile(resolve(root, 'packages/slicer-wasm/.work/serial/build/CMakeCache.txt'), 'utf8');
if (!/^NEO_PAINTING_PROFILE:BOOL=(?:ON|TRUE|1)$/m.test(nativeCache))
  throw new Error('benchmark requires NEO_PAINTING_PROFILE=1 in the serial native build');
const nativeHistoryTest = nativeCache.match(/^NEO_PROJECT_HISTORY_TEST:BOOL=(ON|TRUE|1|OFF|FALSE|0)$/m)?.[1];
if (!nativeHistoryTest) throw new Error('benchmark cannot determine NEO_PROJECT_HISTORY_TEST native build flag');
await mkdir(outputDir, { recursive: true });
run(process.execPath, ['scripts/stage.mjs']);
for (const name of ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']) {
  const source = resolve(root, 'packages/slicer-wasm/out/serial', name);
  const staged = resolve(desktop, 'src/renderer/public/wasm/serial', name);
  if (await hash(source) !== await hash(staged)) throw new Error(`stale staged ${name}`);
}
if (host !== 'web') {
  pnpm(['exec', 'electron-vite', 'build', '--mode', 'e2e'], desktop);
  await cp(resolve(desktop, 'src/renderer/public'), resolve(desktop, 'out/renderer'), { recursive: true, force: true });
}
const hardware = {
  os: { platform: platform(), arch: arch(), release: release() }, cpu: cpus()[0]?.model,
  logicalProcessors: cpus().length, ramBytes: totalmem(),
  node: process.version,
  gitHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  pinnedOrca: spawnSync('git', ['-C', resolve(root, 'packages/slicer-wasm/cpp'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  serialArtifacts: Object.fromEntries(await Promise.all(['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'].map(async (name) => [name, await hash(resolve(root, 'packages/slicer-wasm/out/serial', name))]))),
  configuration: { neoPaintingProfile: true, neoProjectHistoryTest: ['ON', 'TRUE', '1'].includes(nativeHistoryTest),
    wasm: 'serial wasm64', e2e: true, webIsolation: false },
};
const trackedDiff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
if (trackedDiff.status !== 0) throw new Error('could not hash tracked source diff');
const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
if (untracked.status !== 0) throw new Error('could not enumerate untracked source');
hardware.sourceChanges = {
  trackedDiffSha256: createHash('sha256').update(trackedDiff.stdout).digest('hex'),
  untrackedFiles: Object.fromEntries(await Promise.all(untracked.stdout.trim().split(/\r?\n/).filter(Boolean)
    .map(async (path) => [path, await hash(resolve(root, path))]))),
};
const nativeOrcaPath = 'F:\\MyProject\\OrcaSlicer\\build-dbginfo\\src\\RelWithDebInfo\\orca-slicer.exe';
const nativeOrcaStat = statSync(nativeOrcaPath, { throwIfNoEntry: false });
hardware.nativeOrca = {
  path: nativeOrcaPath,
  available: !!nativeOrcaStat,
  mtime: nativeOrcaStat?.mtime.toISOString() ?? null,
  sizeBytes: nativeOrcaStat?.size ?? null,
  checkoutHead: spawnSync('git', ['-C', 'F:\\MyProject\\OrcaSlicer', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() ?? null,
  fileVersion: null,
};
if (nativeOrcaStat) {
  const versionQuery = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `(Get-Item -LiteralPath '${nativeOrcaPath}').VersionInfo.FileVersion`], { encoding: 'utf8' });
  hardware.nativeOrca.fileVersion = versionQuery.status === 0 ? versionQuery.stdout.trim() || null : null;
}
const gpuQuery = spawnSync('powershell.exe', ['-NoProfile', '-Command',
  'Get-CimInstance Win32_VideoController | Select-Object Name,DriverVersion,AdapterRAM | ConvertTo-Json -Compress'], { encoding: 'utf8' });
hardware.gpuControllers = gpuQuery.status === 0 ? JSON.parse(gpuQuery.stdout.trim()) : { error: gpuQuery.stderr.trim() };
const samples = [];
for (const selectedHost of host === 'both' ? ['electron', 'web'] : [host]) for (const value of cases) for (let trial = 1; trial <= trials; trial++) {
  const output = resolve(outputDir, `${selectedHost}-${value.id}-${trial}.json`);
  const extra = { ORCA_PAINTING_BENCHMARK_PROJECT: value.path, ORCA_PAINTING_BENCHMARK_OUTPUT: output,
    ORCA_E2E_MODEL: value.path, ORCA_E2E_PRIME_TOWER_PROJECT: value.path };
  if (selectedHost === 'electron') run(process.execPath,
    [require.resolve('@playwright/test/cli'), 'test', 'e2e/painting-benchmark.e2e.ts'], desktop, extra);
  else pnpm(['--filter', '@orca/desktop', 'exec', 'playwright', 'test', '--config', '../../apps/web/playwright.benchmark.config.ts',
    'painting-benchmark.e2e.ts'], root, extra);
  const report = JSON.parse(await readFile(output, 'utf8'));
  const native = report.beforeClose?.calls?.filter((call) => call.native);
  if (!native?.length) throw new Error(`native painting counters missing in ${output}`);
  samples.push({ host: selectedHost, caseId: value.id, trial, file: output });
  console.log(`[painting-benchmark] ${selectedHost} ${value.id} trial ${trial}: ${output}`);
}
const index = { schemaVersion: 1, generatedAt: new Date().toISOString(), hardware, corpus: manifest, samples };
await writeFile(resolve(outputDir, 'index.json'), JSON.stringify(index, null, 2));
run(process.execPath, ['scripts/summarize-painting-benchmark.mjs', resolve(outputDir, 'index.json')]);
console.log(`[painting-benchmark] ${samples.length} samples: ${resolve(outputDir, 'index.json')}`);
