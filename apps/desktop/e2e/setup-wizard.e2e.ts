import { _electron } from './electron-fixture';
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
type ActivationEvidence = {
  history: { dirty: boolean; canUndo: boolean; canRedo: boolean };
  profiles: { printer: { name: string }; print: { name: string };
    prints: { name: string }[]; printers: { vendor_id: string }[]; project_config: Record<string, string> };
};
const activationEvidence = (page: Page) => page.evaluate(async () =>
  (window as unknown as { __orcaE2e: { setupActivationEvidence(): Promise<ActivationEvidence> } })
    .__orcaE2e.setupActivationEvidence());
async function menu(page: Page) {
  const root = page.getByTestId('titlebar-menu-trigger');
  const file = page.getByTestId('menu-file-trigger');
  if (await root.getAttribute('aria-expanded') !== 'true') {
    // Base UI keeps the previous popup mounted through its exit animation.
    // Hovering that retiring trigger does not open the next popup's submenu.
    await file.waitFor({ state: 'detached' });
    await root.click();
  }
  await expect(root).toHaveAttribute('aria-expanded', 'true');
  await expect(file).toBeVisible();
  // Exercise the explicit Base UI submenu keyboard contract, rather than
  // depending on its delayed pointer-hover opening during rapid reopen.
  await file.focus();
  await file.press('ArrowRight');
  await expect(page.getByTestId('file-setup-wizard')).toBeVisible();
  await page.getByTestId('file-setup-wizard').click();
}
for (const method of ['window close', 'Exit'] as const) {
  test(`mandatory first-use ${method} exits the process without completing setup`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-setup-exit-e2e-')), preferences = join(dir, 'preferences.json');
    writeFileSync(preferences, JSON.stringify({ version: 1, ui: {} }));
    const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_FIRST_USE: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
    const processHandle = app.process();
    try {
      const page = await app.firstWindow();
      const wizard = page.getByTestId('setup-wizard');
      await expect(wizard).toBeVisible();
      await expect(wizard.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
      await expect(wizard.getByRole('button', { name: 'Exit', exact: true })).toBeEnabled();
      const exited = app.waitForEvent('close');
      const action = method === 'Exit' ? wizard.getByRole('button', { name: 'Exit', exact: true }).click()
        : app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await Promise.all([exited, action.catch(error => { if (!page.isClosed()) throw error; })]);
      await expect.poll(() => processHandle.exitCode).not.toBeNull();
      expect(JSON.parse(readFileSync(preferences, 'utf8')).profileActivation).toBeUndefined();
      const restarted = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
      try { await expect((await restarted.firstWindow()).getByTestId('setup-wizard')).toBeVisible(); }
      finally { await restarted.close(); }
    } finally { if (processHandle.exitCode === null) await app.close(); }
  });
}

test('real native installs selected packages at startup and remaining packages only for the wizard', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'Requires real production WASM packages');
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-setup-delivery-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, ui: {}, profileActivation: {
    models: [{ vendor: 'Creality', model: 'Creality Ender-3', nozzle_diameter: ['0.4'] }], filaments: ['Generic PLA @System'],
  } }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    const before = await activationEvidence(page);
    expect([...new Set(before.profiles.printers.map(printer => printer.vendor_id).filter(Boolean))]).toEqual(['Creality']);
    await menu(page); const wizard = page.getByTestId('setup-wizard');
    await expect(wizard.getByLabel('Search printers', { exact: true })).toBeEnabled({ timeout: 60_000 });
    await expect(wizard.getByRole('checkbox', { name: 'Creality Ender-3', exact: true })).toBeChecked();
    const count = await wizard.getByRole('checkbox').count(); expect(count).toBeGreaterThan(100);
    await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await activationEvidence(page)).toEqual(before);
    await menu(page);
    await expect(wizard.getByLabel('Search printers', { exact: true })).toBeEnabled({ timeout: 60_000 });
    expect(await wizard.getByRole('checkbox').count()).toBe(count);
    await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally { await app.close(); }
});

