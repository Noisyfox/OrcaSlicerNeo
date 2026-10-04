// Cross-host menu contract exercised through the shared Electron titlebar.
// This intentionally uses the existing mock bridge so the test proves the
// renderer/host boundary without requiring a real WASM build.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

async function launchMenuApp(): Promise<ElectronApplication> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-titlebar-e2e-'));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: join(dir, 'out.gcode'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
}

async function openFileMenu(page: Page): Promise<void> {
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
  await expect(page.getByTestId('file-add-model')).toBeVisible();
}

// The custom titlebar dropdown exists only on Windows/Linux; macOS replaces
// it with the native application menu (covered by native-menu.e2e.ts).
const testCustom = process.platform === 'darwin' ? test.skip : test;

testCustom('Windows/Linux custom titlebar tracks shared model and result state', async () => {
  const app = await launchMenuApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    const beforePages = page.getByTestId('titlebar-divider-before-pages');
    const afterPages = page.getByTestId('titlebar-divider-after-pages');
    await expect(beforePages).toHaveCount(1);
    await expect(afterPages).toHaveCount(1);
    await expect(beforePages).toBeHidden();
    await page.locator('#app-tab-device').click();
    await expect(afterPages).toBeHidden();
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('titlebar')).toBeVisible();
    await expect(page.getByTestId('titlebar-menu')).toBeVisible();
    await expect(page.getByTestId('titlebar-menu-trigger')).toHaveClass(/no-drag/);
    await expect(beforePages).toBeVisible();
    await expect(afterPages).toBeVisible();
    const layout = await page.getByTestId('titlebar').evaluate((bar) => {
      const tab = bar.querySelector('#app-tab-prepare')!.getBoundingClientRect();
      const center = tab.y + tab.height / 2;
      const icons = ['#app-tab-prepare svg', '[data-testid="titlebar-menu-trigger"] svg', '[data-testid="titlebar-save-project"] svg', '[data-testid="history-undo"] svg', '[data-testid="history-redo"] svg'];
      return {
        height: bar.getBoundingClientRect().height,
        offsets: icons.map((selector) => { const r = bar.querySelector(selector)!.getBoundingClientRect(); return r.y + r.height / 2 - center; }),
        lines: Array.from(bar.querySelectorAll(':scope > [data-slot="separator"]')).map((line) => line.getBoundingClientRect().width),
      };
    });
    expect(layout.height).toBe(32);
    layout.offsets.forEach((offset) => expect(Math.abs(offset)).toBeLessThanOrEqual(0.5));
    expect(layout.lines).toEqual([1, 1, 1, 1]);
    await expect(page.getByTestId('titlebar-save-project')).toBeDisabled();


    await expect(page.getByTestId('preset-select')).toBeVisible();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    await openFileMenu(page);

    await expect(page.getByTestId('file-add-model')).toBeEnabled();
    await expect(page.getByTestId('file-clear-scene')).toBeDisabled();
    await expect(page.getByTestId('file-slice')).toBeDisabled();
    await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
    await expect(page.getByTestId('file-quit')).toHaveText('Exit');
    await expect(page.getByTestId('file-quit')).toBeEnabled();
    await page.getByTestId('file-add-model').click();

    await expect(page.getByTestId('btn-slice')).toBeEnabled();
    await expect(page.getByTestId('titlebar-save-project')).toBeEnabled();
    await openFileMenu(page);
    await expect(page.getByTestId('file-add-model')).toBeEnabled();
    await expect(page.getByTestId('file-clear-scene')).toBeEnabled();
    await expect(page.getByTestId('file-slice')).toBeEnabled();
    await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
    await page.getByTestId('file-slice').click();

    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
    await openFileMenu(page);
    await expect(page.getByTestId('file-export-gcode')).toBeEnabled();

    // Slice enters passive Preview; scene-mutating menu commands become
    // available again only after returning to Prepare.
    await page.keyboard.press('Escape'); // Close File submenu.
    await page.keyboard.press('Escape'); // Close application menu.
    await expect(page.getByTestId('titlebar-menu-trigger')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#app-tab-prepare').click();
    await openFileMenu(page);
    await page.getByTestId('file-clear-scene').click();
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await openFileMenu(page);
    await expect(page.getByTestId('file-clear-scene')).toBeDisabled();
    await expect(page.getByTestId('file-slice')).toBeDisabled();
    await expect(page.getByTestId('file-export-gcode')).toBeDisabled();
  } finally {
    await app.close();
  }
});

testCustom('Help opens one floating File Manager that can navigate, move, resize, and reopen at root', async () => {
  const app = await launchMenuApp();
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-help-trigger').hover();
    const openCommand = page.getByTestId('help-file-manager');
    await expect(openCommand).toBeEnabled();
    await openCommand.click();

    const manager = page.getByTestId('file-manager-window');
    const path = page.getByTestId('file-manager-path');
    await expect(manager).toBeVisible();
    await expect(path).toHaveText('/');
    await expect(page.getByTestId('file-manager-parent')).toHaveAttribute('aria-disabled', 'true');

    const directory = page.locator('[data-testid^="file-manager-entry-"][data-entry-type="directory"]').first();
    await expect(directory).toBeVisible();
    await directory.dblclick();
    await expect(path).not.toHaveText('/');
    const visitedPath = await path.textContent();

    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }

    await page.getByTestId('menu-help-trigger').hover();
    await page.getByTestId('help-file-manager').click();
    await expect(page.getByTestId('file-manager-window')).toHaveCount(1);
    await expect(manager).toBeFocused();
    await expect(path).toHaveText(visitedPath ?? '');

    const beforeMove = await manager.boundingBox();
    const titlebar = page.getByTestId('file-manager-titlebar');
    const titlebarBox = await titlebar.boundingBox();
    expect(beforeMove).not.toBeNull();
    expect(titlebarBox).not.toBeNull();
    await page.mouse.move(titlebarBox!.x + 100, titlebarBox!.y + 18);
    await page.mouse.down();
    await page.mouse.move(titlebarBox!.x + 140, titlebarBox!.y + 48);
    await page.mouse.up();
    const afterMove = await manager.boundingBox();
    expect(afterMove!.x).toBeGreaterThan(beforeMove!.x);

    const beforeResize = await manager.boundingBox();
    await page.getByTestId('file-manager-resize').hover();
    await page.mouse.move(beforeResize!.x + beforeResize!.width - 8, beforeResize!.y + beforeResize!.height - 8);
    await page.mouse.down();
    await page.mouse.move(beforeResize!.x + beforeResize!.width + 60, beforeResize!.y + beforeResize!.height + 60);
    await page.mouse.up();
    const afterResize = await manager.boundingBox();
    expect(afterResize!.width).toBeGreaterThan(beforeResize!.width);
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    expect(afterResize!.x + afterResize!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(afterResize!.y + afterResize!.height).toBeLessThanOrEqual(viewport.height + 1);

    await page.getByTestId('file-manager-close').click();
    await expect(manager).toHaveCount(0);
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-help-trigger').hover();
    await page.getByTestId('help-file-manager').click();
    await expect(page.getByTestId('file-manager-path')).toHaveText('/');
  } finally {
    await app.close();
  }
});
