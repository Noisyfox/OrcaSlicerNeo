// Fixture-safe equivalent of the existing focused real Electron regression list.
// That older runner hardcodes a source-file path for its object-move test.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFixtureCopy, assertFixtureUnchanged, EXPECTED_FIXTURE_PATH } from './real-project-fixture.mjs';

const root = resolve(import.meta.dirname, '..');
const desktop = join(root, 'apps/desktop');
const output = resolve(process.env.ORCA_SCOPED_HOST_REPORT_DIR || join(tmpdir(), `orca-scoped-hosts-${Date.now()}`));
await mkdir(output, { recursive: true });
console.log(`Persistent real Electron reports: ${output}`);
const report = { commands: [], sourceUnchanged: false };
const runs = [
  ['app.e2e.ts', 'real DRC flow'], ['app.e2e.ts', 'real STEP flow'],
  ['multi-filament.e2e.ts', 'filament rack remains enabled during history restore'],
  ['project-load-proof.e2e.ts', 'commits the requested multi-plate project'],
  ['prime-tower-project.e2e.ts', 'opened project keeps prime-tower UI'],
  ['prime-tower-history-performance.e2e.ts', 'measures Odyssey Prime Tower commit'],
  ['plate-add-history-profile.e2e.ts', 'profiles Add Plate click'],
  ['object-move-history-profile.e2e.ts', 'profiles a real object move'],
];
const persist = () => writeFile(join(output, 'matrix.json'), JSON.stringify(report, null, 2));
async function run(name, args, env) {
  const result = spawnSync('cmd.exe', ['/d', '/c', 'pnpm', ...args], {
    cwd: desktop, env, encoding: 'utf8', windowsVerbatimArguments: true, maxBuffer: 64 * 1024 * 1024,
  });
  const log = join(output, `${name}.log`);
  await writeFile(log, `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.stack ?? ''}`);
  const skipped = args.includes('playwright') && /\b[1-9]\d* skipped\b/.test(`${result.stdout}${result.stderr}`);
  const exitCode = skipped ? 1 : result.status;
  report.commands.push({ name, args, exitCode, skipped, log });
  await persist();
  console.log(`${name}: ${exitCode === 0 ? 'PASS' : 'FAIL'} (${log})`);
  return exitCode === 0;
}
await assertFixtureUnchanged(EXPECTED_FIXTURE_PATH);
try {
  for (const variant of ['serial', 'threaded']) {
    const env = { ...process.env, VITE_USE_MOCK: '0', VITE_REAL_PROJECT_PROFILE: '0',
      VITE_E2E: '1', ORCA_E2E: '1', ORCA_E2E_REAL: '1',
      VITE_SCOPED_CONFIGURATION_GATE: '1', VITE_SCOPED_CONFIGURATION_GATE_VARIANT: variant };
    const built = await run(`${variant}-build`, ['exec', 'electron-vite', 'build'], env);
    await cp(join(desktop, 'src/renderer/public'), join(desktop, 'out/renderer'), { recursive: true, force: true });
    for (const [file, title] of runs) {
      const fixture = await createFixtureCopy();
      if (built) await run(`${variant}-${file}-${title.replace(/[^a-z0-9]/gi, '-')}`,
        ['exec', 'playwright', 'test', `e2e/${file}`, '-g', `"${title}"`],
        { ...env, ORCA_E2E_PRIME_TOWER_PROJECT: fixture.copyPath });
      else report.commands.push({ name: `${variant}-${file}`, blocked: 'renderer build failed', exitCode: null });
      await assertFixtureUnchanged(EXPECTED_FIXTURE_PATH);
      await persist();
    }
  }
} finally {
  await assertFixtureUnchanged(EXPECTED_FIXTURE_PATH);
  report.sourceUnchanged = true;
  await persist();
}
process.exitCode = report.commands.every(command => command.exitCode === 0) ? 0 : 1;
