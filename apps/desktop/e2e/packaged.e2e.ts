// apps/desktop/e2e/packaged.e2e.ts — probes the REAL wasm URL path in the
// PACKAGED app: verifies T2's relative worker URL, the app:// renderer
// protocol (file:// cannot spawn workers), and that the worker loads its
// module (presets rendered) without renderer errors.
//
// Requires (run in order; public/wasm is gitignored so this never ships):
//   node scripts/stage-stub-wasm.mjs    # plain-JS stub module → public/wasm/
//   pnpm --filter desktop package:dir   # release/win-unpacked/ (no-mock build)
//   npx playwright test e2e/packaged.e2e.ts
// CI e2e-real covers the same path with the real module in the dev build.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const EXE = process.platform === 'win32'
  ? resolve(DESKTOP_ROOT, 'release/win-unpacked/OrcaSlicerNeo.exe')
  : resolve(DESKTOP_ROOT, 'release/linux-unpacked/OrcaSlicerNeo');
// darwin: release/mac/OrcaSlicerNeo.app/Contents/MacOS/OrcaSlicerNeo

test('packaged app loads the wasm module from the unpacked renderer', async () => {
  expect(existsSync(EXE), `packaged app missing — run package:dir first (${EXE})`).toBe(true);
  const rendererErrors: string[] = [];
  const env = { ...process.env } as Record<string, string>;
  // Ambient shells sometimes carry ELECTRON_RUN_AS_NODE=1, which forces
  // Electron to run as plain node (the app cannot boot) — never valid here.
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ executablePath: EXE, env });
  try {
    const page = await app.firstWindow();
    page.on('pageerror', (err) => rendererErrors.push(String(err)));
    // The stub module's getPresets answers — the worker's dynamic import of
    // ../wasm/orca_slice.js succeeded over the app:// protocol.
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: 30_000 });
    expect(rendererErrors).toEqual([]);
  } finally {
    await app.close();
  }
});
