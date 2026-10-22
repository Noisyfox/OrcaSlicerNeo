import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('one real Bambu utility serves two windows and survives closing one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'neo-bambu-utility-e2e-'));
  const app = await _electron.launch({ args: [resolve(__dirname, '../out/main/bambu-host-smoke.js')], env: { ...process.env, ORCA_BAMBU_SMOKE_DIRECTORY: directory } });
  try {
    await expect.poll(() => app.windows().length).toBe(2);
    const [first, second] = app.windows();
    const read = (page: typeof first) => page.evaluate(() => (window as unknown as { orca: import('../src/shared/ipc').ElectronBridge }).orca.bambu.read('account.state'));
    // Native startup must actually succeed; an unavailable fallback cannot pass.
    await expect.poll(() => read(first), { timeout: 30_000 }).toEqual({ status: 'signed-out', error: null });
    expect(await read(second)).toEqual({ status: 'signed-out', error: null });
    await expect.poll(() => first.evaluate(() => (window as unknown as { bambuChanges: string[] }).bambuChanges)).toContain('account');
    await expect.poll(() => second.evaluate(() => (window as unknown as { bambuChanges: string[] }).bambuChanges)).toContain('account');
    expect(await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'Orca Bambu Provider').length)).toBe(1);
    await first.close();
    expect(await read(second)).toEqual({ status: 'signed-out', error: null });
    expect(await app.evaluate(({ app }) => app.getAppMetrics().filter(metric => metric.name === 'Orca Bambu Provider').length)).toBe(1);
    const state = JSON.parse(await readFile(join(directory, 'provider.json'), 'utf8'));
    expect(state).toMatchObject({ version: 1, region: 'Others', lan: [] });
    expect(state.clientId).toBeTruthy();
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
