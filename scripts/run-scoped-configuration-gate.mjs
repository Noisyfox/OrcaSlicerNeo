// Real release WASM; persistent raw reports, including failed and missing cells.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createFixtureCopy, assertFixtureUnchanged, EXPECTED_FIXTURE_PATH, expectedFixtureIdentity } from './real-project-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const desktop = join(root, 'apps/desktop');
const output = resolve(process.env.ORCA_SCOPED_GATE_REPORT_DIR || join(tmpdir(), `orca-scoped-gate-${Date.now()}`));
await mkdir(output, { recursive: true });
console.log(`Persistent gate reports: ${output}`);
const summary = { version: 1, source: EXPECTED_FIXTURE_PATH, sourceIdentity: expectedFixtureIdentity(),
  startedAt: new Date().toISOString(), commands: [], cells: [], sourceUnchanged: false };
const persist = () => writeFile(join(output, 'matrix.json'), JSON.stringify(summary, null, 2));
await assertFixtureUnchanged(EXPECTED_FIXTURE_PATH);
async function run(name, command, args, cwd, env) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', shell: false,
    windowsVerbatimArguments: command === 'cmd.exe', maxBuffer: 64 * 1024 * 1024 });
  const log = join(output, `${summary.commands.length}-${name.replace(/[^a-z0-9-]/gi, '-')}.log`);
  await writeFile(log, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.stack ?? ''}`);
  summary.commands.push({ name, command: [command, ...args], cwd, startedAt, finishedAt: new Date().toISOString(), exitCode: result.status, log });
  await persist();
  console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'} (${log})`);
  return result.status === 0;
}
const pnpm = (name, args, cwd, env) => run(name, 'cmd.exe', ['/d', '/c', 'pnpm', ...args], cwd, env);
const production = { ...process.env, VITE_USE_MOCK: '0', VITE_REAL_PROJECT_PROFILE: '0', NEO_REAL_PROJECT_PROFILE: '0',
  VITE_SCOPED_CONFIGURATION_GATE: '0', VITE_SCOPED_CONFIGURATION_GATE_VARIANT: '' };
