import { expect, test, type ElectronApplication } from '@playwright/test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron, desktopLaunchOptions } from './electron-fixture';
import type { ElectronBridge } from '../src/shared/ipc';

test('packaged Bambu resources initialize the real utility and retain provider settings after restart', async () => {
  expect(process.env.ORCA_E2E_PACKAGED_ROOT, 'This probe requires a packaged application').toBeTruthy();
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-packaged-'));
  const manifest = JSON.parse(await readFile(resolve(__dirname, '../../../packages/bambu-native/artifacts.json'), 'utf8'));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_BAMBU_DIRECTORY: directory,
    ORCA_E2E_PREFERENCES: join(directory, 'preferences.json') };
  const read = async (app: ElectronApplication) => {
    const page = await app.firstWindow();
    return page.evaluate(() => (window as unknown as { orca: ElectronBridge }).orca.bambu.read('account.state'));
  };
  let app: ElectronApplication | null = null;
  try {
    app = await _electron.launch({ ...desktopLaunchOptions(), env });
    const paths = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, resources: process.resourcesPath, target: `${process.platform}-${process.arch}` }));
    expect(paths.packaged).toBe(true);
    const bundled = join(paths.resources, 'bambu');
    expect((await readdir(bundled)).sort()).toEqual(['bambu.node', 'cert', 'plugin']);
    const artifact = manifest.artifacts[paths.target];
    expect(artifact).toBeTruthy();
    expect(JSON.parse(await readFile(join(bundled, 'plugin/neo-artifact.json'), 'utf8'))).toEqual({
      release: manifest.release, series: manifest.series, target: paths.target, sha256: artifact.sha256,
    });
    expect((await readdir(join(bundled, 'plugin')))).toContain(artifact.library);
    expect((await readFile(join(bundled, 'cert/slicer_base64.cer'))).byteLength).toBeGreaterThan(0);
    expect((await readFile(join(bundled, 'cert/printer.cer'))).byteLength).toBeGreaterThan(0);
    // The runtime checks the plugin version and creates/starts its agent. An
    // unavailable fallback cannot satisfy this account/candidate assertion.
    await expect.poll(() => read(app!), { timeout: 30_000 }).toEqual({ status: 'signed-out', error: null });
    const page = await app.firstWindow();
    const candidates = await page.evaluate(() => (window as unknown as { orca: ElectronBridge }).orca.bambu.read('printers.candidates'));
    expect(candidates.ok).toBe(true);
    expect(await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'Orca Bambu Provider').length)).toBe(1);
    expect(await page.evaluate(() => (window as unknown as { orca: ElectronBridge }).orca.bambu.command({ action: 'setting', key: 'region', value: 'China' }))).toEqual({ ok: true, value: undefined });
    const before = JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8'));
    await app.close(); app = null;
    app = await _electron.launch({ ...desktopLaunchOptions(), env });
    await expect.poll(() => read(app!), { timeout: 30_000 }).toEqual({ status: 'signed-out', error: null });
    const restarted = await app.firstWindow();
    expect(await restarted.evaluate(() => (window as unknown as { orca: ElectronBridge }).orca.bambu.read('account.settings'))).toEqual([
      expect.objectContaining({ key: 'region', value: 'China' }),
    ]);
    const after = JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8'));
    expect(after.clientId).toBe(before.clientId);
    expect(after.region).toBe('China');
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
