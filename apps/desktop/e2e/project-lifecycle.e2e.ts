import { _electron } from './electron-fixture';
// Focused cross-host project lifecycle coverage. The renderer is built with
// VITE_USE_MOCK=1 by the desktop E2E command, so these tests exercise the
// actual Electron IPC/preload/adapter/shared-action boundary without a native
// WASM dependency.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjectThumbnail } from '../src/utility/projectThumbnail';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');

async function launchProjectApp(directory?: string, sourcePath = MODEL_PATH): Promise<{ app: ElectronApplication; projectPath: string; savePath: string; dir: string }> {
  const dir = directory ?? mkdtempSync(join(tmpdir(), 'orca-project-e2e-'));
  const projectPath = join(dir, 'picked-project.3mf');
  const savePath = join(dir, 'saved-project.3mf');
  // The mock bridge validates that bytes exist, while the extension drives
  // the project picker/action path.
  if (!directory) copyFileSync(sourcePath, projectPath);
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: projectPath,
    ORCA_E2E_PROJECT_SAVE: savePath,
    ORCA_E2E_LIFECYCLE: '1',
    ORCA_E2E_PREFERENCES: join(dir, 'preferences.json'),
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  return { app: await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env }), projectPath, savePath, dir };
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
  // Loading hydrates the native profile and resets the configuration mode.
  // Wait for the committed project identity before selecting Objects, so a
  // slower host cannot overwrite this click with the load's Project reset.
  await expect(page.getByTestId('titlebar-project-name')).toHaveText('picked-project');
  await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
  await page.getByTestId('config-mode-scoped').click();
  await expect(page.getByTestId('object-list').getByRole('button', { name: 'picked-project.3mf' })).toBeVisible();
}

async function makeDirty(page: Page): Promise<void> {
  await page.getByTestId('config-mode-scoped').click();
  const models = page.getByTestId('object-list').getByTestId(/^object-\d+$/);
  const previousCount = await models.count();
  await page.getByTestId('btn-add-model').click();
  // Slice is already enabled for the opened project. Wait for the new model
  // and the import operation to finish before issuing another command.
  await expect(models).toHaveCount(previousCount + 1);
  await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
  await expect(page.getByTestId('btn-slice')).toBeEnabled();
}

test('a new project with parameter changes and no models can be saved', async () => {
  const { app, savePath } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    const save = page.getByTestId('titlebar-save-project');
    await expect(save).toBeDisabled();
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await page.getByTestId('config-mode-project').click();
    await page.getByTestId('config-page-Multi.').click();
    const angle = page.getByTestId('config-input-wipe_tower_rotation_angle');
    await expect(angle).toHaveValue('0');
    await expect(page.getByTestId('config-reset-wipe_tower_rotation_angle')).toHaveCount(0);
    await angle.fill('90');
    await angle.press('Enter');
    await expect(save).toBeEnabled();
    await page.getByTestId('history-undo').click();
    await expect(save).toBeDisabled();
    await page.getByTestId('history-redo').click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('saved-project');
    await expect(save).toBeDisabled();
    expect(existsSync(savePath)).toBe(true);
    expect(readFileSync(savePath).byteLength).toBeGreaterThan(0);
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('Untitled Project');
    await expect(page.getByTestId('project-dirty-dialog')).toHaveCount(0);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
    await app.close();
  }
});

test('New Project resets rotation and Printer/Filament session drafts', async () => {
  const { app } = await launchProjectApp();
  try {
    const page = await app.firstWindow();
    await ready(page);
    await page.getByTestId('preset-edit-printer').click();
    const height = page.getByTestId('preset-editor-input-printable_height');
    const sourceHeight = await height.inputValue();
    await height.fill(String(Number(sourceHeight) + 1));
    await height.press('Enter');
    await expect(page.getByTestId('preset-editor-project-draft')).toBeVisible();
    await page.getByTestId('preset-editor-close').click();
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-page-tab-advanced').click();
    const gcode = page.getByTestId('preset-editor-input-filament_start_gcode');
    const sourceGcode = await gcode.inputValue();
    await gcode.fill('G28\n; old project draft\n');
    await gcode.press('Control+Enter');
    await expect(page.getByTestId('preset-editor-project-draft')).toBeVisible();
    await page.getByTestId('preset-editor-close').click();
    await page.getByTestId('config-mode-project').click();
    await page.getByTestId('config-page-Multi.').click();
    const angle = page.getByTestId('config-input-wipe_tower_rotation_angle');
    await expect(angle).toBeVisible();
    await angle.fill('90');
    await angle.press('Enter');
    await expect(page.getByTestId('config-reset-wipe_tower_rotation_angle')).toBeEnabled();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
    await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
    await page.getByTestId('project-dirty-dont-save').click();
    await expect(page.getByTestId('project-dirty-dialog')).toBeHidden();
    await expect(angle).toHaveValue('0');
    await expect(page.getByTestId('config-reset-wipe_tower_rotation_angle')).toHaveCount(0);
    await expect(page.getByTestId('history-undo')).toBeDisabled();
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('Untitled Project');
    await page.getByTestId('preset-edit-printer').click();
    await expect(height).toHaveValue(sourceHeight);
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
    await page.getByTestId('preset-editor-close').click();
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-page-tab-advanced').click();
    await expect(gcode).toHaveValue(sourceGcode);
    await expect(page.getByTestId('preset-editor-project-draft')).toHaveCount(0);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
    await app.close();
  }
});

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
    // A failed assertion can leave a dirty window whose close confirmation
    // would block teardown. Destroy only the test window in that case.
    if (app.windows().some(window => !window.isClosed()))
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
    await app.close();
  }
});


