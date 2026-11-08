/** Explicitly opted-in real U1 print. The operator must clear and install the build plate first. */
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { normalizePrinterConfigurationDocument } from '@orca/printer-control';
import { _electron } from './electron-fixture';
import { selectFixturePrinter } from './printer-selection';

const configPath = process.env.NEO_U1_ACCEPTANCE_CONFIG;
const headCount = Number(process.env.NEO_U1_ACCEPTANCE_HEADS ?? '1');
if (![1, 4].includes(headCount)) throw new Error('NEO_U1_ACCEPTANCE_HEADS must be 1 or 4');

interface PrintEvidence {
  print: { filename: string; state: string; filament_used: number; info: { current_layer: number; total_layer: number } };
  progress: number;
  activeExtruder: string;
  heaters: { target: number }[];
  task: { mapping: number[]; usedHeads: boolean[] };
}

function verifyCompletedPrint(observations: readonly PrintEvidence[], heads = 1, layers = 15) {
  const printing = observations.find(observation => observation.print.state === 'printing');
  const completed = observations.find(observation => observation.print.state === 'complete');
  expect(printing).toBeDefined();
  expect(completed).toBeDefined();
  expect(completed?.print.filename).toBe(printing?.print.filename);
  expect(completed?.print.filament_used).toBeGreaterThan(0);
  expect(completed?.print.info).toEqual({ current_layer: layers, total_layer: layers });
  expect(completed?.progress).toBe(1);
  // Firmware clears active task flags at completion. Use the printing snapshot.
  expect(printing?.task.usedHeads).toEqual(Array.from({ length: 4 }, (_, index) => index < heads));
  expect(printing?.task.mapping.slice(0, heads)).toEqual(Array.from({ length: heads }, (_, index) => index));
  expect(completed?.heaters.map(heater => heater.target)).toEqual([0, 0, 0, 0, 0]);
  if (heads > 1) {
    for (let index = 0; index < heads; index++) {
      const name = index === 0 ? 'extruder' : `extruder${index}`;
      expect(observations.some(observation => observation.print.state === 'printing'
        && observation.print.info.current_layer > 0 && observation.activeExtruder === name
        && observation.heaters[index].target >= 180), `Toolhead ${index + 1} active and heated during deposited layers`).toBe(true);
    }
  }
}

