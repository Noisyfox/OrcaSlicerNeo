// macOS native application menu: the File/Help menu is installed by main
// (createNativeMenuController) and the renderer syncs enabled/disabled state
// through the shared snapshot. Uses the mock module, which drives progress
// 0-100 like the real bridge — the regression trigger for the completed-slice
// re-enable bug. Runs only on darwin; other platforms run the custom titlebar
// menu (covered by titlebar-menu.e2e.ts).
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
// The native application menu exists only on macOS; other platforms run the
// custom titlebar menu (covered by titlebar-menu.e2e.ts).
const testMac = process.platform === 'darwin' ? test : test.skip;

interface NativeItem {
  enabled: boolean;
  checked: boolean;
  label?: string;
}

async function nativeMenuSnapshot(app: ElectronApplication): Promise<Record<string, NativeItem>> {
  // Playwright passes the electron module to app.evaluate callbacks.
  return app.evaluate(({ Menu }) => {
    const out: Record<string, NativeItem> = {};
    const visit = (items: Electron.MenuItem[]) => {
      for (const item of items) {
        if (item.id) out[item.id] = { enabled: item.enabled, checked: item.checked, label: item.label };
        if (item.submenu) visit(item.submenu.items);
      }
    };
    visit(Menu.getApplicationMenu()?.items ?? []);
    return out;
  });
}

testMac('native menu re-enables Slice/Export after slice completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-native-menu-e2e-'));
  const app = await _electron.launch({
    args: ['.'],
    cwd: DESKTOP_ROOT,
    env: {
      ...process.env,
      ORCA_E2E: '1',
      ORCA_E2E_MODEL: MODEL_PATH,
      ORCA_E2E_EXPORT: join(dir, 'out.gcode'),
      // Without this the electron binary runs as plain Node on machines
      // where ELECTRON_RUN_AS_NODE leaks into the environment.
      ELECTRON_RUN_AS_NODE: '',
    } as Record<string, string>,
  });
  const page: Page = await app.firstWindow();
  try {
    await expect(page.getByTestId('preset-select')).toBeVisible();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

    const before = await nativeMenuSnapshot(app);
    expect(before['file-slice']?.enabled).toBe(true);
    expect(before['file-export-gcode']?.enabled).toBe(false);

    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 60_000 });

    const after = await nativeMenuSnapshot(app);
    expect(after['file-slice']?.enabled).toBe(true);
    expect(after['file-export-gcode']?.enabled).toBe(true);
  } finally {
    await app.close();
  }
});
