import { _electron, desktopLaunchOptions } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installControlFixture } from './bambu-control-fixture';
import { Ipc } from '../src/shared/ipc';
import { isBambuControlRequest } from '../src/shared/bambuControl';
import type * as D from '@orca/printer-control/domain';
declare global { var printFixture: { requests: unknown[]; submissions: D.PrintSubmissionRequest[]; chunks: number; state: D.PrintSubmissionState | null }; }
test('Bambu Send & Print prepares the current plate, persists options, cancels safely and waits for observed start', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neo-print-e2e-')), configPath = join(directory, 'printer-config.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, printers: [] }));
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'), ORCA_E2E_PRINTER_CONFIG: configPath } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await installControlFixture(app);
    await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
      globalThis.printFixture = { requests: [], submissions: [], chunks: 0, state: null };
      const changed = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channels.bambuChanged, 'control'); };
      ipcMain.removeHandler(channels.bambuControl);
      ipcMain.handle(channels.bambuControl, (_event, request) => {
        const { method, input } = request, fixture = globalThis.printFixture; fixture.requests.push(request);
        const target = input.target ?? input.ref ?? input;
        const data = globalThis.bambuControlFixture.data[target.printerId];
        if (method === 'describe') return { ok: true, value: data.description };
        if (method === 'read') return { ok: true, value: data.snapshot };
        if (method === 'observe' || method === 'release') return { ok: true, value: null };
        if (method === 'preview') return { ok: false, error: { code: 'preview-unavailable', message: 'No image' } };
        if (method === 'print.prepare') return { ok: true, value: { configurationRevision: data.snapshot.configurationRevision, route: 'lan', materialCatalogIds: [],
          bindings: input.suggest ? input.requirements.materials.map((m: D.PrintMaterialRequirement) => ({ materialKey: m.key, pathId: 'path:0:0:0' })) : input.bindings,
          candidates: input.requirements.materials.map((m: D.PrintMaterialRequirement) => ({ materialKey: m.key, pathId: 'path:0:0:0', label: 'AMS A1', materialType: m.type, color: m.color })),
          options: { timelapse: input.options.timelapse ?? true }, optionDescriptors: [{ key: 'timelapse', label: 'Timelapse', enabled: true, choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] }], issues: [] } };
        if (method === 'print.begin') {
          fixture.submissions.push(input.request);
          const ref = { printerId: input.request.target.printerId, routeId: input.request.target.routeId, id: `print-${fixture.submissions.length}` as D.Id<'print-submission'> };
          fixture.state = { ref, requestId: input.request.requestId, phase: 'staging', route: 'lan', progress: 0, message: 'Staging', canCancel: true }; changed();
          return { ok: true, value: { ref, created: true } };
        }
        if (method === 'print.chunk') { fixture.chunks += input.bytes.length; return { ok: true, value: null }; }
        if (method === 'print.commit') { fixture.state = { ...fixture.state!, phase: 'sending', message: 'Sending print' }; changed(); return { ok: true, value: fixture.state }; }
        if (method === 'print.get') return { ok: true, value: fixture.state };
        if (method === 'print.cancel') { fixture.state = { ...fixture.state!, phase: 'cancelling', message: 'Cancelling sending…', canCancel: false }; changed(); return { ok: true, value: fixture.state }; }
        throw new Error('Unexpected fixture call');
      });
    }, Ipc);
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click(); await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    await page.locator('#app-tab-prepare').click(); await page.getByTestId('btn-add-model').click(); await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 30_000 });
    await page.getByTestId('output-mode-select').click(); await page.getByRole('option', { name: 'Send & Print', exact: true }).click(); await page.getByTestId('btn-send-and-print').click();
    const dialog = page.getByTestId('send-gcode-dialog');
    await expect(dialog.getByTestId('send-printer-select')).toContainText('Workshop A');
    await expect(dialog.getByLabel('Material 1 source')).toHaveValue('path:0:0:0');
    await dialog.getByLabel('Timelapse', { exact: true }).selectOption('false');
    await expect.poll(() => JSON.parse(readFileSync(configPath, 'utf8')).printPreferences?.['bambu:a']?.timelapse).toBe(false);
    await page.screenshot({ path: '/tmp/neo-print-preparation.png' });
    await dialog.getByTestId('print-submit').click(); await expect(dialog.getByText('Sending print', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel sending' }).click(); await expect(dialog.getByText('Cancelling sending…')).toBeVisible();
    const phase = async (value: D.PrintSubmissionState['phase']) => app.evaluate(({ BrowserWindow }, { value, channel }) => { globalThis.printFixture.state = { ...globalThis.printFixture.state!, phase: value, canCancel: false, message: value }; for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, 'control'); }, { value, channel: Ipc.bambuChanged });
    await phase('cancelled'); await expect(dialog.getByTestId('print-submit')).toBeEnabled();
    await dialog.getByTestId('print-submit').click(); await expect(dialog.getByText('Sending print', { exact: true })).toBeVisible();
    await phase('confirming'); await expect(dialog).toBeVisible(); await phase('started'); await expect(dialog).toHaveCount(0);
    await expect(page.locator('#device-content')).toBeVisible(); await expect(page.getByTestId('device-printer-select')).toContainText('Workshop A');
    const result = await app.evaluate(() => globalThis.printFixture);
    expect(result.submissions).toHaveLength(2); expect(result.chunks).toBeGreaterThan(0);
    for (const request of result.requests) expect(isBambuControlRequest(request), JSON.stringify(request)).toBe(true);
    await page.screenshot({ path: '/tmp/neo-print-e2e-device.png' });
  } finally { await app.close(); }
});
