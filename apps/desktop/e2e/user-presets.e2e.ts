import { _electron } from './electron-fixture';
import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openProjectMenu } from './project-menu';
import { measureUserPresetDelete, measureUserPresetUndo, type UserPresetTiming } from './user-preset-performance';

test('reopening a 3MF using an installed user preset shows no preset warning', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires the real native preset reader and writer');
  const directory = await mkdtemp(join(tmpdir(), 'orca-user-preset-project-e2e-'));
  const projectPath = join(directory, 'same-user.3mf');
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: join(directory, 'preferences.json'),
    ORCA_E2E_MODEL: projectPath, ORCA_E2E_PROJECT_SAVE: projectPath } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.', `--user-data-dir=${directory}`], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-dialog').getByRole('button', { name: 'Save as…', exact: true }).click();
    await page.getByLabel('Preset name', { exact: true }).fill('Same User PLA');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText('Same User PLA');
    await expect.poll(async () => JSON.parse(await readFile(join(directory, 'user/default/filament/Same User PLA.json'), 'utf8')).name).toBe('Same User PLA');
    await page.getByTestId('preset-editor-close').click();
    // Orca's multi-filament validation consumes the preset diff metadata.
    // One slot alone does not expose an exporter that marks every key dirty.
    await page.getByTestId('filament-add').click();
    await expect(page.getByTestId('filament-preset-2')).toHaveText('Same User PLA');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+s' : 'Control+Shift+s');
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('same-user');
    await expect(page.getByTestId('titlebar-save-project')).toBeDisabled();
    const byteLength = (await readFile(projectPath)).byteLength;
    expect(byteLength).toBeGreaterThan(0);

    await openProjectMenu(page, app);
    // Wait for the actual load receipt, without accepting a safety dialog.
    await expect.poll(() => page.evaluate(() => (window as unknown as {
      __orcaE2e?: { projectLoadEvidence?: () => { receipt: unknown } };
    }).__orcaE2e?.projectLoadEvidence?.().receipt), { timeout: 120_000 }).toMatchObject({
      sourceDisplayName: 'same-user.3mf', sourceByteLength: byteLength, commitRoute: 'load-project',
      nativeResult: { ok: true, projectSettingsAvailable: true, embeddedPresetWarnings: {
        present: true, modifiedPrinterGcode: false, modifiedFilamentGcode: false,
        missingSystemPreset: false, requiresConfirmation: false, filamentSlotChanges: [],
      } },
    });
    await expect(page.getByTestId('project-progress-dialog')).toBeHidden();
    await expect(page.getByTestId('filament-preset-1')).toHaveText('Same User PLA');
    await expect(page.getByTestId('filament-preset-2')).toHaveText('Same User PLA');
    await expect(page.getByTestId('project-load-confirmation-dialog')).toHaveCount(0);
    await expect(page.getByTestId('project-notice-dialog')).toHaveCount(0);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.destroy());
    await app.close();
  }
});

