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
declare global { var printFixture: { requests: unknown[]; submissions: D.PrintSubmissionRequest[]; chunks: number; state: D.PrintSubmissionState | null; holdRead: boolean; releaseRead?: () => void }; }
test('Bambu Send & Print persists options, cancels safely, allows selection after unknown and closes on success', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'neo-print-e2e-')), configPath = join(directory, 'printer-config.json');
  writeFileSync(configPath, JSON.stringify({ version: 1, printers: [] }));
  const app = await _electron.launch({ ...desktopLaunchOptions(), env: { ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'), ORCA_E2E_PRINTER_CONFIG: configPath } });
  try {
    const page = await app.firstWindow(); await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await installControlFixture(app);
    await app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
      globalThis.printFixture = { requests: [], submissions: [], chunks: 0, state: null, holdRead: false };
      const changed = () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channels.bambuChanged, 'control'); };
      ipcMain.removeHandler(channels.bambuControl);
      ipcMain.handle(channels.bambuControl, (_event, request) => {
        const { method, input } = request, fixture = globalThis.printFixture; fixture.requests.push(request);
        const target = input.target ?? input.ref ?? input;
        const data = globalThis.bambuControlFixture.data[target.printerId];
        if (method === 'describe') return { ok: true, value: data.description };
        if (method === 'read') {
          if (input.source === 'device' && fixture.holdRead) return new Promise(resolve => { fixture.releaseRead = () => { fixture.holdRead = false; delete fixture.releaseRead; resolve({ ok: true, value: data.snapshot }); }; });
          return { ok: true, value: data.snapshot };
        }
        if (method === 'observe' || method === 'release') return { ok: true, value: null };
        if (method === 'preview') return { ok: false, error: { code: 'preview-unavailable', message: 'No image' } };
        if (method === 'print.prepare') return { ok: true, value: { configurationRevision: data.snapshot.configurationRevision, route: 'lan', materialCatalogIds: [],
          bindings: input.suggest ? input.requirements.materials.map((m: D.PrintMaterialRequirement) => ({ materialKey: m.key, pathId: 'path:0:0:0' })) : input.bindings,
          candidates: input.requirements.materials.flatMap((m: D.PrintMaterialRequirement) => {
            const base = { materialKey: m.key, pathId: 'path:0:0:0', label: 'AMS A1', materialType: m.type, color: m.color,
              unit: { id: 'unit-a', name: 'AMS 2 Pro', kind: 'automatic-feeder', categoryLabel: 'AMS' }, slot: { id: 'slot-a', name: 'A1' },
              tool: { id: 'tool-a', name: 'Left Nozzle' }, presence: 'present', remainingFraction: .75, disabledReason: null };
            return [base, ...[1, 2, 3].map(index => ({ ...base, pathId: `path:0:${index}:0`, label: `AMS A${index + 1}`, slot: { id: `slot-a${index}`, name: `A${index + 1}` },
              color: ['#333333', '#44AACD', '#00AA77'][index - 1], materialType: index === 1 ? 'PETG-CF' : index === 2 ? null : 'PLA', presence: index === 2 ? 'empty' : 'present', remainingFraction: null,
              disabledReason: index === 1 ? 'Contains PETG-CF; this print requires PLA.' : index === 2 ? 'No filament loaded in this slot.' : null })),
              { ...base, pathId: 'path:254:0:0', label: 'External spool', color: '#FFFFFF00', materialType: null, unit: { id: 'external', name: 'External spool', kind: 'manual-holder', categoryLabel: 'External' }, slot: { id: 'ext', name: 'Ext-L' }, remainingFraction: null },
              ...[0, 1, 2, 3].map(index => ({ ...base, pathId: `path:1:${index}:1`, label: `AMS B${index + 1}`, unit: { ...base.unit, id: 'unit-b' }, slot: { id: `slot-b${index}`, name: `B${index + 1}` }, tool: { id: 'tool-b', name: 'Right Nozzle' }, disabledReason: 'This source cannot feed the required nozzle.' }))];
          }),
          options: { ...input.options, timelapse: input.options.timelapse ?? true, bedLeveling: input.options.bedLeveling ?? 'auto', flowCalibration: input.options.flowCalibration ?? 'auto', nozzleOffsetCalibration: input.options.nozzleOffsetCalibration ?? 'auto' }, nozzleLabels: ['Nozzle 1'], optionDescriptors: [{ key: 'timelapse', label: 'Timelapse', enabled: true, choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] }, ...([{ key: 'bedLeveling', label: 'Auto Bed Leveling' }, { key: 'flowCalibration', label: 'Flow Dynamics Calibration' }, { key: 'nozzleOffsetCalibration', label: 'Nozzle Offset Calibration' }] as const).map(option => ({ ...option, enabled: true, choices: [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] }))], issues: [] } };
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
    await app.evaluate(({ BrowserWindow }, channel) => BrowserWindow.getAllWindows()[0].webContents.send(channel, 'preferences'), Ipc.nativeMenuCommand);
    const preferences = page.getByTestId('project-preferences-dialog');
    const storage = preferences.getByRole('checkbox', { name: 'Allow Abnormal Storage' });
    await expect(preferences).toBeVisible();
    await expect(storage).toBeEnabled();
    await expect(storage).not.toBeChecked();
    await storage.check();
    await expect.poll(() => JSON.parse(readFileSync(configPath, 'utf8')).allowAbnormalStorage).toBe(true);
    await page.screenshot({ path: '/tmp/neo-storage-preferences.png' });
    await preferences.getByTestId('project-preferences-cancel').click();
    await expect(preferences).toHaveCount(0);
    await page.getByTestId('tab-device').click(); await page.getByTestId('device-printer-select').click(); await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    await page.locator('#app-tab-prepare').click(); await page.getByTestId('btn-add-model').click(); await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 30_000 });
    await app.evaluate(() => { globalThis.printFixture.holdRead = true; });
    await page.getByTestId('output-mode-select').click(); await page.getByRole('menuitemradio', { name: 'Send & Print', exact: true }).click(); await page.getByTestId('btn-send-and-print').click();
    const dialog = page.getByTestId('send-gcode-dialog');
    await expect(dialog.getByText('Loading printer information…', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await expect(dialog.getByTestId('print-submit')).toBeDisabled();
    expect(await app.evaluate(() => globalThis.printFixture.requests.some(request => (request as { method: string }).method === 'print.prepare'))).toBe(false);
    await expect.poll(() => app.evaluate(() => !!globalThis.printFixture.releaseRead)).toBe(true);
    await app.evaluate(() => globalThis.printFixture.releaseRead!());
    await expect(dialog.getByText('Loading printer information…', { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole('checkbox', { name: /abnormal storage/i })).toHaveCount(0);
    await expect(dialog.getByTestId('send-printer-select')).toContainText('Workshop A');
    await expect(dialog.getByLabel('Material 1 source')).toHaveAttribute('data-source', 'path:0:0:0');
    await expect(dialog.getByRole('img', { name: 'Print model preview' })).toBeVisible();
    await dialog.getByLabel('Material 1 source', { exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'AMS Slots', exact: true });
    await expect(picker.getByRole('button', { name: 'AMS A2 · PETG-CF', exact: true })).toBeDisabled();
    await expect(picker.getByRole('button', { name: 'AMS A3 · —', exact: true })).toBeDisabled();
    const transparentSource = picker.getByRole('button', { name: 'External spool · ?', exact: true });
    await expect(transparentSource).toBeEnabled();
    await expect(transparentSource).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(transparentSource).toHaveCSS('color', 'rgb(23, 23, 23)');
    await expect(transparentSource).toHaveCSS('background-image', /linear-gradient.*conic-gradient/);
    await expect(transparentSource).toHaveCSS('background-size', '100% 100%, 12px 12px');
    await page.screenshot({ path: '/tmp/neo-filament-picker.png', animations: 'disabled' });
    await picker.getByRole('button', { name: 'Reset current filament mapping' }).focus();
    await page.keyboard.press('Shift+Tab');
    expect(await picker.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(picker).toHaveCount(0);
    await dialog.getByLabel('Material 1 source', { exact: true }).click();
    await page.getByRole('button', { name: 'AMS A1 · PLA', exact: true }).click();
    await dialog.getByRole('group', { name: 'Timelapse', exact: true }).getByRole('button', { name: 'Off', exact: true }).click();
    await expect.poll(() => JSON.parse(readFileSync(configPath, 'utf8')).printPreferences?.['bambu:a']?.timelapse).toBe(false);
    await expect(dialog.getByRole('group', { name: 'Timelapse', exact: true }).getByRole('button', { name: 'Off', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.getByTestId('print-submit')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Rename print job' }).click();
    await dialog.getByRole('textbox', { name: 'Print job name' }).fill('Cube');
    await dialog.getByRole('textbox', { name: 'Print job name' }).press('Enter');
    await page.screenshot({ path: '/tmp/neo-print-preparation.png', animations: 'disabled' });
    await dialog.getByTestId('print-submit').click(); await expect(dialog.getByText('Sending print', { exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape'); await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel sending' }).click(); await expect(dialog.getByText('Cancelling sending…')).toBeVisible();
    const phase = async (value: D.PrintSubmissionState['phase']) => app.evaluate(({ BrowserWindow }, { value, channel }) => { globalThis.printFixture.state = { ...globalThis.printFixture.state!, phase: value, canCancel: false, message: value }; for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, 'control'); }, { value, channel: Ipc.bambuChanged });
    await phase('cancelled'); await expect(dialog.getByTestId('print-submit')).toBeEnabled();
    await dialog.getByTestId('print-submit').click(); await expect(dialog.getByText('Sending print', { exact: true })).toBeVisible();
    await phase('unknown'); await expect(dialog.getByTestId('print-submit')).toBeDisabled();
    await dialog.getByRole('button', { name: 'View printer', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByTestId('device-printer-select').click(); await page.getByRole('option', { name: 'Workshop B', exact: true }).click();
    await expect(page.getByTestId('device-printer-select')).toContainText('Workshop B');
    expect(await app.evaluate(() => globalThis.printFixture.state?.phase)).toBe('unknown');
    await page.getByTestId('device-printer-select').click(); await page.getByRole('option', { name: 'Workshop A', exact: true }).click();
    await page.locator('#app-tab-prepare').click(); await page.getByTestId('btn-send-and-print').click();
    await expect(dialog.getByTestId('print-submit')).toBeEnabled();
    await dialog.getByRole('button', { name: 'Rename print job' }).click();
    await dialog.getByRole('textbox', { name: 'Print job name' }).fill('Cube');
    await dialog.getByRole('textbox', { name: 'Print job name' }).press('Enter');
    await dialog.getByTestId('print-submit').click(); await expect(dialog.getByText('Sending print', { exact: true })).toBeVisible();
    await phase('sent'); await expect(dialog).toHaveCount(0);
    await expect(page.locator('#device-content')).toBeVisible(); await expect(page.getByTestId('device-printer-select')).toContainText('Workshop A');
    const result = await app.evaluate(() => globalThis.printFixture);
    expect(result.submissions).toHaveLength(3); expect(result.chunks).toBeGreaterThan(0);
    for (const submission of result.submissions) { expect(submission.allowAbnormalStorage).toBe(true); expect(submission.jobName).toBe('Cube'); }
    for (const request of result.requests) expect(isBambuControlRequest(request), JSON.stringify(request)).toBe(true);
    await page.screenshot({ path: '/tmp/neo-print-e2e-device.png' });
  } finally { await app.close(); }
});
