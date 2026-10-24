import { _electron } from './electron-fixture';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('independent Electron instances own separate real Bambu utilities and restore shared configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-utility-e2e-'));
  const applications = new Set<ElectronApplication>();
  const launch = async () => {
    const application = await _electron.launch({ args: [resolve(__dirname, '../out/main/bambu-host-smoke.js')], env: { ...process.env, ORCA_BAMBU_SMOKE_DIRECTORY: directory } });
    applications.add(application); return application;
  };
  const read = (page: Page) => page.evaluate(() => (window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca.bambu.read('account.state'));
  const utilityPids = (application: ElectronApplication) => application.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'Orca Bambu Provider').map(metric => metric.pid));
  try {
    const [a, b] = await Promise.all([launch(), launch()]);
    const [first, second] = await Promise.all([a.firstWindow(), b.firstWindow()]);
    await expect.poll(() => read(first), { timeout: 30_000 }).toEqual({ status: 'signed-out', error: null });
    await expect.poll(() => read(second), { timeout: 30_000 }).toEqual({ status: 'signed-out', error: null });
    expect(a.windows()).toHaveLength(1); expect(b.windows()).toHaveLength(1);
    const [aPids, bPids] = await Promise.all([utilityPids(a), utilityPids(b)]);
    expect(aPids).toHaveLength(1); expect(bPids).toHaveLength(1); expect(aPids[0]).not.toBe(bPids[0]);
    const state = JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8'));
    expect(state).toMatchObject({ version: 1, region: 'Others', lan: [] }); expect(state.clientId).toBeTruthy();
    await a.close(); applications.delete(a);
    expect(await read(second)).toEqual({ status: 'signed-out', error: null });
    expect(await utilityPids(b)).toEqual(bPids);
    const c = await launch(), third = await c.firstWindow();
    await expect.poll(() => read(third), { timeout: 30_000 }).toEqual({ status: 'signed-out', error: null });
    expect(JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8')).clientId).toBe(state.clientId);
  } finally {
    await Promise.all([...applications].map(application => application.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