test('local user preset files survive restart and deletion Undo stays embedded', async () => {
  const timings: Array<UserPresetTiming & { kind: 'filament' | 'print' }> = [];
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires the real native preset writer');
  const directory = await mkdtemp(join(tmpdir(), 'orca-local-presets-e2e-'));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: join(directory, 'preferences.json') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => _electron.launch({ args: ['.', `--user-data-dir=${directory}`], cwd: resolve(__dirname, '..'), env });
  let app = await launch();
  try {
    expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(directory);
    let page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.locator('#app-tab-prepare').click();
    const parentLabel = await page.getByTestId('filament-preset-1').textContent();
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    const editor = page.getByTestId('preset-editor-dialog');
    const sourceName = await page.getByTestId('preset-editor-title').textContent();
    await editor.getByRole('button', { name: 'Save as…', exact: true }).click();
    await expect(page.getByLabel('Preset name', { exact: true })).toHaveValue(`${sourceName} - Copy`);
    await page.getByLabel('Preset name', { exact: true }).fill('E2E Local PLA');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText('E2E Local PLA');
    await page.getByTestId('preset-editor-preset').click();
    await expect(page.locator('[data-slot="select-label"]').filter({ hasText: /^User presets$/ })).toBeVisible();
    await expect(page.locator('[data-slot="select-label"]').filter({ hasText: /^System presets$/ })).toBeVisible();
    await page.keyboard.press('Escape');
    const file = join(directory, 'user/default/filament/E2E Local PLA.json');
    await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).name).toBe('E2E Local PLA');
    await page.getByTestId('preset-editor-search').fill('filament_diameter');
    const input = page.getByTestId('preset-editor-input-filament_diameter');
    await input.fill('1.76'); await input.press('Enter');
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await editor.getByRole('button', { name: 'Save as…', exact: true }).click();
    await expect(page.getByLabel('Preset name', { exact: true })).toHaveValue('E2E Local PLA');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).filament_diameter).toEqual(['1.76']);
    await editor.getByRole('button', { name: 'Save as…', exact: true }).click();
    await page.getByLabel('Preset name', { exact: true }).fill('E2E Other PLA');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText('E2E Other PLA');
    await input.fill('1.77'); await input.press('Enter');
    await editor.getByRole('button', { name: 'Save as…', exact: true }).click();
    await page.getByLabel('Preset name', { exact: true }).fill('E2E Local PLA');
    await expect(page.getByRole('alert').filter({ hasText: 'Saving will overwrite this preset' })).toBeVisible();
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(page.getByTestId('preset-editor-title')).toHaveText('E2E Local PLA');
    await expect.poll(async () => JSON.parse(await readFile(file, 'utf8')).filament_diameter).toEqual(['1.77']);
    expect(JSON.parse(await readFile(join(directory, 'user/default/filament/E2E Other PLA.json'), 'utf8')).filament_diameter).toEqual(['1.76']);
    await page.getByTestId('preset-editor-close').click();
    await app.close(); app = await launch(); page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 120_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('filament-preset-1').click();
    await page.getByPlaceholder('Search compatible presets…').fill('E2E Local PLA');
    await expect(page.getByText('User presets', { exact: true })).toBeVisible();
    await expect(page.getByText('System presets', { exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Generic', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'E2E Local PLA', exact: true }).click();
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-search').fill('filament_diameter');
    await expect(page.getByTestId('preset-editor-input-filament_diameter')).toHaveValue('1.77');
    await page.getByTestId('preset-editor-dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    timings.push({ ...await measureUserPresetDelete(page), kind: 'filament' });
    await expect.poll(async () => readFile(file).then(() => false, () => true)).toBe(true);
    await page.getByTestId('preset-editor-close').click();
    timings.push({ ...await measureUserPresetUndo(page), kind: 'filament' });
    await expect(page.getByTestId('filament-preset-1')).toHaveText(parentLabel!);
    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-search').fill('filament_diameter');
    await expect(page.getByTestId('preset-editor-input-filament_diameter')).toHaveValue('1.77');
    await expect(page.getByTestId('preset-editor-dialog').getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await expect.poll(async () => readFile(file).then(() => false, () => true)).toBe(true);
    await page.getByTestId('preset-editor-close').click();
    const newProject = async () => {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
      await expect(page.getByTestId('project-dirty-dialog')).toBeVisible();
      await page.getByTestId('project-dirty-dont-save').click();
      await expect(page.getByTestId('project-dirty-dialog')).toBeHidden();
      await expect(page.getByTestId('history-undo')).toBeDisabled();
      await expect(page.getByTestId('titlebar-project-name')).toHaveText('Untitled Project');
    };
    await newProject();
    await expect(page.getByTestId('filament-preset-1')).toHaveText(parentLabel!);
    const processParentLabel = await page.getByTestId('process-preset-select').textContent();
    // Process restoration must not replay the snapshot name that native
    // closeProject just removed (Filament has a separate rack authority).
    await page.getByRole('button', { name: 'Save as…', exact: true }).click();
    await page.getByLabel('Preset name', { exact: true }).fill('E2E Deleted Process');
    await page.getByRole('button', { name: 'Save preset', exact: true }).click();
    await expect(page.getByTestId('process-preset-select')).toContainText('E2E Deleted Process');
    await page.getByTestId('process-preset-select').click();
    await expect(page.locator('[data-slot="combobox-label"]').filter({ hasText: /^User presets$/ })).toBeVisible();
    await expect(page.locator('[data-slot="combobox-label"]').filter({ hasText: /^System presets$/ })).toBeVisible();
    await page.getByPlaceholder('Search presets…', { exact: true }).fill('E2E Deleted Process');
    await expect(page.getByText('System presets', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    timings.push({ ...await measureUserPresetDelete(page), kind: 'print' });
    timings.push({ ...await measureUserPresetUndo(page), kind: 'print' });
    await expect(page.getByTestId('history-redo')).toBeEnabled();
    await newProject();
    await expect(page.getByRole('button', { name: 'Save as…', exact: true })).toBeEnabled();
    await expect(page.getByTestId('process-preset-select')).toHaveText(processParentLabel!);
    console.log('[user-preset-performance]', JSON.stringify({ timings }));
  } finally { await app.close(); }
});