test(`real U1 slices and prints a ${headCount}-head PLA test through Send and Print`, async ({}, info) => {
  test.skip(!configPath || process.env.NEO_U1_ACCEPTANCE_PRINT !== '1', 'Requires explicit real-print authorization and a cleared build plate.');
  test.setTimeout(25 * 60 * 1000);
  const source = normalizePrinterConfigurationDocument(JSON.parse(readFileSync(configPath!, 'utf8')));
  const printers = source.printers.filter(printer => printer.printerModel?.model === 'Snapmaker U1');
  expect(printers).toHaveLength(1);
  const selected = printers[0];
  const headers: Record<string, string> = selected.apiKey ? { 'X-Api-Key': selected.apiKey } : {};
  const query = new URL('/printer/objects/query', selected.apiBaseUrl);
  for (const name of ['print_stats', 'print_task_config', 'virtual_sdcard', 'toolhead', 'extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed']) query.searchParams.set(name, '');
  async function read() {
    const response = await fetch(query, { headers, signal: AbortSignal.timeout(15000) });
    expect(response.ok).toBe(true);
    const s = (await response.json()).result.status;
    return { time: new Date().toISOString(), print: s.print_stats, progress: s.virtual_sdcard.progress,
      activeExtruder: s.toolhead.extruder,
      materialColors: s.print_task_config.filament_color_rgba as string[],
      materialTypes: s.print_task_config.filament_type as string[],
      materialPresent: s.print_task_config.filament_exist as boolean[],
      heaters: ['extruder', 'extruder1', 'extruder2', 'extruder3', 'heater_bed'].map(name => ({ name, temperature: s[name].temperature, target: s[name].target })),
      task: { mapping: s.print_task_config.extruder_map_table, usedHeads: s.print_task_config.extruders_used,
        bedLeveling: s.print_task_config.auto_bed_leveling, flowCalibration: s.print_task_config.flow_calibrate, timelapse: s.print_task_config.time_lapse_camera } };
  }
  const before = await read();
  expect(['standby', 'complete', 'cancelled']).toContain(before.print.state);
  expect(before.heaters.map(heater => heater.target)).toEqual([0, 0, 0, 0, 0]);
  expect(before.materialTypes.slice(0, headCount)).toEqual(Array(headCount).fill('PLA'));
  expect(before.materialPresent.slice(0, headCount)).toEqual(Array(headCount).fill(true));
  const directory = mkdtempSync(join(tmpdir(), 'neo-u1-print-'));
  const config = join(directory, 'printer-config.json');
  const height = headCount === 4 ? 1 : 3;
  const layers = headCount === 4 ? 5 : 15;
  const model = join(directory, `NEO_U1_10x10x${height}.stl`);
  const vertices = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, height], [10, 0, height], [10, 10, height], [0, 10, height]];
  const triangles = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const facets = triangles.map(face => ['facet normal 0 0 0', 'outer loop',
    ...face.map(index => `vertex ${vertices[index].join(' ')}`), 'endloop', 'endfacet'].join('\n'));
  writeFileSync(model, ['solid acceptance', ...facets, 'endsolid acceptance', ''].join('\n'));
  writeFileSync(config, JSON.stringify({ version: 1, printers: [{ ...selected, driverId: 'snapmaker' }] }));
  const jobName = `NEO_U1_${headCount}heads_${Date.now()}`;
  const env: Record<string, string> = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_PRINTER_CONFIG: config, ORCA_E2E_MODEL: model };
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${join(directory, 'user-data')}`], cwd: resolve(__dirname, '..'), env });
  const observations = [before];
  writeFileSync(info.outputPath('print-baseline.json'), JSON.stringify({ jobName, heads: headCount, modelSizeMm: [10, 10, height], before }, null, 2));
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    await page.setViewportSize({ width: 1440, height: 1100 });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 90000 });
    await page.locator('#app-tab-prepare').click();
    await selectFixturePrinter(page, 'Snapmaker U1 0.4 nozzle');
    for (let slot = 1; slot <= headCount; slot++) {
      if (!await page.getByTestId(`filament-slot-${slot}`).count()) await page.getByTestId('filament-add').click();
      await page.getByTestId(`filament-preset-${slot}`).click();
      const menu = page.getByRole('menu', { name: `Filament preset for slot ${slot}`, exact: true });
      await menu.getByPlaceholder('Search compatible presets…').fill('Snapmaker PLA SnapSpeed');
      console.log('U1_PRINT_FILAMENT_CHOICES', await menu.getByRole('menuitem').allTextContents());
      await menu.getByRole('menuitem', { name: 'Snapmaker', exact: true }).hover();
      await page.getByRole('menuitemradio', { name: /Snapmaker PLA SnapSpeed/ }).first().click();
      await expect(page.getByTestId(`filament-preset-${slot}`)).toContainText('Snapmaker PLA SnapSpeed');
      await page.getByTestId(`filament-colour-${slot}`).click();
      await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill(before.materialColors[slot - 1]);
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await page.getByTestId('btn-add-model').click();
      if (headCount > 1) {
        await page.getByTestId('config-mode-scoped').click();
        const assignments = page.locator('[data-testid^="filament-cell-object-"]');
        await expect(assignments).toHaveCount(slot);
        await assignments.nth(slot - 1).click();
        await page.getByRole('option', { name: new RegExp(`^${slot} - `) }).click();
        await expect(assignments.nth(slot - 1)).toHaveText(String(slot));
        const rows = page.getByTestId('object-list').locator('section[data-testid^="plate-group-"] > div[data-testid^="object-"]');
        await rows.nth(slot - 1).click();
        await page.getByTestId('gizmo-btn-move').click();
        for (const [axis, value] of [['x', 110 + ((slot - 1) % 2) * 16], ['y', 110 + Math.floor((slot - 1) / 2) * 16]] as const) {
          await page.getByTestId(`move-${axis}`).fill(String(value));
          await page.getByTestId(`move-${axis}`).press('Enter');
        }
        await page.getByTestId('gizmo-btn-move').click();
      }
    }
    await page.getByTestId('btn-slice').click();
    const mapping = page.getByRole('dialog', { name: 'Confirm filament mapping', exact: true });
    await expect(mapping.getByTestId('mapping-mode-2')).toHaveAttribute('aria-pressed', 'true');
    for (let slot = 1; slot <= headCount; slot++) {
      const target = mapping.getByTestId(`mapping-filament-${slot}`);
      await target.click();
      await page.locator(`[id="${await target.getAttribute('aria-controls')}"]`).getByRole('option', { name: `Nozzle ${slot}`, exact: true }).click();
      await expect(target).toContainText(`Nozzle ${slot}`);
    }
    await mapping.getByRole('button', { name: 'Confirm and slice', exact: true }).click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120000 });
    console.log('U1_PRINT_PHASE sliced');
    await page.getByTestId('output-mode-select').click();
    await page.getByRole('menuitemradio', { name: 'Send & Print', exact: true }).click();
    await page.getByTestId('btn-send-and-print').click();
    const dialog = page.getByTestId('send-gcode-dialog');
    await dialog.getByTestId('send-printer-select').click();
    await page.getByRole('option', { name: selected.displayName, exact: true }).click();
    await expect(dialog.getByTestId('send-printer-select')).toContainText(selected.displayName);
    for (let slot = 1; slot <= headCount; slot++)
      await expect(dialog.getByLabel(`Material ${slot} source`, { exact: true })).toHaveAttribute('data-source', `snapmaker-path:${slot - 1}`);
    for (const [label, value] of [['Bed leveling', 'On'], ['Flow calibration', 'Off'], ['Timelapse', 'Off']]) {
      await dialog.getByRole('group', { name: label, exact: true }).getByRole('button', { name: value, exact: true }).click();
    }
    await dialog.getByRole('button', { name: 'Rename print job', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Print job name' }).fill(jobName);
    await dialog.getByRole('textbox', { name: 'Print job name' }).press('Enter');
    await expect(dialog.getByTestId('print-submit')).toBeEnabled();
    await page.screenshot({ path: info.outputPath('u1-print-preparation.png'), fullPage: true });
    writeFileSync(info.outputPath('preparation.txt'), await dialog.innerText());
    expect((await read()).print.state).toBe(before.print.state);
    if (process.env.NEO_U1_ACCEPTANCE_PREPARE_ONLY === '1') return;
    console.log('U1_PRINT_PHASE submitting', jobName);
    await dialog.getByTestId('print-submit').click();
    const warnings = dialog.getByRole('group', { name: 'Confirm print warnings', exact: true });
    await expect(warnings).toBeVisible();
    expect(await warnings.locator('p').allTextContents()).toEqual(['Review before printing',
      ...Array.from({ length: headCount }, (_, index) => `Toolhead ${index + 1} hardness is unreported; the slice requires 0. Confirm the hardware before printing.`)]);
    await warnings.getByRole('button', { name: 'Confirm and print', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: 90000 });
    let last = '';
    for (let count = 0; count < 280; count++) {
      const current = await read(); observations.push(current);
      writeFileSync(info.outputPath('print-observations.json'), JSON.stringify(observations, null, 2));
      console.log('U1_PRINT_STATUS', JSON.stringify(current));
      expect(current.print.filename).toContain(jobName);
      expect(current.print.state).not.toBe('error');
      if (last !== current.print.state) {
        await page.screenshot({ path: info.outputPath(`u1-print-${current.print.state}.png`), fullPage: true });
        last = current.print.state;
      }
      if (current.print.state === 'complete') {
        verifyCompletedPrint(observations, headCount, layers);
        await expect.poll(async () => (await read()).heaters.map(heater => heater.target), { timeout: 60000 }).toEqual([0, 0, 0, 0, 0]);
        console.log('U1_PRINT_PHASE completed', jobName);
        return;
      }
      await page.waitForTimeout(5000);
    }
    throw new Error('U1 did not complete the accepted print within the observation window');
  } catch (error) {
    const page = await app.firstWindow();
    writeFileSync(info.outputPath('ui-on-failure.txt'), await page.locator('body').innerText().catch(() => 'Window unavailable'));
    await page.screenshot({ path: info.outputPath('u1-print-failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await app.close(); }
});

test('recorded U1 print telemetry satisfies the completion checks', async ({}, info) => {
  const evidencePath = process.env.NEO_U1_ACCEPTANCE_PRINT_EVIDENCE;
  test.skip(!evidencePath, 'Requires telemetry retained from an explicitly authorized real print.');
  const observations = JSON.parse(readFileSync(evidencePath!, 'utf8')) as PrintEvidence[];
  verifyCompletedPrint(observations, headCount, headCount === 4 ? 5 : 15);
  writeFileSync(info.outputPath('verified-print-result.json'), JSON.stringify({ samples: observations.length,
    completed: observations.find(observation => observation.print.state === 'complete') }, null, 2));
});
