import { _electron } from './electron-fixture';
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
    const first = wizard.getByRole('checkbox').first(); await first.focus(); await page.keyboard.press('Space');
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
