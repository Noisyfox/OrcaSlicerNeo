import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
