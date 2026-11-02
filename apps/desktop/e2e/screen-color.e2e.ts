import type { ElectronBridge } from '../src/shared/ipc';
import { _electron } from './electron-fixture';
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

async function launch(mode: string, browser: 'picked' | 'failed' | 'missing' = 'picked') {
  const env = { ...process.env, ORCA_E2E: '1', ORCA_E2E_SCREEN_COLOR: mode,
    ORCA_E2E_PREFERENCES: join(mkdtempSync(join(tmpdir(), 'neo-screen-color-')), 'preferences.json') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  const page = await app.firstWindow();
  // Let the initial utility-process connection finish before reloading to install the browser fixture.
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30000 });
  await page.addInitScript(mode => {
    const state = window as typeof window & { __browserSamples?: number };
    state.__browserSamples = 0;
    Object.defineProperty(window, 'EyeDropper', { configurable: true, value: mode === 'missing' ? undefined : class {
      async open() {
        state.__browserSamples!++;
        if (mode === 'failed') throw new DOMException('expired activation', 'NotAllowedError');
        return { sRGBHex: '#ABCDEF' };
      }
    } });
  }, browser);
  await page.reload();
  await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30000 });
  await page.locator('#app-tab-prepare').click();
  const nativeCalls = () => app.evaluate(() => (globalThis as typeof globalThis & { __orcaScreenColorFixtureCalls: number }).__orcaScreenColorFixtureCalls);
  const browserCalls = () => page.evaluate(() => (window as typeof window & { __browserSamples: number }).__browserSamples);
  return { app, page, nativeCalls, browserCalls };
}
const sample = (page: Page) => page.getByRole('button', { name: 'Pick color from screen', exact: true });
const hex = (page: Page) => page.getByRole('textbox', { name: 'HEX color', exact: true });
const open = (page: Page) => page.getByTestId('filament-colour-1').click();
const cancel = (page: Page) => page.getByRole('button', { name: 'Cancel', exact: true }).click();

test('native IPC sampling preserves alpha and leaves the enclosing draft uncommitted', async () => {
  const { app, page, nativeCalls, browserCalls } = await launch('picked');
  try {
    const trigger = page.getByTestId('filament-colour-1');
    const original = await trigger.getAttribute('style');
    await open(page);
    await hex(page).fill('#11223380');
    await sample(page).click();
    await expect(hex(page)).toHaveValue('12ABEF80');
    await expect(sample(page)).toBeFocused();
    expect(await nativeCalls()).toBe(1); expect(await browserCalls()).toBe(0);
    await cancel(page);
    await expect(trigger).toHaveAttribute('style', original!);
  } finally { await app.close(); }
});

test('native failure falls back immediately and stays browser-only until the picker is reopened', async () => {
  const { app, page, nativeCalls, browserCalls } = await launch('failed');
  try {
    await open(page); await sample(page).click();
    await expect(hex(page)).toHaveValue('ABCDEFFF');
    await sample(page).click();
    expect(await nativeCalls()).toBe(1); expect(await browserCalls()).toBe(2);
    await cancel(page); await open(page); await sample(page).click();
    await expect(hex(page)).toHaveValue('ABCDEFFF');
    expect(await nativeCalls()).toBe(2); expect(await browserCalls()).toBe(3);
  } finally { await app.close(); }
});

test('native cancellation neither falls back nor suppresses the next native attempt', async () => {
  const { app, page, nativeCalls, browserCalls } = await launch('cancelled');
  try {
    await open(page); const original = await hex(page).inputValue();
    await sample(page).click(); await expect(sample(page)).toHaveAttribute('aria-pressed', 'false');
    await sample(page).click(); await expect(sample(page)).toHaveAttribute('aria-pressed', 'false');
    await expect(hex(page)).toHaveValue(original);
    expect(await nativeCalls()).toBe(2); expect(await browserCalls()).toBe(0);
  } finally { await app.close(); }
});

test('browser fallback failure preserves the draft and remains retryable in this opening', async () => {
  const { app, page, nativeCalls, browserCalls } = await launch('failed', 'failed');
  try {
    await open(page); const original = await hex(page).inputValue();
    for (let i = 0; i < 2; i++) { await sample(page).click(); await expect(sample(page)).toHaveAttribute('aria-pressed', 'false'); }
    await expect(hex(page)).toHaveValue(original);
    expect(await nativeCalls()).toBe(1); expect(await browserCalls()).toBe(2);
  } finally { await app.close(); }
});

test('closing a pending native request cancels it and a new opening can sample again', async () => {
  const { app, page, nativeCalls, browserCalls } = await launch('pending');
  try {
    await open(page); await sample(page).click();
    await expect(sample(page)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeDisabled();
    await cancel(page); await open(page); await sample(page).click();
    await expect.poll(nativeCalls).toBe(2);
    expect(await browserCalls()).toBe(0);
    await cancel(page);
  } finally { await app.close(); }
});

test('hides the icon only when neither a loaded addon nor the browser API is available', async () => {
  const { app, page, nativeCalls } = await launch('unavailable', 'missing');
  try { await open(page); await expect(sample(page)).toHaveCount(0); expect(await nativeCalls()).toBe(0); }
  finally { await app.close(); }
});

test('real native screen sampling selects the visible sRGB target', async () => {
  test.skip(process.env.ORCA_SCREEN_COLOR_REAL_UI !== '1', 'Interactive native desktop acceptance');
  const env = { ...process.env, ORCA_E2E: '1',
    ORCA_E2E_PREFERENCES: join(mkdtempSync(join(tmpdir(), 'neo-screen-color-real-')), 'preferences.json') } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE; delete env.ORCA_E2E_SCREEN_COLOR;
  const app = await _electron.launch({ args: ['.'], cwd: resolve(__dirname, '..'), env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 30000 });
    expect(await page.evaluate(() => (window as typeof window & { orca: ElectronBridge }).orca.screenColor.available())).toBe(true);
    await page.locator('#app-tab-prepare').click();
    await page.evaluate(() => {
      const target = document.createElement('div');
      target.id = 'native-screen-color-target';
      target.style.cssText = 'position:fixed;right:20px;top:120px;width:180px;height:180px;background:#12ABEF;z-index:99999;';
      document.body.append(target);
    });
    await open(page);
    console.log('Native acceptance ready: click the eyedropper, then select the blue target.');
    await expect(sample(page)).toHaveAttribute('aria-pressed', 'true', { timeout: 90000 });
    console.log('Native sampler is open: select the blue screen-color target.');
    await expect(sample(page)).toHaveAttribute('aria-pressed', 'false', { timeout: 90000 });
    await expect(hex(page)).toHaveValue('12ABEFFF');
    await page.screenshot({ path: test.info().outputPath('native-screen-color-selected.png') });
    await cancel(page);
  } finally { await app.close(); }
});