try {
  let nativeBuilt = true;
  if (process.env.ORCA_SCOPED_GATE_SKIP_BUILD !== '1') {
    nativeBuilt = await run('dual-release-quick', 'cmd.exe', ['/d', '/c', 'scripts\\build-windows.bat', 'quick'], root, production);
  }
  for (const variant of ['serial', 'threaded']) {
    const build = join(root, `packages/slicer-wasm/.work/${variant}/build`);
    await run(`${variant}-native-history-codec`, 'cmd.exe', ['/d', '/c',
      `call emsdk_env.bat && emmake ninja -C "${build}" history_mesh_capture_test && node "${join(build, 'history_mesh_capture_test.cjs')}"`], root, production);
    await run(`${variant}-native-history-bridge`, process.execPath,
      ['packages/slicer-wasm/harness/history-smoke.mjs', `packages/slicer-wasm/out/${variant}/orca_slice.js`], root, production);
  }
  await pnpm('stage-release-assets', ['stage:assets'], root, production);
  for (const variant of (process.env.ORCA_SCOPED_GATE_VARIANT ? [process.env.ORCA_SCOPED_GATE_VARIANT] : ['serial', 'threaded'])) {
    const env = { ...production, VITE_E2E: '1', ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_VISIBLE: '1',
      VITE_SCOPED_CONFIGURATION_GATE: '1', VITE_SCOPED_CONFIGURATION_GATE_VARIANT: variant };
    const built = await pnpm(`${variant}-renderer`, ['exec', 'electron-vite', 'build'], desktop, env);
    await cp(join(desktop, 'src/renderer/public'), join(desktop, 'out/renderer'), { recursive: true, force: true });
    const artifact = join(root, `packages/slicer-wasm/out/${variant}/orca_slice.wasm`);
    const stagedArtifact = join(desktop, `out/renderer/wasm/${variant}/orca_slice.wasm`);
    const hash = (path) => readFile(path).then(bytes => createHash('sha256').update(bytes).digest('hex'));
    const artifactSha256 = await hash(artifact);
    const buildCache = await readFile(join(root, `packages/slicer-wasm/.work/${variant}/build/CMakeCache.txt`), 'utf8');
    const releaseBuild = buildCache.includes('CMAKE_BUILD_TYPE:STRING=Release') && buildCache.includes('NEO_REAL_PROJECT_PROFILE:BOOL=OFF');
    if (!releaseBuild) throw new Error(`${variant} is not a release, non-profile build`);
    if (artifactSha256 !== await hash(stagedArtifact)) throw new Error(`staged ${variant} artifact mismatch`);
    for (let processIndex = 0; processIndex < Number(process.env.ORCA_SCOPED_GATE_PROCESSES ?? 3); processIndex++) {
      const fixture = await createFixtureCopy();
      const cellDir = join(output, `${variant}-${processIndex}`);
      await mkdir(cellDir, { recursive: true });
      const report = join(cellDir, 'samples.json');
      const cell = { variant, processIndex, artifactSha256, releaseBuild, fixture, report, built: built && nativeBuilt,
        ...(nativeBuilt ? {} : { blocked: 'native source build failed; staged prior artifact is not eligible' }), passed: false };
      summary.cells.push(cell);
      await persist();
      try {
        cell.passed = cell.built && await pnpm(`${variant}-${processIndex}-matrix`, ['exec', 'playwright', 'test', 'e2e/scoped-configuration-gate.e2e.ts'], desktop,
          { ...env, ORCA_REAL_PROJECT_FIXTURE_COPY: fixture.copyPath, ORCA_REAL_PROJECT_FIXTURE_SOURCE: EXPECTED_FIXTURE_PATH,
            ORCA_SCOPED_GATE_PROCESS: String(processIndex), ORCA_SCOPED_GATE_OUTPUT: report });
      } finally { await assertFixtureUnchanged(EXPECTED_FIXTURE_PATH); await persist(); }
    }
  }
  if (process.env.ORCA_SCOPED_GATE_DIAGNOSTIC !== '1') {
    // These jobs share staged assets and therefore run sequentially. A failed
    // job does not hide later required cells.
    await pnpm('repository-tests', ['test'], root, production);
    await pnpm('repository-typecheck', ['typecheck'], root, production);
    await run('dual-smoke', 'cmd.exe', ['/d', '/c', 'scripts\\build-windows.bat', 'smoke'], root, production);
    // The general UI regression suite explicitly owns .env.e2e's mock
    // fixtures. Real release coverage is the six cells above plus the
    // fixture-safe, dual-variant focused suite below; never conflate them.
    await pnpm('electron-ui-regressions-mock', ['--filter', '@orca/desktop', 'test:e2e'], root,
      { ...production, VITE_USE_MOCK: '1', ORCA_E2E_REAL: '0' });
    await run('real-electron-regressions', process.execPath, ['scripts/run-scoped-configuration-real-desktop.mjs'], root,
      { ...production, ORCA_SCOPED_HOST_REPORT_DIR: join(output, 'real-electron') });
    for (const variant of ['threaded', 'serial']) {
      const fixture = await createFixtureCopy();
      await pnpm(`web-${variant}-e2e`, ['--filter', '@orca/web', `test:e2e:${variant}`], root,
        { ...production, ORCA_E2E_PRIME_TOWER_PROJECT: fixture.copyPath });
      await assertFixtureUnchanged(EXPECTED_FIXTURE_PATH);
    }
    await pnpm('scoped-interop-serial', ['--filter', '@orca/slicer-wasm', 'scoped-config-interoperability'], root, production);
    await pnpm('scoped-interop-threaded', ['--filter', '@orca/slicer-wasm', 'scoped-config-interoperability:threaded'], root, production);
    await pnpm('external-orca-required', ['--filter', '@orca/slicer-wasm', 'scoped-config-interoperability', '--require-orca'], root, production);
    await pnpm('restore-production-renderer', ['exec', 'electron-vite', 'build'], desktop, production);
    await cp(join(desktop, 'src/renderer/public'), join(desktop, 'out/renderer'), { recursive: true, force: true });
  }
} finally {
  await assertFixtureUnchanged(EXPECTED_FIXTURE_PATH);
  summary.sourceUnchanged = true;
  summary.finishedAt = new Date().toISOString();
  summary.diagnostic = process.env.ORCA_SCOPED_GATE_DIAGNOSTIC === '1' || Boolean(process.env.ORCA_SCOPED_GATE_PAIRS || process.env.ORCA_SCOPED_GATE_WARMUPS || process.env.ORCA_SCOPED_GATE_PROCESSES || process.env.ORCA_SCOPED_GATE_VARIANT);
  summary.passed = !summary.diagnostic && summary.commands.every(c => c.exitCode === 0) && summary.cells.length === 6 && summary.cells.every(c => c.passed);
  await persist();
}
process.exitCode = summary.passed ? 0 : 1;