test('real native wizard loads printer covers only inside its scroll viewport', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'Requires real production WASM covers');
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-setup-covers-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_FIRST_USE: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(), list = page.getByTestId('setup-printers');
    await expect(list).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => list.locator('[data-setup-cover="loaded"] img').count()).toBeGreaterThan(0);
    const index = await list.locator('[data-slot="card"]').evaluateAll(cards => {
      const root = document.querySelector('[data-testid="setup-printers"]')!.getBoundingClientRect();
      return cards.findIndex(card => card.getBoundingClientRect().top > root.bottom + 50
        && card.querySelector('[data-setup-cover="unrequested"]'));
    });
    expect(index).toBeGreaterThanOrEqual(0);
    const card = list.locator('[data-slot="card"]').nth(index);
    await expect(card.locator('[data-setup-cover]')).toHaveAttribute('data-setup-cover', 'unrequested');
    await expect(card.locator('img')).toHaveCount(0);
    // Scroll the real nested list; the dialog and window remain stationary.
    await card.evaluate(element => {
      const root = element.closest('[data-testid="setup-printers"]')!;
      root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top;
    });
    await expect(card.locator('[data-setup-cover]')).toHaveAttribute('data-setup-cover', 'loaded');
    await expect.poll(() => card.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect(await card.locator('img').getAttribute('src')).toMatch(/^blob:/);
  } finally { await app.close(); }
});

test('real native first-use defaults establish a clean empty project', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'Requires real production WASM');
  const preferences = join(mkdtempSync(join(tmpdir(), 'orca-setup-initial-clean-')), 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, ui: {} }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_FIRST_USE: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow(), wizard = page.getByTestId('setup-wizard');
    page.on('pageerror', error => console.log('first-use renderer error', error.stack));
    await expect(wizard).toBeVisible({ timeout: 60_000 });
    await wizard.getByLabel('Search printers', { exact: true }).fill('Creality Ender-3');
    await wizard.getByRole('checkbox', { name: 'Creality Ender-3', exact: true }).click();
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    await wizard.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(wizard).toBeHidden();
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    const initial = await activationEvidence(page);
    expect(initial.history).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
    expect(initial.profiles.prints.map(preset => preset.name)).toContain(initial.profiles.print.name);
    await expect(page.getByTestId('titlebar-project-name')).not.toContainText('*');
  } finally { await app.close(); }
});
test('real native clean candidate availability keeps effective project and dirty baseline', async () => {
  test.skip(process.env.ORCA_E2E_REAL !== '1', 'requires the real WASM Electron build');
  const dir = mkdtempSync(join(tmpdir(), 'orca-setup-dirty-e2e-')), preferences = join(dir, 'preferences.json');
  writeFileSync(preferences, JSON.stringify({ version: 1, ui: {},
    selectedProfiles: { printer: 'Creality Ender-3 0.4 nozzle', print: '0.20mm Standard @Creality Ender3' }, profileActivation: {
    models: [{ vendor: 'Creality', model: 'Creality Ender-3', nozzle_diameter: ['0.2', '0.4', '0.6', '0.8'] }], filaments: ['Generic PLA @System'] } }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: preferences,
    ORCA_E2E_MODEL: resolve(__dirname, '../../../packages/slicer-wasm/fixtures/cube.stl'),
    ORCA_E2E_PROJECT_SAVE: join(dir, 'clean-configured.3mf') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 60_000 });
    await page.locator('#app-tab-prepare').click();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled();
    await page.keyboard.press('Control+Shift+s');
    await expect(page.getByTestId('titlebar-project-name')).toHaveText('clean-configured');
    const evidence = () => activationEvidence(page);
    const before = await evidence(); expect(before.history.dirty).toBe(false);
    await expect(page.getByTestId('titlebar-project-name')).not.toContainText('*');
    await menu(page);
    const wizard = page.getByTestId('setup-wizard');
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    await wizard.getByLabel('Search filaments', { exact: true }).fill('ABS');
    await wizard.getByRole('checkbox', { checked: false }).first().click();
    await wizard.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(wizard).toBeHidden();
    const after = await evidence();
    expect(after.profiles.printer.name).toBe(before.profiles.printer.name);
    expect(after.profiles.project_config).toEqual(before.profiles.project_config);
    expect(after.history.dirty).toBe(false);
    await expect(page.getByTestId('titlebar-project-name')).not.toContainText('*');
    await menu(page);
    await wizard.getByLabel('Search printers', { exact: true }).fill('Creality Ender-3 S1');
    await wizard.getByRole('checkbox', { checked: false }).first().click();
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    await wizard.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(wizard).toBeHidden();
    const addedPrinter = await evidence();
    expect(addedPrinter.profiles.printer.name).toBe(after.profiles.printer.name);
    expect(addedPrinter.profiles.project_config).toEqual(after.profiles.project_config);
    expect(addedPrinter.history.dirty).toBe(false);
    await expect(page.getByTestId('titlebar-project-name')).not.toContainText('*');
  } finally { await app.close(); }
});

