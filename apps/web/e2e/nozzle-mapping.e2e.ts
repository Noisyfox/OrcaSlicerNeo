import { selectGcodeOutput } from '../../desktop/e2e/plate-controls.helpers';
import { test, expect, configuredActivation } from './browser-fixture';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { installSliceReceiptObserver, readSliceReceipts } from '../../desktop/e2e/runtime-receipts';
import { readZipEntries } from '../../../packages/slicer-wasm/harness/native-3mf-parser.mjs';
import { extrudingTools } from '../../../packages/slicer-wasm/harness/nozzle-mapping-gcode.mjs';

test('real Web mapping survives browser project download/reopen and slices the confirmed nozzle', async ({ page, context }) => {
  test.setTimeout(180_000);
  test.skip(!process.env.ORCA_E2E_MAPPING_PROJECT, 'requires the native nozzle-mapping persistence fixture');
  const root = resolve(import.meta.dirname, '../../..');
  const source = process.env.ORCA_E2E_MAPPING_PROJECT!;
  const sourceBytes = await readFile(source);
  const variant = process.env.ORCA_WEB_NO_ISOLATION === '1' ? 'serial' : 'threaded';
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const assets = new Map<string, string>();
  await context.route('**/wasm/**/*', async route => {
    const match = new URL(route.request().url()).pathname.match(/\/wasm\/(serial|threaded)\/(orca_slice\.(?:js|wasm|data))$/);
    if (!match) return route.continue();
    const response = await route.fetch(), body = await response.body();
    const native = await readFile(resolve(root, 'packages/slicer-wasm/out', variant, match[2]));
    // Web packaging replaces unreachable Node imports in the JS loader only.
    const expected = match[2].endsWith('.js') ? Buffer.from(native.toString('utf8')
      .replace(/node:(module|worker_threads|fs|path|url|util)/g, 'web-only-disabled:$1')
      .replace(/globalThis\.process/g, 'undefined')) : native;
    expect(match[1]).toBe(variant);
    expect(hash(body)).toBe(hash(expected));
    expect(hash(body)).toBe(hash(await readFile(resolve(root, 'apps/web/dist/wasm', variant, match[2]))));
    assets.set(match[2], hash(body));
    await route.fulfill({ response, body });
  });
  await page.addInitScript(profileActivation => {
    localStorage.setItem('orca-slicer-neo:preferences', JSON.stringify({ version: 1, profileActivation,
      selectedProfiles: { printer: 'Bambu Lab H2D 0.4 nozzle' }, projectLoadBehaviour: 'load_all',
      rememberedNozzleCapacities: { 'Bambu Lab H2D 0.4 nozzle': [99, 99] }, ui: { sidebarWidth: 340 } }));
  }, configuredActivation);
  await page.goto('/');
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(variant === 'threaded');
  await expect(page.getByTestId('serial-fallback-status')).toHaveCount(variant === 'serial' ? 1 : 0);
  expect([...assets.keys()].sort()).toEqual(['orca_slice.data', 'orca_slice.js', 'orca_slice.wasm']);
  await page.locator('#app-tab-prepare').click();
  await installSliceReceiptObserver(page, ['getNozzleMapping', 'mutateNozzleMapping', 'slicePlate']);
  const responses = async (op: string) => (await readSliceReceipts(page) as any[])
    .filter(receipt => receipt.direction === 'response' && receipt.op === op);
  const openProject = async (name: string, buffer: Buffer) => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByTestId('titlebar-menu-trigger').click();
    await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot="menubar-sub-content"]').hover({ position: { x: 8, y: 8 } });
    await page.getByTestId('file-open-project').click();
    await (await chooser).setFiles({ name, mimeType: 'application/octet-stream', buffer });
    // Poll the requested receipt, not a previous project's completed load.
    await expect.poll(async () => {
      if (await page.getByTestId('project-load-choice-dialog').isVisible()) {
        await page.getByTestId('project-load-project').click();
        await page.getByTestId('project-load-confirm').click();
      }
      if (await page.getByTestId('project-load-confirmation-dialog').isVisible())
        await page.getByTestId('project-load-confirmation-dialog-continue').click();
      return page.evaluate(() => (window as any).__orcaE2e.projectLoadEvidence().receipt);
    }, { timeout: 120_000 }).toMatchObject({ sourceDisplayName: name, sourceByteLength: buffer.length,
      nativeResult: { ok: true, mode: 'project' } });
    await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0);
    if (await page.getByTestId('project-notice-dialog-close').isVisible())
      await page.getByTestId('project-notice-dialog-close').click();
  };
  const sliceAndDownload = async (tool: number, edit?: number) => {
    await page.getByTestId('btn-slice').click();
    const dialog = page.getByTestId('mapping-confirmation');
    await expect(dialog).toBeVisible();
    if (edit !== undefined) {
      await dialog.getByTestId('mapping-filament-1').click();
      await page.getByRole('option', { name: `Nozzle ${edit}`, exact: true }).click();
    }
    await dialog.getByTestId('mapping-confirm').click();
    await expect(dialog).toHaveCount(0);
    await selectGcodeOutput(page, 'export', { timeout: 120_000 });
    await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 120_000 });
    const committed = (await responses('mutateNozzleMapping')).at(-1)!.result;
    const sliced = (await responses('slicePlate')).at(-1)!.result;
    expect(sliced.receipt.plateId).toBe(committed.snapshot.plateId);
    expect(sliced.receipt.inputStamp).toBe(committed.snapshot.revision);
    const downloading = page.waitForEvent('download');
    await page.getByTestId('btn-export').click();
    const downloaded = await downloading;
    expect(downloaded.suggestedFilename()).toMatch(/\.gcode$/);
    expect(extrudingTools(await readFile((await downloaded.path())!, 'utf8'))).toEqual([tool]);
  };
  await openProject(basename(source), sourceBytes);
  await page.getByTestId('printer-tab-multi').click();
  await page.getByTestId('toolhead-2').click();
  const capacity = page.getByTestId('nozzle-capacity');
  await expect(capacity).toHaveValue('4'); // Saved project wins over browser memory 99.
  await capacity.fill('6'); await capacity.press('Enter'); await expect(capacity).toBeEnabled();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('orca-slicer-neo:preferences')!)
    .rememberedNozzleCapacities['Bambu Lab H2D 0.4 nozzle'])).toEqual([9, 6]);
  await page.getByTestId('config-mode-plates').click();
  await page.getByTestId('plate-properties-mapping').click();
  await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 1');
  await sliceAndDownload(1, 2);
  await page.locator('#app-tab-prepare').click();
  const plateList = page.getByTestId('preview-plate-list');
  await plateList.getByRole('option', { name: /^Plate 2,/ }).click();
  await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
  await page.getByTestId('mapping-filament-1').click();
  await page.getByRole('option', { name: 'Nozzle 1', exact: true }).click();
  await expect(page.getByTestId('mapping-filament-1')).toBeEnabled();
  expect((await responses('mutateNozzleMapping')).at(-1)!.result.snapshot.saved.mode).toBe(2);
  const saving = page.waitForEvent('download');
  await page.keyboard.press('Control+Shift+s');
  const saved = await saving;
  expect(saved.suggestedFilename()).toMatch(/\.3mf$/);
  const archive = await readFile((await saved.path())!);
  const entries = readZipEntries(archive);
  const project = entries.find(entry => entry.name === 'Metadata/project_settings.config')!;
  expect(JSON.parse(new TextDecoder().decode(project.content)).extruder_ams_count).toEqual(['1#9', '1#6']);
  expect(entries.some(entry => /neo.*mapping/i.test(entry.name))).toBe(false);
  await openProject('mapping-browser-roundtrip.3mf', archive);
  await page.locator('#app-tab-prepare').click();
  await page.getByTestId('config-mode-plates').click();
  await page.getByTestId('plate-properties-mapping').click();
  await plateList.getByRole('option', { name: /^Plate 1,/ }).click();
  await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
  await plateList.getByRole('option', { name: /^Plate 2,/ }).click();
  await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 1');
  await sliceAndDownload(0);
  console.log('[nozzle-mapping-web]', JSON.stringify({ variant, assets: Object.fromEntries(assets),
    sourceSha256: hash(sourceBytes), savedSha256: hash(archive), savedBytes: archive.length }));
});
