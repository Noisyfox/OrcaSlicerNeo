import { expect, test } from '@playwright/test';
import { _electron, desktopLaunchOptions } from './electron-fixture';
import { installControlFixture } from './bambu-control-fixture';
import { Ipc } from '../src/shared/ipc';

test('Storage repairs same-printer LAN access through explicit discovery and retains the existing device identity', async () => {
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1' } });
  try {
    const page = await app.firstWindow(); await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await installControlFixture(app);
    await app.evaluate(({ ipcMain }, channels) => {
      let authorized = false;
      const devices = ['a', 'b'].map(deviceId => ({ deviceId, name: `Workshop ${deviceId.toUpperCase()}`, model: 'H2D', routes: [{ channel: 'cloud', revision: 'r1' }] as Record<string, string>[] }));
      ipcMain.removeHandler(channels.bambuRead);
      ipcMain.handle(channels.bambuRead, (_event, kind) => kind === 'printers.saved' ? { ok: true, value: devices }
        : kind === 'printers.candidates' ? { ok: true, value: devices.map(device => ({ candidateId: device.deviceId, deviceId: device.deviceId, name: `LAN ${device.name}`, model: 'H2D', address: '192.0.2.1', expiresAtMs: Date.now() + 60_000 })) }
          : kind === 'account.state' ? { status: 'signed-out', error: null } : []);
      ipcMain.removeHandler(channels.bambuPrinterCommand);
      ipcMain.handle(channels.bambuPrinterCommand, (event, request) => {
        if (request.action !== 'authorize' || request.candidateId !== 'a' || request.accessCode !== 'ABCDEFGH') throw new Error('Incorrect authorization target');
        authorized = true; devices[0].routes.push({ channel: 'lan', revision: 'lan-r1', address: '192.0.2.1' }); event.sender.send(channels.bambuChanged, 'printers');
        return { ok: true, value: null };
      });
      ipcMain.removeHandler(channels.bambuControl);
      ipcMain.handle(channels.bambuControl, (_event, { method, input }) => {
        if (method === 'storage.storages') return authorized ? { ok: true, value: [] } : { ok: false, error: { code: 'authentication-required', message: 'Authorize LAN access to browse storage.' } };
        if (method === 'describe') return { ok: true, value: globalThis.bambuControlFixture.data[input.printerId].description };
        if (method === 'read') return { ok: true, value: globalThis.bambuControlFixture.data[input.printerId].snapshot };
        if (method === 'preview') return { ok: false, error: { code: 'preview-unavailable', message: 'No fixture preview.' } };
        return { ok: true, value: null };
      });
    }, Ipc);
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click(); await page.getByRole('tab', { name: 'Storage', exact: true }).click();
    await page.getByRole('button', { name: 'Authorize storage access', exact: true }).click();
    const dialog = page.getByTestId('printer-discovery-dialog'); await expect(dialog.getByText('LAN Workshop A', { exact: true })).toBeVisible();
    await expect(dialog.getByText('LAN Workshop B', { exact: true })).toHaveCount(0);
    await dialog.getByText('LAN Workshop A', { exact: true }).click(); await dialog.getByLabel('Access code', { exact: true }).fill('ABCDEFGH');
    await expect(dialog.getByLabel('Access code', { exact: true })).toHaveAttribute('type', 'password'); await dialog.getByRole('button', { name: 'Authorize access', exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(page.getByTestId('printer-storage')).toContainText('The printer reports no available storage.');
    await expect(page.getByTestId('device-printer-select')).toContainText('Workshop A');
  } finally { await app.close(); }
});

/** Real renderer/preload/main metadata boundary; native protocol/session tests are separate. */
test('Storage scopes selection, retains download tasks and distinguishes confirmed and uncertain deletion', async () => {
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
        const target = input.target ?? input.request?.target ?? input.request?.inspection?.file ?? input.file ?? input;
        const current = fixture.data[target.printerId];
        if (method === 'submit' && input.command.type === 'files.delete') return { kind: 'recorded', operation: { ...input.target, id: input.command.params.target.fileId } };
        if (method === 'submit' && input.command.type === 'jobs.start') return { kind: 'recorded', operation: { ...input.target, id: 'remote-print' } };
        if (method === 'operation' && input.id === 'remote-print') return { ok: true, value: { kind: 'found', operation: { kind: 'command', commandType: 'jobs.start', ref: input, requestId: 'print', configurationRevision: current.description.configurationRevision, revision: 2, updatedAtMs: 0, steps: [], phase: { kind: 'submitted' } } } };
        if (method === 'operation') return { ok: true, value: { kind: 'found', operation: { kind: 'command', commandType: 'files.delete',
          ref: input, requestId: 'delete', configurationRevision: current.description.configurationRevision, revision: 1, updatedAtMs: 0, steps: [],
          phase: input.id.includes('001') ? { kind: 'outcome-unknown', reason: 'Fixture connection lost.' } : { kind: 'completed', result: null, confirmation: 'device-result' } } } };
        if (method === 'describe') return { ok: true, value: current.description };
        if (method === 'read') return { ok: true, value: current.snapshot };
        if (['observe', 'release', 'storage.cancel'].includes(method)) return { ok: true, value: null };
        if (method === 'preview') return { ok: false, error: { code: 'preview-unavailable', message: 'No image.' } };
        if (method === 'storage.previews') return { ok: true, value: { file: input.file, options: [{ id: 'thumbnail', kind: 'thumbnail', label: 'Thumbnail', contentFormat: null }] } };
        if (method === 'storage.releasePrint') return { ok: true, value: null };
        if (method === 'storage.inspectPrint') return { ok: true, value: { ref: { file: input.file, id: 'inspection' }, expiresAtMs: Date.now() + 60_000,
          targets: [1, 2].map(n => ({ id: `target-${n}`, label: `Plate ${n}`, availability: { kind: 'available' },
            thumbnail: { id: `print-thumbnail:${n}`, kind: 'thumbnail', label: 'Plate thumbnail', contentFormat: null },
            requirements: { contentId: 'inspection', plateId: `remote-${n}`, printerModel: 'Fixture', printerModelId: 'fixture',
              nozzleDiameters: [.4], nozzleFlowTypes: ['Standard'], filamentMap: [1], requiresDynamicMapping: false, bedType: 'High Temp Plate',
              durationSeconds: n * 60, weightGrams: n, layerCount: 0, toolpathOutside: false, timelapseWarningCode: 0, warnings: [], materials: [] } })) } };
        if (method === 'storage.preparePrint') return { ok: true, value: { configurationRevision: current.description.configurationRevision, route: 'lan', bindings: [], candidates: [],
          options: input.request.options, nozzleLabels: ['Nozzle'], materialCatalogIds: [], optionDescriptors: [], issues: [] } };
        if (method === 'storage.storages') return { ok: true, value: ['external', 'internal'].map(id => ({
          id, name: id === 'external' ? 'External' : 'Internal', kind: id === 'external' ? 'removable' : 'internal',
          availability: { kind: 'available' }, capacityBytes: null, freeBytes: null,
          browsing: { kind: 'supported', constraints: { kind: 'collections', collections: [
            { id: 'model', name: 'Print files', kinds: ['print-file'], actions: ['download', 'delete', 'inspect-print'] },
            ...(id === 'external' ? [{ id: 'timelapse', name: 'Timelapses', kinds: ['timelapse'], actions: ['download', 'preview'] },
              { id: 'video', name: 'Recordings', kinds: ['recording'], actions: ['download', 'preview'] }] : []),
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
    await app.evaluate(({ ipcMain }, channels) => {
      const tasks: any[] = [];
      ipcMain.removeHandler(channels.request);
      ipcMain.handle(channels.request, (event, { method, args }) => {
        if (method === 'list') return { ok: true, value: tasks };
        if (method === 'directory') return { ok: true, value: { label: 'Fixture downloads' } };
        if (method === 'start') {
          for (const [index, file] of args[0].files.entries()) tasks.push({ ...file, id: `task-${index}`, batchId: 'batch', attempt: 1,
            state: 'running', phase: 'transferring', writtenBytes: 1024, totalBytes: 4096, canCancel: true, canRetry: false, error: null, warning: null });
          event.sender.send(channels.changed); return { ok: true, value: { status: 'queued', batchId: 'batch', taskIds: tasks.map(task => task.id) } };
        }
        if (method === 'cancel') {
          const task = tasks.find(task => task.id === args[0]); task.state = 'cancelled'; task.canCancel = false; task.canRetry = true;
          event.sender.send(channels.changed); return { ok: true, value: null };
        }
        return { ok: false, error: { code: 'unsupported', message: 'Fixture action unavailable.' } };
      });
    }, { request: Ipc.printerDownloadRequest, changed: Ipc.printerDownloadChanged });
    await app.evaluate(({ ipcMain }, channel) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (_event, { method, input }) => method === 'open' ? { ok: true, value: {
        ref: { ...input.target, id: input.requestId }, configurationRevision: input.source.target.configurationRevision,
        revision: 1, source: input.source, expiresAtMs: null,
        presentation: { kind: 'image', mimeType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=' },
      } } : { ok: true, value: null });
    }, Ipc.bambuMedia);
    const calls = () => app.evaluate(() => globalThis.bambuControlFixture.requests.filter(request =>
      (request as { method: string }).method.startsWith('storage.')) as { method: string }[]);
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click();
    await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    expect(await calls()).toEqual([]);
    await page.getByRole('tab', { name: 'Storage', exact: true }).click();
    const storage = page.getByTestId('printer-storage');
    await expect(storage.getByRole('checkbox')).toHaveCount(100);
    await expect.poll(() => storage.getByAltText('Thumbnail of external-part-000.gcode.3mf').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    await storage.getByLabel('Filter loaded files').fill('part-00');
    await expect(storage.getByRole('checkbox')).toHaveCount(10);
    await storage.getByRole('button', { name: 'Select loaded results', exact: true }).click();
    await storage.getByLabel('Filter loaded files').fill('');
    await expect(storage.locator('input[type=checkbox]:checked')).toHaveCount(10);
    await storage.getByRole('button', { name: 'Load more files' }).click();
    await expect(storage.getByRole('checkbox')).toHaveCount(101);
    await expect(storage.locator('input[type=checkbox]:checked')).toHaveCount(10);
    expect((await calls()).filter(call => call.method === 'storage.list')).toHaveLength(2);
    await storage.getByRole('button', { name: 'Download selected', exact: true }).click();
    await expect(storage.getByTestId('download-task')).toHaveCount(10);
    await page.getByRole('tab', { name: 'Monitor', exact: true }).click();
    await page.getByRole('tab', { name: 'Storage', exact: true }).click();
    await expect(storage.getByTestId('download-task')).toHaveCount(10);
    await storage.getByRole('button', { name: 'Cancel', exact: true }).first().click();
    await expect(storage.getByRole('button', { name: 'Retry from start', exact: true })).toHaveCount(1);
    await storage.getByRole('combobox', { name: 'Storage', exact: true }).click();
    await page.getByRole('option', { name: 'Internal', exact: true }).click();
    await expect(page.getByRole('listbox')).not.toBeVisible();
    await expect(storage.getByRole('checkbox')).toHaveCount(100);
    await expect(storage.locator('input[type=checkbox]:checked')).toHaveCount(0);
    await expect(storage.getByText('internal-part-000.gcode.3mf', { exact: true })).toBeVisible();
    await storage.screenshot({ path: test.info().outputPath('storage-browser.png') });
    await storage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect.poll(async () => (await calls()).filter(call => call.method === 'storage.list').length).toBe(5);
    await storage.getByRole('checkbox', { name: 'Select internal-part-000.gcode.3mf', exact: true }).check();
    await storage.getByRole('button', { name: 'Delete selected', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Internal');
    await page.getByRole('button', { name: 'Delete files', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('1 deleted · 0 failed · 0 unconfirmed');
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(storage.getByRole('checkbox')).toHaveCount(99);
    await storage.getByRole('checkbox', { name: 'Select internal-part-001.gcode.3mf', exact: true }).check();
    await storage.getByRole('checkbox', { name: 'Select internal-part-002.gcode.3mf', exact: true }).check();
    await storage.getByRole('button', { name: 'Delete selected', exact: true }).click();
    await page.getByRole('button', { name: 'Delete files', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('Deletion paused.');
    await page.getByRole('button', { name: 'Stop batch', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(storage.getByText('Deletion unconfirmed · Refresh manually')).toBeVisible();
    await expect(storage.getByRole('checkbox')).toHaveCount(99);
    expect((await calls()).filter(call => call.method === 'storage.list')).toHaveLength(5);
    await storage.getByRole('checkbox', { name: 'Select internal-part-001.gcode.3mf', exact: true }).uncheck();
    await storage.getByRole('checkbox', { name: 'Select internal-part-002.gcode.3mf', exact: true }).uncheck();
    await storage.getByRole('checkbox', { name: 'Select internal-part-003.gcode.3mf', exact: true }).check();
    await storage.getByRole('button', { name: 'Print selected file', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Print device file');
    await dialog.getByRole('combobox', { name: 'Print target', exact: true }).click();
    await page.getByRole('option').nth(1).click();
    await expect(page.getByRole('listbox')).not.toBeVisible();
    await expect(dialog.getByTestId('print-job-statistics')).toContainText('2m');
    await expect.poll(() => dialog.getByAltText('Thumbnail of internal-part-003.gcode.3mf').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
    await dialog.screenshot({ path: test.info().outputPath('storage-print-preparation.png') });
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const starts = await app.evaluate(() => (globalThis.bambuControlFixture.requests as { method: string; input: { command?: { type: string; params: unknown } } }[])
      .filter(r => r.method === 'submit' && r.input.command?.type === 'jobs.start').map(r => r.input.command!.params));
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ inspection: { id: 'inspection', targetId: 'target-2' }, source: { fileId: 'internal-part-003.gcode.3mf' } });
    await page.getByRole('tab', { name: 'Storage', exact: true }).click();
    await storage.getByRole('combobox', { name: 'Storage', exact: true }).click();
    await page.getByRole('option', { name: 'Internal', exact: true }).click();
    await expect(page.getByRole('listbox')).not.toBeVisible();
    await storage.getByRole('tab', { name: 'Recordings', exact: true }).click();
    await expect(storage.getByRole('combobox', { name: 'Storage', exact: true })).not.toBeVisible();
    await expect(storage.getByText('external-part-000.gcode.3mf', { exact: true })).toBeVisible();
    await expect(storage.locator('input[type=checkbox]:checked')).toHaveCount(0);
    await storage.getByRole('tab', { name: 'Print files', exact: true }).click();
    await expect(storage.getByRole('combobox', { name: 'Storage', exact: true })).toContainText('External');

  } finally { await app.close(); }
});