test('mandatory setup, keyboard/file gates, defaults, visible bulk and menu cancellation', async ({}, testInfo) => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-setup-e2e-')), preferences = join(dir, 'preferences.json');
  // Explicit absence exercises production first-use, including obsolete saved selection/rack.
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: { printer: 'Retired Printer' }, ui: {},
    rememberedFilamentRacks: { 'Retired Printer': { version: 1, slots: [{ preset: 'Retired PLA', colour: '#123456' }] } } }));
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_FIRST_USE: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string,string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    const wizard = page.getByTestId('setup-wizard');
    await expect(wizard).toBeVisible();
    await expect(wizard.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    await expect(wizard.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape'); await expect(wizard).toBeVisible();
    await page.keyboard.press('Control+o'); await page.keyboard.press('Control+n');
    await page.evaluate(() => {
      const transfer = new DataTransfer(); transfer.items.add(new File(['bad'], 'ignored.stl', { type: 'application/octet-stream' }));
      document.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await expect(page.getByTestId('project-load-choice-dialog')).toHaveCount(0);
    const first = wizard.getByRole('checkbox', { name: 'X1 Carbon', exact: true }); await first.focus(); await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    const bounds = await wizard.boundingBox(); expect(bounds!.width).toBeLessThanOrEqual(900); expect(bounds!.height).toBeLessThanOrEqual(720);
    expect(await wizard.evaluate(element => element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight)).toBe(true);
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('setup-printers.png') });
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(wizard.getByRole('checkbox', { checked: true })).toHaveCount(1);
    await wizard.getByRole('button', { name: 'Deselect All', exact: true }).click();
    await expect(wizard.getByRole('button', { name: 'Finish', exact: true })).toBeDisabled();
    await wizard.getByRole('button', { name: 'Back', exact: true }).click();
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(wizard.getByRole('button', { name: 'Finish', exact: true })).toBeEnabled();
    await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('setup-filaments.png') });
    await wizard.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(wizard).toBeHidden(); await expect(page.getByTestId('home-page')).toBeAttached();
    const saved = JSON.parse(readFileSync(preferences, 'utf8')); expect(saved.profileActivation.models).toHaveLength(1);
    expect(saved.profileActivation.models[0].vendor).toBeTruthy(); expect(saved.profileActivation.filaments.length).toBeGreaterThan(0);
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');
    const activationBefore = saved.profileActivation;
    await menu(page); await expect(wizard).toBeVisible();
    await expect(wizard.getByRole('button', { name: 'Cancel', exact: true })).toBeEnabled();
    await page.keyboard.press('Control+z'); await expect(wizard).toBeVisible();
    await wizard.getByRole('button', { name: 'Next', exact: true }).click();
    const checkedBefore = await wizard.getByRole('checkbox', { checked: true }).count();
    await wizard.getByLabel('Search filaments', { exact: true }).fill('no matching material');
    await expect(wizard.getByRole('checkbox')).toHaveCount(0);
    await wizard.getByRole('button', { name: 'Deselect All', exact: true }).click();
    await wizard.getByLabel('Search filaments', { exact: true }).fill('');
    await expect(wizard.getByRole('checkbox', { checked: true })).toHaveCount(checkedBefore);
    await page.keyboard.press('Escape'); await expect(wizard).toBeHidden();
    expect(JSON.parse(readFileSync(preferences, 'utf8')).profileActivation).toEqual(activationBefore);
    await menu(page); await expect(wizard).toBeVisible(); await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(wizard).toBeHidden();
    await page.keyboard.press('Control+n');
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready'); await expect(wizard).toBeHidden();
    expect(JSON.parse(readFileSync(preferences, 'utf8')).profileActivation).toEqual(activationBefore);
    await page.reload(); await expect(page.getByTestId('slicer-status')).toHaveText('Ready'); await expect(wizard).toBeHidden();
  } finally { await app.close(); }
});