test('Home opens and creates projects, persists Orca recent history and manages missing files', async ({}, testInfo) => {
  const first = await launchProjectApp();
  let app = first.app;
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('home-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('home-recent-empty')).toBeVisible();
    await page.getByTestId('home-new-project').click();
    await expect(page.locator('#app-panel-workspace')).toHaveAttribute('aria-hidden', 'false');
    await page.locator('#app-tab-home').click();
    await page.getByTestId('home-open-project').click();
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('picked-project');
    await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
    const config = join(first.dir, 'OrcaSlicerNeo.conf');
    expect(JSON.parse(readFileSync(config, 'utf8')).recent_projects).toEqual({ '001': first.projectPath });
    await page.locator('#app-tab-home').click();
    await expect(page.getByTestId('home-recent-list')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('home.png') });
    await page.getByRole('button', { name: 'Actions for picked-project.3mf', exact: true }).click();
    const labels = await page.locator('[data-slot="dropdown-menu-content"]').getByRole('menuitem').allTextContents();
    expect(labels).toEqual(['Show in folder', 'Remove from recent']);
    await expect(page.getByRole('menuitem', { name: 'Remove from recent' })).toHaveAttribute('data-variant', 'destructive');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toBeHidden();
    const card = page.getByTestId('home-recent-list').locator('li').first();
    // The preview, filename/footer, and outer edge all own the same menu.
    for (const position of [{ x: 90, y: 90 }, { x: 30, y: 215 }, { x: 182, y: 128 }]) {
      await card.click({ button: 'right', position });
      await expect(page.locator('[data-slot="context-menu-content"]').getByRole('menuitem')).toHaveText(labels);
      await expect(page.getByRole('menuitem', { name: 'Remove from recent' })).toHaveAttribute('data-variant', 'destructive');
      await expect(page.getByTestId('home-page')).toBeVisible();
      if (position.x === 90) {
        await page.getByRole('menu').evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        await page.screenshot({ path: testInfo.outputPath('home-context-menu.png') });
      }
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menu')).toBeHidden();
    }
    await page.getByRole('button', { name: 'Open picked-project.3mf', exact: true }).click();
    await expect(page.getByTestId('project-load-choice-dialog')).toBeVisible();
    await page.getByTestId('project-load-project').check();
    await page.getByTestId('project-load-confirm').click();
    await expect(page.locator('#app-panel-workspace')).toHaveAttribute('aria-hidden', 'false');
    await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
    await app.close();
    app = (await launchProjectApp(first.dir)).app;
    page = await app.firstWindow();
    await expect(page.getByRole('button', { name: 'Open picked-project.3mf', exact: true })).toBeVisible({ timeout: 30_000 });
    expect(await page.getByTestId('home-recent-list').locator('li').count()).toBe(1);
    // Renaming after list hydration exercises stale metadata and read failure.
    renameSync(first.projectPath, first.savePath);
    await page.getByRole('button', { name: 'Open picked-project.3mf', exact: true }).click();
    await expect(page.getByTestId('home-page').getByRole('alert')).toContainText('no longer available');
    await expect(page.getByTestId('home-recent-list')).toContainText('File is missing');
    await page.getByTestId('home-recent-list').locator('li').first().click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Show in folder' })).toBeDisabled();
    await page.getByRole('menuitem', { name: 'Remove from recent' }).click();
    await expect(page.getByTestId('home-recent-empty')).toBeVisible();
    expect(existsSync(first.savePath)).toBe(true);
    // Open the surviving file to exercise clearing a valid record.
    renameSync(first.savePath, first.projectPath);
    await page.getByTestId('home-open-project').click();
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('picked-project');
    await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
    await page.locator('#app-tab-home').click();
    await page.getByTestId('home-clear-recent').click();
    await expect(page.getByTestId('home-recent-empty')).toBeVisible();
    expect(JSON.parse(readFileSync(config, 'utf8')).recent_projects).toEqual({});
    expect(existsSync(first.projectPath)).toBe(true);
  } finally { await app.close(); }
});


