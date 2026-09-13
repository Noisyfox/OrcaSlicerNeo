// Focused cross-host project lifecycle coverage. The renderer is built with
// VITE_USE_MOCK=1 by the desktop E2E command, so these tests exercise the
// actual Electron IPC/preload/adapter/shared-action boundary without a native
// WASM dependency.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
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
  const { app, projectPath, savePath } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await openPickerProject(page);
    await page.getByTestId('menu-file-trigger').click();
    await expect(page.getByTestId('file-save-project')).toBeDisabled();
    await expect(page.getByTestId('file-save-project-as')).toBeEnabled();
    await page.getByTestId('file-save-project-as').click();
    await expect.poll(() => existsSync(savePath)).toBe(true);

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
    await expect(page.getByTestId('object-list')).toBeVisible();
    await page.evaluate(({ path, bytes }) => {
      const transfer = new DataTransfer();
      const file = new File([bytes], 'cube.stl');
      // Electron OS drops expose a private source path; the renderer adapter
      // resolves it without putting the path in shared application state.
      Object.defineProperty(file, 'path', { value: path });
      transfer.items.add(file);
      const target = document.querySelector('[data-testid="object-list"]') ?? document;
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, { path: MODEL_PATH, bytes: Array.from(readFileSync(MODEL_PATH)) });
    await expect(page.getByTestId('btn-slice')).toBeEnabled();
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
