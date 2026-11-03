import { expect, test } from '@playwright/test';
import { _electron, desktopLaunchOptions } from './electron-fixture';
import { installControlFixture } from './bambu-control-fixture';
import { Ipc } from '../src/shared/ipc';

/** Real renderer/preload/main metadata boundary; native protocol/session tests are separate. */
test('Storage resolves only on entry and selects loaded filtered files without selecting later pages', async () => {
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1' } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 850 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await installControlFixture(app);
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, { method, input }) => {
        const fixture = globalThis.bambuControlFixture;
        fixture.requests.push({ method, input });
        const target = input.target ?? input.request?.target ?? input.file ?? input;
        const current = fixture.data[target.printerId];
        if (method === 'describe') return { ok: true, value: current.description };
        if (method === 'read') return { ok: true, value: current.snapshot };
        if (['observe', 'release', 'storage.cancel'].includes(method)) return { ok: true, value: null };
        if (method === 'preview') return { ok: false, error: { code: 'preview-unavailable', message: 'No image.' } };
        if (method === 'storage.storages') return { ok: true, value: ['sdcard', 'internal'].map(id => ({
          id, name: id === 'sdcard' ? 'SD card' : 'Internal storage', kind: id === 'sdcard' ? 'removable' : 'internal',
          availability: { kind: 'available' }, capacityBytes: null, freeBytes: null,
          browsing: { kind: 'supported', constraints: { kind: 'collections', collections: [
            { id: 'model', name: 'Print files', kinds: ['print-file'], actions: ['download', 'delete'] },
          ] } },
        })) };
        if (method === 'storage.list') {
          const request = input.request;
          const files = Array.from({ length: request.cursor ? 1 : 100 }, (_, i) => {
            const index = request.cursor ? 100 : i, name = `${request.storageId}-part-${String(index).padStart(3, '0')}.gcode.3mf`;
            return { ref: { ...request.target, storageId: request.storageId, configurationRevision: current.description.configurationRevision, fileId: name },
              name, directoryId: null, mimeType: null, sizeBytes: 1024 * (index + 1), createdAtMs: null, modifiedAtMs: 1788825600000,
              metadata: { kind: 'print-file', format: 'vendor:bambu-3mf', estimatedDurationSeconds: null, materialKeys: null } };
          });
          return { ok: true, value: { directories: [], files, listingRevision: 'snapshot', pagination: 'snapshot', nextCursor: request.cursor ? null : 'next' } };
        }
        return { ok: false, error: { code: 'unsupported', message: 'Unavailable fixture operation.' } };
      });
    }, Ipc.bambuControl);
    const calls = () => app.evaluate(() => globalThis.bambuControlFixture.requests.filter(request =>
      (request as { method: string }).method.startsWith('storage.')) as { method: string }[]);
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    expect(await calls()).toEqual([]);
    await page.getByRole('tab', { name: 'Storage', exact: true }).click();
    const storage = page.getByTestId('printer-storage');
    await expect(storage.getByRole('checkbox')).toHaveCount(100);
    await storage.getByLabel('Filter loaded files').fill('part-00');
    await expect(storage.getByRole('checkbox')).toHaveCount(10);
    await storage.getByRole('button', { name: 'Select loaded results', exact: true }).click();
    await storage.getByLabel('Filter loaded files').fill('');
    await expect(storage.locator('input[type=checkbox]:checked')).toHaveCount(10);
    await storage.getByRole('button', { name: 'Load more files' }).click();
    await expect(storage.getByRole('checkbox')).toHaveCount(101);
    await expect(storage.locator('input[type=checkbox]:checked')).toHaveCount(10);
    expect((await calls()).filter(call => call.method === 'storage.list')).toHaveLength(2);
    await storage.getByLabel('Storage', { exact: true }).selectOption('internal');
    await expect(storage.getByRole('checkbox')).toHaveCount(100);
    await expect(storage.locator('input[type=checkbox]:checked')).toHaveCount(0);
    await expect(storage.getByText('internal-part-000.gcode.3mf', { exact: true })).toBeVisible();
    await storage.screenshot({ path: test.info().outputPath('storage-browser.png') });
    await storage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(async () => (await calls()).filter(call => call.method === 'storage.list').length).toBe(4);
  } finally { await app.close(); }
});
