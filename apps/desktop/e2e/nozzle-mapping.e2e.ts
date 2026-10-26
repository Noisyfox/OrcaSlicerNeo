import { extrudingTools } from '../../../packages/slicer-wasm/harness/nozzle-mapping-gcode.mjs';
import { _electron } from './electron-fixture';
import { test, expect } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { openProjectMenu, waitForProjectLoad } from './project-menu';
import { installSliceReceiptObserver, readSliceReceipts } from './runtime-receipts';

test('real nozzle mapping edits, confirms, cancels and slices with native Plate ownership', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1' || !process.env.ORCA_E2E_MAPPING_PROJECT,
    'requires the native nozzle-mapping persistence fixture and current WASM');
  const root = resolve(__dirname, '../../..');
  const variant = process.env.ORCA_E2E_MAPPING_VARIANT ?? 'serial';
  const source = process.env.ORCA_E2E_MAPPING_PROJECT!;
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const file of ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data'])
    expect(hash(join(root, 'apps/desktop/out/renderer/wasm', variant, file))).toBe(hash(join(root, 'packages/slicer-wasm/out', variant, file)));
  const directory = mkdtempSync(join(tmpdir(), 'neo-mapping-ui-'));
  const preferences = join(directory, 'preferences.json');
  const exported = join(directory, 'mapping.gcode');
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: { printer: 'Bambu Lab H2D 0.4 nozzle' },
    projectLoadBehaviour: 'load_all', ui: { sidebarWidth: 340 } }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_MODEL: source,
    ORCA_E2E_PREFERENCES: preferences, ORCA_E2E_EXPORT: exported } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300000 });
    await page.locator('#app-tab-prepare').click();
    expect(await page.evaluate(async () => (await (window as any).__orcaScopedConfigurationGate.execution()).threaded))
      .toBe(variant === 'threaded');
    await installSliceReceiptObserver(page, ['getNozzleMapping', 'mutateNozzleMapping', 'slicePlate', 'exportGcodePlate']);
    await openProjectMenu(page, app); await waitForProjectLoad(page);
    await expect.poll(() => page.evaluate(() => (window as any).__orcaE2e.projectLoadEvidence().receipt))
      .toMatchObject({ sourceDisplayName: basename(source), sourceByteLength: statSync(source).size,
        nativeResult: { ok: true, mode: 'project' } });
    if (await page.getByTestId('project-notice-dialog-close').isVisible()) await page.getByTestId('project-notice-dialog-close').click();
    await expect.poll(async () => (await readSliceReceipts(page) as any[]).some(r => r.op === 'getNozzleMapping' && r.result?.eligible)).toBe(true);
    await page.getByTestId('config-mode-plates').click();
    await page.getByTestId('plate-properties-mapping').click();
    await expect(page.getByTestId('mapping-mode')).toContainText('Manual');
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 1');
    await expect(page.getByTestId('mapping-filament-2')).toHaveCount(0);
    await page.getByTestId('mapping-filament-1').click();
    await page.getByRole('option', { name: 'Nozzle 2', exact: true }).click();
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
    await expect(page.getByTestId('mapping-filament-1')).toBeEnabled();
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 1');
    await page.getByTestId('history-redo').click();
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
    await page.getByTestId('printer-tab-multi').click();
    const capacity = page.getByTestId('nozzle-capacity');
    await expect(capacity).toHaveValue('9');
    // Capture intermediate DOM gaps, not only the settled state after a read.
    await page.evaluate(() => {
      const multi = document.querySelector('#printer-multi-content')!;
      const height = multi.getBoundingClientRect().height;
      const gaps: number[] = [];
      const observer = new MutationObserver(() => {
        const current = multi.querySelector('[data-testid="nozzle-capacity"]')
          ? multi.getBoundingClientRect().height : 0;
        if (current !== height) gaps.push(current);
      });
      observer.observe(multi, { childList: true, subtree: true });
      (window as any).__orcaCapacityLayout = () => { observer.disconnect(); return gaps; };
    });
    for (const [head, value] of [[2, '4'], [1, '9'], [2, '4']] as const) {
      await page.getByTestId(`toolhead-${head}`).click();
      await expect(capacity).toHaveValue(value);
    }
    expect(await page.evaluate(() => (window as any).__orcaCapacityLayout())).toEqual([]);
    await capacity.fill('6'); await capacity.press('Enter');
    await expect(capacity).toBeEnabled();
    await expect.poll(() => Object.values(JSON.parse(readFileSync(preferences, 'utf8')).rememberedNozzleCapacities ?? {})).toEqual([[9, 6]]);
    await page.getByTestId('output-mode-select').click();
    await page.getByRole('option', { name: 'Auto For Flush', exact: true }).click();
    await expect(page.getByTestId('mapping-mode')).toContainText('Auto For Flush');
    await expect(page.getByTestId('mapping-materials')).toHaveCount(0);
    await expect(page.getByTestId('output-mode-select')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('mapping-mode')).toBeEnabled();
    await page.getByTestId('mapping-mode').click();
    await page.getByTestId('mapping-mode-options').getByRole('option', { name: 'Manual', exact: true }).click();
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
    await page.getByTestId('preview-plate-list').getByRole('option', { name: /^Plate 2,/ }).click();
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
    await expect(page.getByTestId('mapping-filament-1')).toBeEnabled();
    const receipts = await readSliceReceipts(page) as any[];
    const edits = receipts.filter(r => r.op === 'mutateNozzleMapping' && r.direction === 'response');
    expect(edits).toHaveLength(4);
    expect(edits.every(r => r.result?.ok && r.result?.changed)).toBe(true);
    expect(edits[0].result.plateSession.affectedPlateIds).toHaveLength(1);
    expect(edits[1].result.plateSession.affectedPlateIds).toHaveLength(2);
    expect(receipts.some(r => r.op === 'slicePlate')).toBe(false);
    await page.screenshot({ path: join(directory, 'sidebar.png') });
    const responses = async (op: string) => (await readSliceReceipts(page) as any[]).filter(r => r.op === op && r.direction === 'response');
    const dialog = page.getByTestId('mapping-confirmation');
    const confirmSlice = async () => {
      await dialog.getByTestId('mapping-confirm').click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('btn-export')).toBeEnabled({ timeout: 180000 });
    };
    const exportTools = async (tools: number[]) => {
      if (existsSync(exported)) unlinkSync(exported);
      await page.getByTestId('btn-export').click();
      await expect.poll(() => existsSync(exported), { timeout: 30000 }).toBe(true);
      expect(extrudingTools(readFileSync(exported, 'utf8'))).toEqual(tools);
    };
    // Toolbar -> Preview joins the Preview-entry request while the dialog is open.
    await page.getByTestId('btn-slice').click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('mapping-filament-1').click();
    await page.getByRole('option', { name: 'Nozzle 1', exact: true }).click();
    await dialog.getByTestId('mapping-cancel').click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(dialog).toHaveCount(0);
    expect(await responses('mutateNozzleMapping')).toHaveLength(4);
    expect(await responses('slicePlate')).toHaveLength(0);
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 2');
    // No-op confirmation retains imported Nozzle Manual and adds no history.
    await page.getByTestId('btn-slice').click(); await expect(dialog).toBeVisible();
    await confirmSlice();
    const noop = (await responses('mutateNozzleMapping')).at(-1)!.result;
    expect(noop).toMatchObject({ ok: true, changed: false, snapshot: { saved: { mode: 3 } } });
    expect(noop.historyStatus.revision).toBe(edits.at(-1).result.historyStatus.revision);
    await exportTools([1]);
    await page.locator('#app-tab-prepare').click(); await page.locator('#app-tab-preview').click();
    await expect(page.getByTestId('btn-export')).toBeEnabled();
    await expect(dialog).toHaveCount(0); expect(await responses('slicePlate')).toHaveLength(1);
    // Editing in Preview invalidates without navigation or eager slicing.
    await page.getByTestId('mapping-filament-1').click();
    await page.getByRole('option', { name: 'Nozzle 1', exact: true }).click();
    await expect(page.getByTestId('mapping-filament-1')).toContainText('Nozzle 1');
    await expect(page.getByTestId('mapping-filament-1')).toBeEnabled();
    expect((await responses('mutateNozzleMapping')).at(-1)!.result.snapshot.saved.mode).toBe(2);
    await expect(page.locator('#app-tab-preview')).toHaveAttribute('aria-selected', 'true');
    await expect(dialog).toHaveCount(0); expect(await responses('slicePlate')).toHaveLength(1);
    await page.getByTestId('btn-slice').click(); await expect(dialog).toBeVisible();
    await dialog.getByTestId('mapping-filament-1').click();
    await page.getByRole('option', { name: 'Nozzle 2', exact: true }).click();
    await confirmSlice();
    const confirmed = (await responses('mutateNozzleMapping')).at(-1)!.result;
    const sliced = (await responses('slicePlate')).at(-1)!.result;
    expect(confirmed.changed).toBe(true);
    expect(sliced.receipt.plateId).toBe(confirmed.snapshot.plateId);
    expect(sliced.receipt.inputStamp).toBe(confirmed.snapshot.revision);
    await exportTools([1]);
    // A direct Preview entry with invalid results prompts once; Cancel stays cancelled.
    await capacity.fill('7'); await capacity.press('Enter'); await expect(capacity).toBeEnabled();
    await page.locator('#app-tab-prepare').click(); await page.locator('#app-tab-preview').click();
    await expect(dialog).toBeVisible(); await dialog.getByTestId('mapping-cancel').click();
    await expect(dialog).toHaveCount(0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(dialog).toHaveCount(0); expect(await responses('slicePlate')).toHaveLength(2);
    console.log('native nozzle mapping journey', JSON.stringify({ variant, projectSha256: hash(source), wasm: hash(join(root, 'packages/slicer-wasm/out', variant, 'orca_slice.wasm')), directory }));
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy()); await app.close();
  }
});
