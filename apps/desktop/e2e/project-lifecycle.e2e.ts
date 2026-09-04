// Focused cross-host project lifecycle coverage. The renderer is built with
// VITE_USE_MOCK=1 by the desktop E2E command, so these tests exercise the
// actual Electron IPC/preload/adapter/shared-action boundary without a native
// WASM dependency.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
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

async function openPickerProject(page: Page): Promise<void> {
  await page.getByTestId('menu-file-trigger').click();
  await page.getByTestId('file-open-project').click();
  await expect(page.getByTestId('file-save-project-as')).toBeAttached();
}

async function makeDirty(page: Page): Promise<void> {
  await page.getByTestId('btn-add-model').click();
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
}

test('Electron picker and drop use shared project actions, and Save As writes a project', async () => {
  const { app, savePath } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await openPickerProject(page);
    await page.getByTestId('menu-file-trigger').click();
    await expect(page.getByTestId('file-save-project')).toBeDisabled();
    await expect(page.getByTestId('file-save-project-as')).toBeEnabled();
    await page.getByTestId('file-save-project-as').click();
    await expect.poll(() => existsSync(savePath)).toBe(true);

    // A dropped 3MF enters the same Open Project action and therefore exposes
    // the same Save As state, rather than taking an Add Model-only shortcut.
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array([80, 75, 3, 4])], 'dropped.3mf'));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.getByTestId('file-save-project-as')).toBeAttached();
  } finally {
    await app.close();
  }
});

test('Electron close requests honor Cancel then Save/Don\'t Save choices', async () => {
  const { app } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await openPickerProject(page);
    await makeDirty(page);

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
    await page.getByTestId('project-dirty-cancel').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    const closed = page.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
    await page.getByTestId('project-dirty-dont-save').click();
    await closed;
  } finally {
    // The assertions above close the window. If a failure occurs earlier, the
    // lifecycle bridge still lets a clean renderer answer this teardown.
    await app.close();
  }
});
