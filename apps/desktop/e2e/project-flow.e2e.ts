import { _electron } from './electron-fixture';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { openProjectMenu, waitForProjectLoad } from './project-menu';
import { installSliceReceiptObserver, readSliceReceipts } from './runtime-receipts';

test('Sidebar flow publishes one receipt, keeps configuration mode, and persists only explicit selection memory', async () => {
  test.skip(process.env.ORCA_E2E_REAL === '1', 'This focused journey uses the deterministic mock; native integration has its own gate');
  const file = join(mkdtempSync(join(tmpdir(), 'neo-flow-memory-')), 'preferences.json');
  writeFileSync(file, JSON.stringify({ version: 1, ui: { sidebarWidth: 320 },
    colorPicker: { favorites: [{ kind: 'solid', color: '#112233' }] } }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: file } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  const memory = () => JSON.parse(readFileSync(file, 'utf8')).rememberedProjectFlows;
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await installSliceReceiptObserver(page, ['setProjectFlow', 'selectPrinterWithRememberedRack', 'setToolheadDiameter', 'mutatePresetDraft']);
    const flow = page.getByTestId('nozzle-flow-select');
    await expect(flow).toBeEnabled();
    await expect(flow).toContainText('Standard');
    const printer = await page.getByTestId('preset-select').getAttribute('title');
    await page.getByTestId('config-mode-plates').click();
    await flow.click(); await page.getByRole('option', { name: 'High Flow', exact: true }).click();
    await expect(flow).toContainText('High Flow');
    await expect(flow).toBeEnabled();
    await expect(page.getByTestId('config-mode-plates')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('preset-select')).toHaveAttribute('title', printer!);
    await expect(() => expect(Object.values(memory())).toEqual([[1]])).toPass();
    const afterManual = memory();
    await page.getByTestId('history-undo').click();
    await expect(flow).toContainText('Standard');
    await expect(page.getByTestId('config-mode-plates')).toHaveAttribute('aria-selected', 'true');
    expect(memory()).toEqual(afterManual);
    await page.getByTestId('history-redo').click();
    await expect(flow).toContainText('High Flow');
    await expect(page.getByTestId('config-mode-plates')).toHaveAttribute('aria-selected', 'true');
    expect(memory()).toEqual(afterManual);
    await flow.click(); await page.getByRole('option', { name: 'Hybrid', exact: true }).click();
    await expect(flow).toContainText('Hybrid');
    await expect(() => expect(Object.values(memory())).toEqual([[0]])).toPass();
    await expect(page.getByTestId('config-mode-plates')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('preset-edit-printer').click();
    await expect(page.getByTestId('preset-editor-title')).toBeVisible();
    await page.getByTestId('preset-editor-page-tab-extruder').click();
    await page.getByTestId('preset-editor-close').click();
    await expect(flow).toContainText('Hybrid');
    expect(Object.values(memory())).toEqual([[0]]);
    const receipts = await readSliceReceipts(page) as any[];
    expect(receipts.filter(row => row.direction === 'request').map(row => row.op)).toEqual(['setProjectFlow', 'setProjectFlow']);
    const responses = receipts.filter(row => row.direction === 'response');
    expect(responses).toHaveLength(2);
    for (const response of responses) expect(response.result).toMatchObject({ ok: true,
      mutation: { kind: 'set-project-flow', historyEntryDelta: 1 }, historyStatus: { dirty: true } });
    // The rendered dirty protection proves that this changed the project.
    await page.getByTestId('titlebar-menu-trigger').click();
    await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot="menubar-sub-content"]').hover({ position: { x: 8, y: 8 } });
    await page.getByTestId('file-new-project').click();
    await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
    await page.getByTestId('project-dirty-dont-save').click();
    await expect(flow).toContainText('Standard');
    await expect(page.getByTestId('history-undo')).toBeDisabled();
    expect(Object.values(memory())).toEqual([[0]]);
    await page.reload();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    await page.locator('#app-tab-prepare').click();
    await expect(flow).toContainText('Standard');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    expect(stored.colorPicker.favorites).toEqual([{ kind: 'solid', color: '#112233' }]);
    expect(Object.values(stored.rememberedProjectFlows)).toEqual([[0]]);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
    await app.close();
  }
});

