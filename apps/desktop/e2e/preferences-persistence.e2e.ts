import { _electron } from './electron-fixture';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const PRINTER = 'Bambu Lab P1S 0.4 nozzle';
const PRESET_READY_TIMEOUT = 180_000;

async function launch(preferences: string, exportPath: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = {
    ...process.env, ORCA_E2E: '1', ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: exportPath, ORCA_E2E_PREFERENCES: preferences,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  const page = await app.firstWindow();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: PRESET_READY_TIMEOUT });
  await page.locator('#app-tab-prepare').click();
  const diagnostics: string[] = [];
  page.on('console', (message) => diagnostics.push(`[${message.type()}] ${message.text()}`));
  page.on('pageerror', (error) => diagnostics.push(`[pageerror] ${String(error)}`));
  for (const worker of page.workers()) worker.on('console', (message) => diagnostics.push(`[worker:${message.type()}] ${message.text()}`));
  page.on('worker', (worker) => worker.on('console', (message) => diagnostics.push(`[worker:${message.type()}] ${message.text()}`)));
  try {
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
  } catch (error) {
    console.error(`preference E2E readiness diagnostics:\n${diagnostics.join('\n')}`);
    throw error;
  }
  return { app, page };
}

test('persists independent titlebar sidebar toggles and restores their widths on restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-sidebar-toggles-'));
  const preferences = join(dir, 'preferences.json');
  const start = async () => {
    const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: PRESET_READY_TIMEOUT });
    await page.locator('#app-tab-prepare').click();
    await page.locator('#app-tab-preview').click();
    return { app, page };
  };
  const first = await start();
  try {
    const page = first.page;
    const left = page.locator('#workspace-sidebar');
    const right = page.getByTestId('preview-sidebar');
    const leftResizer = page.getByTestId('sidebar-resizer');
    const rightResizer = page.getByTestId('preview-sidebar-resizer');
    await expect(left).toBeVisible();
    await expect(right).toBeVisible();
    await leftResizer.focus();
    await leftResizer.press('ArrowRight');
    await expect(leftResizer).toHaveAttribute('aria-valuenow', '304');
    await expect.poll(() => JSON.parse(readFileSync(preferences, 'utf8')).ui.sidebarWidth).toBe(304);
    await rightResizer.focus();
    await rightResizer.press('ArrowLeft');
    await expect(rightResizer).toHaveAttribute('aria-valuenow', '336');
    await expect.poll(() => JSON.parse(readFileSync(preferences, 'utf8')).ui.rightSidebarWidth).toBe(336);
    const before = (await page.getByTestId('viewport').boundingBox())!.width;
    const retained = await left.elementHandle();
    await page.getByTestId('titlebar-toggle-left-sidebar').click();
    await page.getByTestId('titlebar-toggle-right-sidebar').click();
    await expect(left).toBeHidden();
    await expect(right).toBeHidden();
    await expect(leftResizer).toBeHidden();
    await expect(rightResizer).toBeHidden();
    expect(await retained!.evaluate((el) => el.isConnected)).toBe(true);
    expect((await page.getByTestId('viewport').boundingBox())!.width).toBeGreaterThan(before + 600);
    await expect.poll(() => {
      const ui = JSON.parse(readFileSync(preferences, 'utf8')).ui;
      return [ui.leftSidebarCollapsed, ui.rightSidebarCollapsed];
    }).toEqual([true, true]);
    await retained!.dispose();
  } finally { await first.app.close(); }
  const second = await start();
  try {
    const page = second.page;
    await expect(page.locator('#workspace-sidebar')).toBeHidden();
    await expect(page.getByTestId('preview-sidebar')).toBeHidden();
    await expect(page.getByTestId('titlebar-toggle-left-sidebar')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByTestId('titlebar-toggle-right-sidebar')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('titlebar-toggle-left-sidebar').click();
    await expect(page.locator('#workspace-sidebar')).toBeVisible();
    await expect(page.getByTestId('preview-sidebar')).toBeHidden();
    await expect(page.getByTestId('sidebar-resizer')).toHaveAttribute('aria-valuenow', '304');
    await page.getByTestId('titlebar-toggle-right-sidebar').click();
    await expect(page.getByTestId('preview-sidebar')).toBeVisible();
    await expect(page.getByTestId('preview-sidebar-resizer')).toHaveAttribute('aria-valuenow', '336');
  } finally { await second.app.close(); }
});

