import { _electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');

async function launch(preferences: string) {
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_PREFERENCES: preferences } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  const page = await app.firstWindow();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30_000 });
  await page.locator('#app-tab-prepare').click();
  return { app, page };
}

async function editHex(page: Page, color: string) {
  await page.getByRole('textbox', { name: 'HEX color', exact: true }).fill(color);
}

test('color drafts commit once; shared favorites survive cancellation and an Electron restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'neo-color-picker-'));
  const preferences = join(dir, 'preferences.json');
  const hidden = [{ kind: 'solid', color: '#11223380' },
    { kind: 'linear-gradient', start: '#FF000000', end: '#0000FF' }];
  writeFileSync(preferences, JSON.stringify({ version: 1, selectedProfiles: {}, ui: { sidebarWidth: 320 },
    colorPicker: { favorites: hidden } }));
  const saved = () => JSON.parse(readFileSync(preferences, 'utf8'));
  const first = await launch(preferences);
  try {
    const { page } = first;
    const trigger = page.getByTestId('filament-colour-1');
    const original = await trigger.getAttribute('value');
    await trigger.click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toBeVisible();
    await expect(page.getByRole('spinbutton', { name: 'Alpha value', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Gradient', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Favorite #11223380', exact: true })).toHaveCount(0);
    await editHex(page, '#2357AB');
    await expect(trigger).toHaveAttribute('value', original!);
    await page.getByRole('button', { name: 'Add favorite color', exact: true }).click();
    await expect.poll(() => saved().colorPicker.favorites).toEqual([{ kind: 'solid', color: '#2357AB' }, ...hidden]);
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('color-picker.png') });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toHaveAttribute('value', original!);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveValue(original!.toUpperCase());
    await page.getByRole('button', { name: 'Favorite #2357AB', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(trigger).toHaveAttribute('value', '#2357ab');

    await page.getByTestId('filament-slot-1').click({ button: 'right' });
    await page.getByTestId('filament-edit-1').click();
    await page.getByTestId('preset-editor-input-default_filament_colour').click();
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    await editHex(page, '#654321');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('textbox', { name: 'HEX color', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('preset-editor-close')).toBeVisible();
    await page.getByTestId('preset-editor-close').click();
    await page.locator('#app-tab-preview').click();
    await page.getByTestId('titlebar-toggle-right-sidebar').click();
    await expect.poll(() => saved().ui.rightSidebarCollapsed).toBe(true);
    expect(saved().colorPicker.favorites).toEqual([{ kind: 'solid', color: '#2357AB' }, ...hidden]);
  } finally { await first.app.close(); }

  const second = await launch(preferences);
  try {
    const { page } = second;
    await page.getByTestId('filament-colour-1').click();
    await expect(page.getByRole('button', { name: 'Favorite #2357AB', exact: true })).toBeVisible();
    const remove = page.getByRole('button', { name: 'Remove favorite #2357AB', exact: true });
    await remove.focus(); await remove.click();
    await expect.poll(() => saved().colorPicker.favorites).toEqual(hidden);
    expect(saved().ui.sidebarWidth).toBe(320);
  } finally { await second.app.close(); }
});
