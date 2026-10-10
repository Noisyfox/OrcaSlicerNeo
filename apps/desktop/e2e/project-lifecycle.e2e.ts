import { _electron } from './electron-fixture';
// Focused cross-host project lifecycle coverage. The renderer is built with
// VITE_USE_MOCK=1 by the desktop E2E command, so these tests exercise the
// actual Electron IPC/preload/adapter/shared-action boundary without a native
// WASM dependency.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

async function launchProjectApp(): Promise<{ app: ElectronApplication; projectPath: string; savePath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-project-e2e-'));
  const projectPath = join(dir, 'picked-project.3mf');
  const savePath = join(dir, 'saved-project.3mf');
  // The mock bridge validates that bytes exist, while the extension drives
  // the project picker/action path.
  copyFileSync(MODEL_PATH, projectPath);
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: projectPath,
    ORCA_E2E_PROJECT_SAVE: savePath,
    ORCA_E2E_LIFECYCLE: '1',
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return { app: await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env }), projectPath, savePath };
}

async function ready(page: Page): Promise<void> {
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
  await page.locator('#app-tab-prepare').click();
  await expect(page.getByTestId('preset-select')).toBeVisible();
}

async function openPickerProject(page: Page, app: ElectronApplication): Promise<void> {
  if (process.platform === 'darwin') {
    await app.evaluate(({ Menu }) => { const item=Menu.getApplicationMenu()!.getMenuItemById('file-open-project')!; item.click(); });
  } else {
  if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
    await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
    await page.getByTestId('titlebar-menu-trigger').click();
  }
  await page.getByTestId('menu-file-trigger').hover();
  await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
  await page.getByTestId('file-open-project').click();
  }
  await page.getByTestId('config-mode-scoped').click();
  await expect(page.getByTestId('object-list').getByRole('button', { name: 'picked-project.3mf' })).toBeVisible();
}

async function makeDirty(page: Page): Promise<void> {
  await page.getByTestId('btn-add-model').click();
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
}

test('opening a 3MF clears both previous Undo and Redo controls', async () => {
  const { app } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await openPickerProject(page, app);
    await makeDirty(page);
    await expect(page.getByTestId('history-undo')).toBeEnabled();
    await makeDirty(page);
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('history-undo')).toBeEnabled();
    await expect(page.getByTestId('history-redo')).toBeEnabled();

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+o' : 'Control+o');
    await expect(page.getByTestId('project-load-choice-dialog')).toBeVisible();
    await page.getByTestId('project-load-project').click();
    await page.getByTestId('project-load-confirm').click();
    await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
    await page.getByTestId('project-dirty-dont-save').click();
    await expect(page.getByTestId('project-dirty-dialog')).toBeHidden();
    await expect(page.getByTestId('history-undo')).toBeDisabled();
    await expect(page.getByTestId('history-redo')).toBeDisabled();
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('picked-project');

    await makeDirty(page);
    await expect(page.getByTestId('history-undo')).toBeEnabled();
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('history-undo')).toBeDisabled();
    await expect(page.getByTestId('history-redo')).toBeEnabled();
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
    await app.close();
  }
});