test('persists complete remembered filament colours on disk across restart', async () => {
  test.setTimeout(360_000);
  const dir = mkdtempSync(join(tmpdir(), 'orca-filament-memory-'));
  const preferences = join(dir, 'preferences.json');
  const rack = { version: 1, slots: [{ preset: 'Generic PLA @System', colour: '#11223388',
    native: { representative: '#11223388', multiColour: '#FF000088 #00FF00AA', type: '0' } }] };
  const first = await launch(preferences, join(dir, 'first.gcode'));
  try {
    await first.page.evaluate(async (value) => {
      const host = (window as unknown as { orca: { preferences: { load(): Promise<{ found: boolean; json: Record<string, unknown> }>; save(value: unknown): Promise<void> } } }).orca;
      const current = await host.preferences.load();
      await host.preferences.save({ ...current.json, version: 1, rememberedFilamentRacks: { 'Memory-only Printer': value } });
    }, rack);
    await expect.poll(() => JSON.parse(readFileSync(preferences, 'utf8')).rememberedFilamentRacks?.['Memory-only Printer']).toEqual(rack);
  } finally { await first.app.close(); }
  const second = await launch(preferences, join(dir, 'second.gcode'));
  try {
    const restored = await second.page.evaluate(async () =>
      (window as unknown as { orca: { preferences: { load(): Promise<{ json: { rememberedFilamentRacks: Record<string, unknown> } }> } } }).orca
        .preferences.load());
    expect(restored.json.rememberedFilamentRacks['Memory-only Printer']).toEqual(rack);
  } finally { await second.app.close(); }
});

test('persists shared profile/sidebar preferences but not session work', async () => {
  test.setTimeout(360_000);
  const dir = mkdtempSync(join(tmpdir(), 'orca-preferences-e2e-'));
  const preferences = join(dir, 'preferences.json');
  const firstExport = join(dir, 'first.gcode');
  const secondExport = join(dir, 'second.gcode');
  const first = await launch(preferences, firstExport);
  try {
    const printer = first.page.getByTestId('preset-select');
    await printer.click();
    await first.page.getByPlaceholder('Search presets…').fill(PRINTER);
    await first.page.getByRole('option', { name: PRINTER }).click();
    await expect(printer).toContainText(PRINTER);

    const resizer = first.page.getByTestId('sidebar-resizer');
    await resizer.focus();
    await resizer.press('ArrowRight');
    await resizer.press('ArrowRight');
    await expect(resizer).toHaveAttribute('aria-valuenow', '320');

    // These are deliberately session-only: they must disappear after relaunch.
    await first.page.getByTestId('btn-add-model').click();
    await expect(first.page.getByTestId('btn-slice')).toBeEnabled();
    const layerHeight = first.page.locator('#layer_height');
    if (await layerHeight.count()) await layerHeight.fill('0.21');
    await first.page.getByTestId('btn-slice').click();
    await expect(first.page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 10_000 });
    await first.page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(firstExport)).toBe(true);
  } finally {
    await first.app.close();
  }

  const second = await launch(preferences, secondExport);
  try {
    await expect(second.page.getByTestId('preset-select')).toContainText(PRINTER);
    await expect(second.page.getByTestId('sidebar-resizer')).toHaveAttribute('aria-valuenow', '320');
    await expect(second.page.getByTestId('btn-add-model')).toBeEnabled();
    await expect(second.page.getByTestId('btn-slice')).toBeDisabled();
    await expect(second.page.getByTestId('btn-export')).toHaveCount(0);
    if (await second.page.locator('#layer_height').count()) {
      await expect(second.page.locator('#layer_height')).not.toHaveValue('0.21');
    }
    expect(existsSync(secondExport)).toBe(false);
  } finally {
    await second.app.close();
  }
});
