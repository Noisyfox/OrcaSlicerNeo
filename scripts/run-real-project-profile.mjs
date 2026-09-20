import { spawnSync } from 'node:child_process';
import { cp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXPECTED_FIXTURE_PATH,
  assertFixtureUnchanged,
  createFixtureCopy,
} from './real-project-fixture.mjs';

if (process.platform !== 'win32')
  throw new Error('the licensed Odyssey acceptance fixture and visible Electron profile are Windows-only');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const exactFixture = EXPECTED_FIXTURE_PATH;
const configuredSource = process.env.ORCA_REAL_PROJECT_FIXTURE_SOURCE?.trim() ||
  process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
if (configuredSource && resolve(configuredSource).toLowerCase() !== exactFixture.toLowerCase())
  throw new Error(`ORCA_REAL_PROJECT_FIXTURE_SOURCE must name the exact u1 fixture: ${exactFixture}`);
if (!existsSync(exactFixture))
  throw new Error(`the exact u1 fixture is missing: ${exactFixture}`);

const emsdkLookup = spawnSync('where.exe', ['emsdk_env.bat'], { encoding: 'utf8', shell: false });
const emsdkEnv = process.env.EMSDK
  ? join(process.env.EMSDK, 'emsdk_env.bat')
  : emsdkLookup.stdout?.split(/\r?\n/).find(Boolean)?.trim();
if (!emsdkEnv || !existsSync(emsdkEnv))
  throw new Error('emsdk_env.bat is required for the dedicated WASM profile build');

const stagedFixture = await createFixtureCopy({ source: exactFixture });
const fixture = stagedFixture.copyPath;
const profileOutput = join(stagedFixture.root, 'real-project-profile.json');

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function requireRun(command, args, cwd, env) {
  const status = run(command, args, cwd, env);
  if (status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${status}`);
}

function runPnpm(args, cwd, env) {
  return run('cmd.exe', ['/d', '/c', 'pnpm', ...args], cwd, env);
}

function requirePnpm(args, cwd, env) {
  const status = runPnpm(args, cwd, env);
  if (status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with ${status}`);
}

async function readProfileOutput() {
  if (!existsSync(profileOutput))
    throw new Error(`real-project profile did not emit its baseline output: ${profileOutput}`);
  const report = JSON.parse(await readFile(profileOutput, 'utf8'));
  const reportCopy = resolve(report.fixture?.copyPath || '');
  if (reportCopy.toLowerCase() !== fixture.toLowerCase())
    throw new Error(`real-project profile report used an unexpected copy: ${reportCopy}`);
  const reportSource = resolve(report.fixture?.sourcePath || '');
  if (reportSource.toLowerCase() !== exactFixture.toLowerCase())
    throw new Error(`real-project profile report used an unexpected source: ${reportSource}`);
  if (!Array.isArray(report.samples) || report.samples.length === 0)
    throw new Error('real-project profile report contains no raw samples');
  console.log('[real-project-profile-baseline]', JSON.stringify({
    output: profileOutput,
    fixture: report.fixture,
    sampleCount: report.samples.length,
    samples: report.samples,
  }));
  return report;
}

const profileEnv = {
  ...process.env,
  NEO_REAL_PROJECT_PROFILE: '1',
  WASM_THREADING: '1',
  WASM_ARTIFACT_VARIANT: 'profile-threaded',
  WASM_OUT_DIR: join(root, 'packages/slicer-wasm/out/profile-threaded'),
  DRACO_INCLUDE: join(root, 'packages/slicer-wasm/.work/deps/draco-1.5.7/stage-wasm64-threaded/include'),
  DRACO_ARCHIVE: join(root, 'packages/slicer-wasm/.work/deps/draco-1.5.7/stage-wasm64-threaded/lib/libdraco.a'),
  OCCT_ROOT: join(root, 'packages/slicer-wasm/.work/deps/occt-7.6.0/stage-wasm64-threaded'),
  ORCA_E2E: '1',
  ORCA_E2E_REAL: '1',
  ORCA_E2E_VISIBLE: '1',
  ORCA_E2E_PRIME_TOWER_PROJECT: fixture,
  ORCA_E2E_MODEL: fixture,
  ORCA_REAL_PROJECT_FIXTURE_SOURCE: exactFixture,
  ORCA_REAL_PROJECT_FIXTURE_COPY: fixture,
  ORCA_REAL_PROJECT_FIXTURE_SOURCE_BYTES: String(stagedFixture.sourceIdentity.bytes),
  ORCA_REAL_PROJECT_FIXTURE_SOURCE_SHA256: stagedFixture.sourceIdentity.sha256,
  ORCA_REAL_PROJECT_PROFILE_OUTPUT: profileOutput,
  VITE_USE_MOCK: '0',
  VITE_E2E: '1',
  VITE_REAL_PROJECT_PROFILE: '1',
};

let testStatus = 1;
let primaryError;
try {
  requireRun('cmd.exe', ['/d', '/c', `call ${emsdkEnv} && call packages\\slicer-wasm\\build.bat`], root, profileEnv);
  requirePnpm(['stage:assets'], root, profileEnv);
  requireRun(process.execPath, [join(root, 'scripts/stage-real-project-profile.mjs')], root, profileEnv);
  requirePnpm(['exec', 'electron-vite', 'build'], desktop, profileEnv);
  await cp(join(desktop, 'src/renderer/public'), join(desktop, 'out/renderer'), { recursive: true, force: true });
  requireRun(process.execPath, [join(root, 'scripts/verify-real-project-profile-exclusion.mjs'), '--enabled'], root, profileEnv);
  testStatus = runPnpm(['exec', 'playwright', 'test',
    'e2e/real-project-interaction-profile.e2e.ts'], desktop, profileEnv);
  if (testStatus === 0) await readProfileOutput();
} catch (error) {
  primaryError = error;
} finally {
  const productionEnv = { ...process.env, VITE_USE_MOCK: '0' };
  delete productionEnv.VITE_E2E;
  delete productionEnv.VITE_REAL_PROJECT_PROFILE;
  delete productionEnv.NEO_REAL_PROJECT_PROFILE;
  try {
    requireRun('cmd.exe', ['/d', '/s', '/c', 'scripts\\build-windows.bat quick --variant threaded'], root, productionEnv);
    requirePnpm(['stage:assets'], root, productionEnv);
    requirePnpm(['exec', 'electron-vite', 'build'], desktop, productionEnv);
    await cp(join(desktop, 'src/renderer/public'), join(desktop, 'out/renderer'), { recursive: true, force: true });
    requireRun(process.execPath, [join(root, 'scripts/verify-real-project-profile-exclusion.mjs')], root, productionEnv);
  } catch (cleanupError) {
    if (!primaryError) primaryError = cleanupError;
    else console.error('production restoration also failed:', cleanupError);
  }
}

try {
  await assertFixtureUnchanged(exactFixture, stagedFixture.sourceIdentity);
  console.log('[real-project-profile-fixture]', JSON.stringify({
    source: exactFixture,
    copy: fixture,
    sourceIdentity: stagedFixture.sourceIdentity,
    copyIdentity: stagedFixture.copyIdentity,
    sourceUnchanged: true,
  }));
} catch (fixtureError) {
  if (!primaryError) primaryError = fixtureError;
  else console.error('fixture identity verification also failed:', fixtureError);
}
await rm(stagedFixture.root, { recursive: true, force: true });

if (primaryError) throw primaryError;
if (testStatus !== 0) process.exit(testStatus);