// One native primary-host journey; the mock test above remains the fast UI gate.
test('real Sidebar flow lifecycle preserves native contexts, file priority, repair dirty state and save/reopen', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires fresh real artifacts and native-exported flow fixtures');
  const root = resolve(__dirname, '../../..');
  const fixtures = resolve(process.env.ORCA_E2E_FLOW_FIXTURES ?? join(root, '.vitest/flow-increment5-fixtures'));
  const valid = join(fixtures, 'valid-flow.3mf'), invalid = join(fixtures, 'invalid-flow.3mf');
  expect(existsSync(valid) && existsSync(invalid)).toBe(true);
  const variant = process.env.ORCA_E2E_FLOW_EXPECT_VARIANT ?? 'serial';
  expect(['serial', 'threaded']).toContain(variant);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const name of ['orca_slice.js', 'orca_slice.wasm', 'orca_slice.data']) {
    const relative = `${variant}/${name}`;
    const source = join(root, 'packages/slicer-wasm/out', relative);
    expect(hash(join(root, 'apps/desktop/src/renderer/public/wasm', relative))).toBe(hash(source));
    expect(hash(join(root, 'apps/desktop/out/renderer/wasm', relative))).toBe(hash(source));
  }
  console.log('real flow artifact', JSON.stringify({ variant, sha256: hash(join(root, `packages/slicer-wasm/out/${variant}/orca_slice.wasm`)) }));
  const directory = mkdtempSync(join(tmpdir(), 'neo-real-flow-'));
  const preferencesFile = join(directory, 'preferences.json');
  const base = 'Bambu Lab H2D 0.4 nozzle';
  writeFileSync(preferencesFile, JSON.stringify({ version: 1, rememberedProjectFlows: { [base]: [0, 0] },
    selectedProfiles: { printer: base }, ui: { sidebarWidth: 340 } }));
  const memory = () => JSON.parse(readFileSync(preferencesFile, 'utf8')).rememberedProjectFlows;
  const lastResult = async (page: Page, op: string) => {
    const receipts = await readSliceReceipts(page) as any[];
    return receipts.filter(row => row.direction === 'response' && row.op === op && row.result?.ok).at(-1)?.result;
  };
  const status = (page: Page) => page.evaluate(() => (window as any).__orcaScopedConfigurationGate.snapshot().status);
  const launch = async (source: string, save: string) => {
    const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_MODEL: source,
      ORCA_E2E_PROJECT_SAVE: save, ORCA_E2E_PREFERENCES: preferencesFile } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
      await page.waitForFunction(() => Boolean((window as any).__orcaScopedConfigurationGate));
      expect((await page.evaluate(() => (window as any).__orcaScopedConfigurationGate.execution())).threaded).toBe(variant === 'threaded');
      expect(page.workers()).toHaveLength(0);
      await page.locator('#app-tab-prepare').click();
      await installSliceReceiptObserver(page, ['setProjectFlow', 'getPrintConfigEditor', 'getScopedConfigEditor', 'markHistorySaved', 'exportProject']);
      const originalHash = hash(source);
      await openProjectMenu(page, app); await waitForProjectLoad(page);
      const receipt = await page.evaluate(() => (window as any).__orcaE2e.projectLoadEvidence().receipt);
      expect(receipt).toMatchObject({ sourceDisplayName: basename(source), sourceByteLength: statSync(source).size,
        nativeResult: { ok: true, mode: 'project', plateCount: 2 } });
      expect(hash(source), 'opening/repair never writes the source file').toBe(originalHash);
      console.log('real flow load', JSON.stringify({ file: receipt.sourceDisplayName, bytes: receipt.sourceByteLength,
        flows: receipt.nativeResult.presetSnapshot?.project_config?.nozzle_volume_type, dirty: receipt.nativeResult.historyStatus?.dirty }));
      return { app, page, receipt };
    } catch (error) { await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy()); await app.close(); throw error; }
  };
  const close = async (app: ElectronApplication) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy()); await app.close();
  };
  const selectHead = async (page: Page, head: number) => {
    await page.getByTestId('printer-tab-multi').click(); await page.getByTestId(`toolhead-${head}`).click();
  };
  const selectFlow = async (page: Page, label: string) => {
    await page.getByTestId('toolhead-flow-select').click();
    await page.getByRole('option', { name: label, exact: true }).click();
    await expect(page.getByTestId('toolhead-flow-select')).toContainText(label);
    await expect(page.getByTestId('toolhead-flow-select')).toBeEnabled();
  };
  const context = async (page: Page, op: string, expected: number[][]) => {
    await expect.poll(async () => (await lastResult(page, op))?.editorSelection?.choices.map((choice: any) => [choice.extruderIndex, choice.flowType])).toEqual(expected);
    await expect(page.getByTestId('print-editor-selection').locator('[data-slot="toggle-group-item"]')).toHaveCount(expected.length);
  };
  const saveAs = async (page: Page, path: string) => {
    await page.getByTestId('titlebar-menu-trigger').click(); await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot="menubar-sub-content"]').hover({ position: { x: 8, y: 8 } });
    await page.getByTestId('file-save-project-as').click();
    await expect.poll(() => existsSync(path)).toBe(true);
    await expect.poll(async () => (await status(page)).dirty).toBe(false);
  };
  const saved = join(directory, 'saved-flow.3mf');
  let host = await launch(valid, saved);
  try {
    expect(host.receipt.nativeResult.presetSnapshot.project_config.nozzle_volume_type).toBe('High Flow,Hybrid');
    expect(host.receipt.nativeResult.historyStatus.dirty).toBe(false);
    expect(memory()[base]).toEqual([0, 0]);
    await context(host.page, 'getPrintConfigEditor', [[0, 1], [1, 0], [1, 1]]);
    await selectHead(host.page, 1);
    await host.page.getByTestId('toolhead-flow-select').click();
    await expect(host.page.getByRole('option', { name: 'E3D High Flow', exact: true })).toBeVisible();
    await host.page.getByRole('option', { name: 'Standard', exact: true }).click();
    await expect(host.page.getByTestId('toolhead-flow-select')).toContainText('Standard');
    await context(host.page, 'getPrintConfigEditor', [[0, 0], [1, 0], [1, 1]]);
    // Selecting the actual imported object exercises the rendered Scoped context.
    await host.page.getByTestId('config-mode-scoped').click();
    const objects = await host.page.evaluate(() => (window as any).__orcaScopedConfigurationGate.snapshot().objects);
    await host.page.getByTestId(`object-${objects[0].id}`).locator(':scope > div > button.object-list-row').click({ position: { x: 50, y: 10 } });
    await host.page.getByTestId('config-page-Speed').click();
    await context(host.page, 'getScopedConfigEditor', [[0, 0], [1, 0], [1, 1]]);
    await selectHead(host.page, 2); await selectFlow(host.page, 'High Flow');
    await context(host.page, 'getScopedConfigEditor', [[0, 0], [1, 1]]);
    await expect(host.page.getByTestId('config-mode-scoped')).toHaveAttribute('aria-selected', 'true');
    await expect(host.page.getByTestId('toolhead-2')).toHaveAttribute('aria-pressed', 'true');
    await expect(() => expect(memory()[base]).toEqual([0, 1])).toPass();
    await host.page.getByTestId('history-undo').click();
    await expect(host.page.getByTestId('toolhead-flow-select')).toContainText('Hybrid');
    await context(host.page, 'getScopedConfigEditor', [[0, 0], [1, 0], [1, 1]]);
    await expect(host.page.getByTestId('toolhead-2')).toHaveAttribute('aria-pressed', 'true');
    expect(memory()[base]).toEqual([0, 1]);
    await host.page.getByTestId('history-redo').click();
    await expect(host.page.getByTestId('toolhead-flow-select')).toContainText('High Flow');
    await context(host.page, 'getScopedConfigEditor', [[0, 0], [1, 1]]);
    await selectFlow(host.page, 'Hybrid');
    await expect(() => expect(memory()[base]).toEqual([0, 0])).toPass();
    await host.page.screenshot({ path: join(root, '.vitest/flow-increment5-real-sidebar.png') });
    await saveAs(host.page, saved);
    const savedConfig = JSON.parse(new TextDecoder().decode(unzipSync(readFileSync(saved))['Metadata/project_settings.config']));
    expect(savedConfig.nozzle_volume_type).toEqual(['Standard', 'Hybrid']);
    const originalConfig = JSON.parse(new TextDecoder().decode(unzipSync(readFileSync(valid))['Metadata/project_settings.config']));
    expect(savedConfig.inherits_group).toEqual(originalConfig.inherits_group);
    expect(savedConfig.printer_settings_id).toBe(originalConfig.printer_settings_id);
    expect(savedConfig.filament_volume_map).toEqual(['0', '0']);
  } finally { await close(host.app); }
  const prefs = JSON.parse(readFileSync(preferencesFile, 'utf8')); prefs.rememberedProjectFlows[base] = [1, 1]; writeFileSync(preferencesFile, JSON.stringify(prefs));
  host = await launch(saved, join(directory, 'unused.3mf'));
  try {
    expect(host.receipt.nativeResult.presetSnapshot.project_config.nozzle_volume_type).toBe('Standard,Hybrid');
    expect(host.receipt.nativeResult.historyStatus.dirty).toBe(false);
    expect(memory()[base]).toEqual([1, 1]);
    await context(host.page, 'getPrintConfigEditor', [[0, 0], [1, 0], [1, 1]]);
  } finally { await close(host.app); }
  const repaired = join(directory, 'saved-repair.3mf');
  host = await launch(invalid, repaired);
  try {
    expect(host.receipt.nativeResult.presetSnapshot.project_config.nozzle_volume_type).toBe('Standard,High Flow');
    expect(host.receipt.nativeResult.historyStatus).toMatchObject({ dirty: true, savedCheckpoint: null, undoEntries: [] });
    expect(memory()[base]).toEqual([1, 1]);
    await expect(host.page.getByTestId('history-undo')).toBeDisabled();
    await saveAs(host.page, repaired);
  } finally { await close(host.app); }
  host = await launch(repaired, join(directory, 'unused-repair.3mf'));
  try {
    expect(host.receipt.nativeResult.presetSnapshot.project_config.nozzle_volume_type).toBe('Standard,High Flow');
    expect(host.receipt.nativeResult.historyStatus.dirty).toBe(false);
    expect(memory()[base]).toEqual([1, 1]);
  } finally { await close(host.app); }
});