test('Electron picker and drop use shared project actions, and Save As writes a project', async () => {
  const { app, projectPath, savePath } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await openPickerProject(page, app);
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('picked-project');
    if (process.platform === 'darwin') {
      await expect.poll(() => app.evaluate(({ Menu }) => ({ save:Menu.getApplicationMenu()!.getMenuItemById('file-save-project')!.enabled, saveAs:Menu.getApplicationMenu()!.getMenuItemById('file-save-project-as')!.enabled }))).toEqual({save:false,saveAs:true});
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('file-save-project-as')!.click());
    } else {
    if (await page.getByTestId('titlebar-menu-trigger').getAttribute('aria-expanded') !== 'true') {
      await page.getByTestId('menu-file-trigger').waitFor({ state: 'detached' });
      await page.getByTestId('titlebar-menu-trigger').click();
    }
    await page.getByTestId('menu-file-trigger').hover();
    await page.locator('[data-slot=\"menubar-sub-content\"]').hover({ position: { x: 8, y: 8 } });
    await expect(page.getByTestId('file-save-project')).toBeDisabled();
    await expect(page.getByTestId('file-save-project-as')).toBeEnabled();
    await page.getByTestId('file-save-project-as').click();
    }
    await expect.poll(() => existsSync(savePath)).toBe(true);
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('saved-project');

    // A dropped 3MF over the object list enters the same Open Project action.
    // The nested list intentionally stops propagation for its own text drags;
    // this verifies an OS file drop is captured before that handler runs.
    await page.evaluate((path) => {
      const transfer = new DataTransfer();
      const file = new File([new Uint8Array([80, 75, 3, 4])], 'dropped.3mf');
      // Exercise Electron's native dropped-file path forwarding as well as
      // the capture listener. Real OS files carry this private property.
      Object.defineProperty(file, 'path', { value: path });
      transfer.items.add(file);
      const target = document.querySelector('[data-testid="object-list"]') ?? document;
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, projectPath);
    // Ask When Relevant is active and the opened picker project has a model,
    // so this visible dialog proves the drop reached the shared Open action.
    await expect(page.getByTestId('project-load-choice-dialog')).toBeVisible();
    await page.getByTestId('project-load-cancel').click();
    await expect(page.getByTestId('project-load-choice-dialog')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('Electron STL drop uses the shared Add Model action', async () => {
  const { app } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await page.getByTestId('config-mode-scoped').click();
    await expect(page.getByTestId('object-list')).toBeVisible();
    await page.evaluate(({ bytes }) => {
      const transfer = new DataTransfer();
      const file = new File([new Uint8Array(bytes)], 'cube.stl');
      // Electron receives the browser File and forwards only its bytes to the
      // shared Add Model/runtime path; native project paths stay 3MF-only.
      transfer.items.add(file);
      const target = document.querySelector('[data-testid="object-list"]') ?? document;
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, { bytes: Array.from(readFileSync(MODEL_PATH)) });
    await expect(page.getByTestId('btn-slice')).toBeEnabled();
  } finally {
    // The drop intentionally makes the session dirty; destroy the test
    // window so the lifecycle confirmation does not block teardown.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
    await app.close();
  }
});

test('Electron close requests honor Cancel then Save/Don\'t Save choices', async () => {
  const { app } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await openPickerProject(page, app);
    await makeDirty(page);

    if (process.platform === 'darwin') {
      await app.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()!.getMenuItemById('file-setup-wizard')!; item.click(item, undefined, undefined); });
    } else {
      await page.getByTestId('titlebar-menu-trigger').click();
      await page.getByTestId('menu-file-trigger').focus();
      await page.getByTestId('menu-file-trigger').press('ArrowRight');
      await page.getByTestId('file-setup-wizard').click();
    }
    const wizard = page.getByTestId('setup-wizard');
    await expect(wizard).toBeVisible();
    await expect(wizard.getByRole('button', { name: 'Exit', exact: true })).toHaveCount(0);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    // A later modal retains ownership of the existing dirty project.
    await page.waitForTimeout(100);
    await expect(wizard).toBeVisible();
    await expect(page.getByTestId('project-dirty-dialog')).toHaveCount(0);
    await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(wizard).toBeHidden();

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
    await page.getByTestId('project-dirty-cancel').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    const closed = page.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
    // The click closes the window. On Linux, Playwright can observe the page
    // closing before its click promise settles even though the action worked.
    const click = page.getByTestId('project-dirty-dont-save').click()
      .catch((error) => { if (!page.isClosed()) throw error; });
    await Promise.all([closed, click]);
  } finally {
    // The assertions above close the window. If a failure occurs earlier, the
    // lifecycle bridge still lets a clean renderer answer this teardown.
    await app.close();
  }
});
