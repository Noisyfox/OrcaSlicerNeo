// apps/desktop/e2e/packaged.e2e.ts — probes the REAL wasm URL path in the
// PACKAGED app: verifies T2's relative worker URL, the loopback-http
// renderer origin (main serves out/renderer — file:// and custom schemes
// cannot spawn out-of-process workers), and that the worker loads its
// module (presets rendered) without renderer errors.
//
// Requires (run in order; public/wasm is gitignored so this never ships):
//   node scripts/stage-stub-wasm.mjs    # plain-JS stub module → public/wasm/
//   pnpm --filter @orca/desktop package:dir   # release/win-unpacked/ (no-mock build)
//   npx playwright test e2e/packaged.e2e.ts
// CI e2e-real covers the same path with the real module in the dev build.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';
import { copyFile, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const PACKAGED_ROOT = resolve(DESKTOP_ROOT, process.env.ORCA_E2E_PACKAGED_ROOT ?? (process.platform === 'win32' ? 'release/win-unpacked' : 'release/linux-unpacked'));
const EXE = process.platform === 'win32'
  ? resolve(PACKAGED_ROOT, 'OrcaSlicerNeo.exe')
  : resolve(PACKAGED_ROOT, 'OrcaSlicerNeo');
const UNPACKED_PROFILES = resolve(
  PACKAGED_ROOT,
  'resources/app.asar.unpacked/out/renderer/profiles',
);
const CORE_PACKAGE = resolve(UNPACKED_PROFILES, 'core.upstream.zip');
// darwin: release/mac/OrcaSlicerNeo.app/Contents/MacOS/OrcaSlicerNeo

test('packaged app loads loopback Worker, threaded capability, WASM and profiles', async () => {
  expect(existsSync(EXE), `packaged app missing — run package:dir first (${EXE})`).toBe(true);
  const rendererErrors: string[] = [];
  const env = { ...process.env } as Record<string, string>;
  // Ambient shells sometimes carry ELECTRON_RUN_AS_NODE=1, which forces
  // Electron to run as plain node (the app cannot boot) — never valid here.
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ executablePath: EXE, env });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (err) => rendererErrors.push(String(err)));
    await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 300_000 });
    const probe = await page.evaluate(async () => ({
      isolated: crossOriginIsolated,
      manifest: await fetch('/profiles/manifest.json').then((r) => ({ ok: r.ok, type: r.headers.get('content-type') })),
      core: await fetch('/profiles/core.upstream.zip').then((r) => ({ ok: r.ok, type: r.headers.get('content-type'), bytes: Number(r.headers.get('content-length') ?? 0) })),
      workers: performance.getEntriesByType('resource').map((e) => e.name).filter((name) => name.includes('slicer.worker')),
    }));
    expect(probe.isolated).toBe(true);
    expect(probe.manifest).toMatchObject({ ok: true, type: 'application/json' });
    expect(probe.core.ok).toBe(true);
    expect(probe.core.type).toBe('application/octet-stream');
    expect(probe.workers.length).toBeGreaterThan(0);
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

test.describe.configure({ timeout: 300_000 });

test('packaged app blocks startup when the core profile package is missing', async () => {
  expect(existsSync(EXE), `packaged app missing — run package:dir first (${EXE})`).toBe(true);
  expect(existsSync(CORE_PACKAGE), `profiles must be asar-unpacked (${CORE_PACKAGE})`).toBe(true);
  const missing = `${CORE_PACKAGE}.missing`;
  await rename(CORE_PACKAGE, missing);
  try {
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: EXE, env });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('startup-error')).toContainText('core profile package', { timeout: 300_000 });
      await expect(page.getByTestId('preset-select')).toHaveCount(0);
    } finally { await app.close(); }
  } finally { await rename(missing, CORE_PACKAGE); }
});

test('packaged app blocks startup when the core profile package is corrupt', async () => {
  expect(existsSync(EXE), `packaged app missing — run package:dir first (${EXE})`).toBe(true);
  expect(existsSync(CORE_PACKAGE), `profiles must be asar-unpacked (${CORE_PACKAGE})`).toBe(true);
  const backup = `${CORE_PACKAGE}.backup`;
  await rename(CORE_PACKAGE, backup);
  await writeFile(CORE_PACKAGE, Buffer.from('not-a-zip'));
  try {
    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: EXE, env });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('startup-error')).toContainText('core profile package', { timeout: 300_000 });
      await expect(page.getByTestId('preset-select')).toHaveCount(0);
    } finally { await app.close(); }
  } finally {
    await copyFile(backup, CORE_PACKAGE);
    await unlink(backup);
  }
});