test('Home displays an embedded Orca 3MF thumbnail and retains it after restart', async ({}, testInfo) => {
  const source = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/project-compatibility/orca-upstream-flowrate.3mf');
  const first = await launchProjectApp(undefined, source);
  let app = first.app;
  try {
    let page = await app.firstWindow();
    await expect(page.getByTestId('home-open-project')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('home-open-project').click();
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('picked-project');
    await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
    await page.locator('#app-tab-home').click();
    let image = page.getByRole('button', { name: 'Open picked-project.3mf', exact: true }).locator('img');
    await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    const original = await image.getAttribute('src');
    await page.screenshot({ path: testInfo.outputPath('home-thumbnail.png') });
    await app.close();
    app = (await launchProjectApp(first.dir)).app;
    page = await app.firstWindow();
    image = page.getByRole('button', { name: 'Open picked-project.3mf', exact: true }).locator('img');
    await expect(image).toHaveAttribute('src', original!, { timeout: 30_000 });
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  } finally { await app.close(); }
});


test('held thumbnails do not block progressive cards, project open/save or recent removal/clear', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-held-thumbnails-'));
  const source = join(dir, 'picked-project.3mf'), other = join(dir, 'other.3mf');
  copyFileSync(MODEL_PATH, source); copyFileSync(MODEL_PATH, other);
  writeFileSync(join(dir, 'OrcaSlicerNeo.conf'), JSON.stringify({ recent_projects: { '001': source, '002': other } }));
  const { app, savePath } = await launchProjectApp(dir);
  type HeldRequests = { requests: Array<{ id: string; resolve(url: string | null): void }> };
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('home-open-project')).toBeEnabled({ timeout: 30_000 });
    await app.evaluate(({ ipcMain }) => {
      const state: HeldRequests = { requests: [] };
      (globalThis as unknown as { heldThumbnails: HeldRequests }).heldThumbnails = state;
      // Test-owned IPC replacement; production artifacts contain no delay hook.
      ipcMain.removeHandler('recent:thumbnail');
      ipcMain.handle('recent:thumbnail', (_event, id: string) => new Promise(resolve => state.requests.push({ id, resolve })));
    });
    await page.reload();
    const cards = page.getByTestId('home-recent-list');
    await expect(cards.locator('li')).toHaveCount(2, { timeout: 30_000 });
    await expect(page.getByTestId('home-open-project')).toBeEnabled();
    await expect(page.getByTestId('home-new-project')).toBeEnabled();
    await expect(cards.locator('img')).toHaveCount(0);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { heldThumbnails: HeldRequests }).heldThumbnails.requests.length)).toBeGreaterThanOrEqual(2);
    const entries = await page.evaluate(() => (window as unknown as {
      orca: { recentProjects: { list(): Promise<Array<{ id: string; displayName: string }>> } };
    }).orca.recentProjects.list());
    const fastId = entries.find(entry => entry.displayName === 'other.3mf')!.id;
    const image = await readProjectThumbnail(resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/project-compatibility/orca-upstream-flowrate.3mf'));
    expect(image).not.toBeNull();
    await app.evaluate((_electron, { id, url }) => {
      const state = (globalThis as unknown as { heldThumbnails: HeldRequests }).heldThumbnails;
      for (const request of state.requests) if (request.id === id) request.resolve(url);
    }, { id: fastId, url: image });
    await expect(page.getByRole('button', { name: 'Open other.3mf', exact: true }).locator('img')).toHaveAttribute('src', image!);
    const slow = page.getByRole('button', { name: 'Open picked-project.3mf', exact: true });
    await expect(slow.locator('img')).toHaveCount(0);
    await slow.click();
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('picked-project');
    await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
    await page.keyboard.press('ControlOrMeta+Shift+s');
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('saved-project');
    await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
    expect(existsSync(savePath)).toBe(true);
    await page.locator('#app-tab-home').click();
    await expect(cards.locator('li')).toHaveCount(3);
    await page.getByRole('button', { name: 'Actions for picked-project.3mf', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Remove from recent' }).click();
    await expect(cards.locator('li')).toHaveCount(2);
    await page.getByTestId('home-clear-recent').click();
    await expect(page.getByTestId('home-recent-empty')).toBeVisible();
    await expect(page.getByTestId('home-open-project')).toBeEnabled();
    await app.evaluate(() => {
      for (const request of (globalThis as unknown as { heldThumbnails: HeldRequests }).heldThumbnails.requests) request.resolve('data:image/png;base64,late');
    });
    await expect(page.getByTestId('home-recent-empty')).toBeVisible();
    expect(existsSync(source)).toBe(true); expect(existsSync(savePath)).toBe(true);
  } finally { await app.close(); }
});

test('built thumbnail Worker reads a ZIP64 project without node_modules alongside it', async () => {
  const { Worker } = await import('node:worker_threads');
  const { cp, mkdtemp, rm } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'neo-standalone-thumbnail-'));
  let worker: InstanceType<typeof Worker> | undefined;
  try {
    await cp(join(DESKTOP_ROOT, 'out/main'), dir, { recursive: true });
    const path = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/project-compatibility/orca-upstream-flowrate.3mf');
    worker = new Worker(join(dir, 'recent-thumbnail-worker.js'));
    const url = await new Promise<string | null>((resolve, reject) => {
      worker!.once('error', reject);
      worker!.once('message', (reply: { requestId: number; url: string | null }) => resolve(reply.url));
      worker!.postMessage({ type: 'retain', paths: [path] });
      worker!.postMessage({ type: 'read', requestId: 1, path });
    });
    expect(url).toMatch(/^data:image\/png;base64,/);
  } finally { await worker?.terminate(); await rm(dir, { recursive: true, force: true }); }
});
