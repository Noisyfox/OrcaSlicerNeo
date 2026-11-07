/** Opt-in real U1 official-material rejection acceptance with original-value verification. */
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePrinterConfigurationDocument } from '@orca/printer-control';
import { _electron } from './electron-fixture';

const configPath = process.env.NEO_U1_ACCEPTANCE_CONFIG;
test.skip(!configPath || process.env.NEO_U1_ACCEPTANCE_MATERIAL_WRITES !== '1', 'Requires explicit real U1 material-write acceptance.');

test('real U1 material editor displays official-material rejection and preserves original metadata', async ({}, info) => {
  test.setTimeout(150000);
  const source = normalizePrinterConfigurationDocument(JSON.parse(readFileSync(configPath!, 'utf8')));
  const matches = source.printers.filter(printer => printer.printerModel?.model === 'Snapmaker U1');
  expect(matches, 'Select exactly one manually configured U1').toHaveLength(1);
  const selected = matches[0];
  const headers: Record<string, string> = selected.apiKey ? { 'X-Api-Key': selected.apiKey } : {};
  const query = new URL('/printer/objects/query', selected.apiBaseUrl);
  for (const object of ['print_stats', 'print_task_config', 'extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed']) query.searchParams.set(object, '');
  async function read() {
    const response = await fetch(query, { headers, signal: AbortSignal.timeout(15000) });
    expect(response.ok).toBe(true);
    const status = (await response.json()).result.status;
    return { print: { state: status.print_stats.state, filename: status.print_stats.filename },
      targets: ['extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed'].map(name => status[name]?.target),
      materials: { vendor: status.print_task_config.filament_vendor, type: status.print_task_config.filament_type,
        subtype: status.print_task_config.filament_sub_type, color: status.print_task_config.filament_color_rgba,
        present: status.print_task_config.filament_exist, official: status.print_task_config.filament_official,
        editable: status.print_task_config.filament_edit, sku: status.print_task_config.filament_sku } };
  }
  const before = await read();
  expect(before.print).toEqual({ state: 'standby', filename: '' });
  expect(before.targets).toEqual([0, 0, 0, 0, 0]);
  expect(before.materials.vendor[0]).toBe('Snapmaker');
  expect(before.materials.type[0]).toBe('PLA');
  expect(before.materials.subtype[0]).toBe('SnapSpeed');
  expect(before.materials.official[0]).toBe(true);
  const originalColor: string = before.materials.color[0];
  expect(originalColor).toMatch(/^[0-9a-f]{8}$/i);
  const testColor = originalColor.toUpperCase() === '12A4EFFF' ? '45B6A1FF' : '12A4EFFF';
  writeFileSync(info.outputPath('materials-before.json'), JSON.stringify(before, null, 2));

  const directory = mkdtempSync(join(tmpdir(), 'neo-u1-material-'));
  const configuration = join(directory, 'printer-config.json');
  writeFileSync(configuration, JSON.stringify({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] }));
  const env: Record<string, string> = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PRINTER_CONFIG: configuration };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${join(directory, 'user-data')}`], cwd: resolve(__dirname, '..'), env });
  let afterAttempt: Awaited<ReturnType<typeof read>> | undefined;
  let restoredVia = 'unchanged';
  let verifiedRejection = false;

  async function editColor(page: Page, color: string) {
    const unit = page.getByRole('heading', { name: 'Toolhead 1', exact: true }).locator('..');
    await unit.getByRole('button', { name: /^Material information for/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Material information', exact: true });
    await expect(dialog.getByRole('combobox', { name: 'Material preset', exact: true })).toContainText('Snapmaker PLA SnapSpeed');
    await expect(dialog.getByRole('button', { name: 'Change material color', exact: true })).toContainText(`#${(await read()).materials.color[0]}`);
    await dialog.getByRole('button', { name: 'Change material color', exact: true }).click();
    const picker = page.locator('[data-slot="popover-content"]').filter({ has: page.locator('[data-slot="color-picker"]') });
    await picker.getByRole('textbox', { name: 'HEX color', exact: true }).fill(color);
    await picker.getByRole('textbox', { name: 'HEX color', exact: true }).press('Tab');
    await picker.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Change material color', exact: true })).toContainText(`#${color}`);
    expect((await read()).print).toEqual(before.print);
    await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Printer rejected the request', { exact: true })).toBeVisible();
    expect(await read()).toEqual(before);
  }

  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 90000 });
    await page.getByTestId('tab-device').click();
    await page.getByTestId('device-printer-select').click();
    await page.getByTestId(`device-select-${selected.id}`).click();
    await editColor(page, testColor);
    afterAttempt = await read();
    await page.screenshot({ path: info.outputPath('u1-official-material-rejected.png'), fullPage: true });
    await page.getByRole('heading', { name: 'Toolhead 1', exact: true }).locator('..')
      .getByRole('button', { name: /^Material information for/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Material information', exact: true });
    await expect(dialog.getByRole('button', { name: 'Change material color', exact: true })).toContainText(`#${originalColor}`);
    await expect(dialog.getByRole('combobox', { name: 'Material preset', exact: true })).toContainText('Snapmaker PLA SnapSpeed');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    verifiedRejection = true;
  } finally {
    try {
      const current = await read();
      if (JSON.stringify(current.materials) !== JSON.stringify(before.materials)) {
        restoredVia = 'direct-restoration';
        expect(current.print).toEqual(before.print);
        const script = `SET_PRINT_FILAMENT_CONFIG CONFIG_EXTRUDER=0 VENDOR=${JSON.stringify(before.materials.vendor[0])} FILAMENT_TYPE=${JSON.stringify(before.materials.type[0])} FILAMENT_SUBTYPE=${JSON.stringify(before.materials.subtype[0])} FILAMENT_COLOR_RGBA=${originalColor}`;
        const response = await fetch(new URL('/printer/gcode/script', selected.apiBaseUrl), {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ script }), signal: AbortSignal.timeout(15000),
        });
        expect(response.ok, 'Restore the original U1 material metadata').toBe(true);
      }
      await expect.poll(read).toEqual(before);
      writeFileSync(info.outputPath('material-write-evidence.json'), JSON.stringify({ outcome: verifiedRejection ? 'official-filament-rejected' : 'acceptance-incomplete',
        attemptedColor: testColor, before, afterAttempt, after: await read(), restoredVia }, null, 2));
    } finally { await app.close(); }
  }
});
