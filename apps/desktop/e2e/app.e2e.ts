// apps/desktop/e2e/app.e2e.ts — the full v1 flow against the built app.
// Mock mode (default): expects the mock gcode marker. Real mode
// (ORCA_E2E_REAL=1, CI e2e-real job): expects real extruder moves (G1).
// The ORCA_E2E env contract replaces native dialogs in main (see
// apps/desktop/src/main/index.ts) — Playwright cannot drive them.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DESKTOP_ROOT = resolve(__dirname, '..');
const MODEL_PATH = resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const REAL = process.env.ORCA_E2E_REAL === '1';

/** Captures renderer console/pageerror/crash/navigation evidence; dump() is
 *  called only on failure so CI logs carry the renderer's story when red. */
function attachRendererDiagnostics(page: Page) {
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  const navigations: string[] = [];
  const workerMessages: string[] = [];
  let crashed = false;
  page.on('console', (msg) => consoleMessages.push(`[${msg.type()}] ${msg.text()}`));
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  page.on('crash', () => { crashed = true; });
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  // The WASM module's C++ prints (libslic3r logging, exception text) land on
  // the WORKER console, which Playwright does NOT route to page.on('console')
  // — capture both the ones spawned later and any already running.
  for (const w of page.workers()) {
    w.on('console', (msg) => workerMessages.push(`[${msg.type()}] ${msg.text()}`));
  }
  page.on('worker', (worker) => {
    worker.on('console', (msg) => workerMessages.push(`[${msg.type()}] ${msg.text()}`));
  });
  return {
    async dump(): Promise<void> {
      console.log('--- renderer diagnostics (test failed) ---');
      console.log(`crashed: ${crashed}`);
      console.log(`main-frame navigations: ${navigations.join(' -> ') || '(none)'}`);
      console.log(`url at failure: ${page.url()}`);
      console.log(`console (${consoleMessages.length}):\n${consoleMessages.join('\n') || '(none)'}`);
      console.log(`worker console (${workerMessages.length}):\n${workerMessages.join('\n') || '(none)'}`);
      console.log(`pageerrors (${pageErrors.length}):\n${pageErrors.join('\n') || '(none)'}`);
      // The slice error message lives in the status bar's destructive span
      // (StatusBar.tsx); the status span alone only says "Error".
      await page
        .locator('.text-destructive')
        .allTextContents()
        .then((t) => console.log(`destructive spans: ${t.join(' | ') || '(none)'}`))
        .catch(() => console.log('destructive spans: (locator failed)'));
      // What the app actually showed at the moment of failure (e.g. the
      // "Loading presets…" splash distinguishes a slow module init from a
      // boot failure).
      await page
        .locator('body')
        .innerText()
        .then((t) => console.log(`body text: ${t.slice(0, 300).replace(/\n/g, ' | ')}`))
        .catch(() => console.log('body text: (locator failed)'));
    },
  };
}

interface LaunchResult {
  app: ElectronApplication;
  exportPath: string;
}

async function launchApp(): Promise<LaunchResult> {
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-e2e-'));
  const exportPath = join(exportDir, 'out.gcode');
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_MODEL: MODEL_PATH,
    ORCA_E2E_EXPORT: exportPath,
  } as Record<string, string>;
  // Ambient shells sometimes carry ELECTRON_RUN_AS_NODE=1, which forces
  // Electron to run as plain node (the app cannot boot) — never valid here.
  delete env.ELECTRON_RUN_AS_NODE;
  // Headless CI Linux (xvfb): ANGLE-on-Mesa fails WebGL context creation
  // ("BindToCurrentSequence failed", llvmpipe) and three.js throws, unmounting
  // the React root (the Viewport error boundary keeps the app alive, but the
  // e2e asserts the GL viewport renders). Chromium's bundled SwiftShader
  // backend works there; Windows/macOS keep the real GPU path.
  const glFlag = process.platform === 'linux' ? ['--use-angle=swiftshader-webgl'] : [];
  const app = await _electron.launch({
    args: ['.', ...glFlag],
    cwd: DESKTOP_ROOT,
    env,
  });
  return { app, exportPath };
}

test('full v1 flow: open model → slice → preview → export gcode', async () => {
  const { app, exportPath } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {

    // App ready: settings panel rendered from bridge metadata (mock presets).
    // Real mode: the module fetches the ~90 MB preload bundle, instantiates
    // wasm64 and parses the full vendor preset tree (6k+ filaments) before
    // the first get_presets answers — that has exceeded 30 s on shared CI
    // runners while finishing locally in ~20 s (run 10, e2e-real line 98).
    await expect(page.getByTestId('preset-select')).toBeVisible({
      timeout: REAL ? 120_000 : 30_000,
    });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    // Slice gated until a model is loaded.
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await expect(page.getByTestId('btn-export')).toBeDisabled();

    // Open model (ORCA_E2E stub returns the fixture path).
    await page.getByTestId('btn-open').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

    // Slice → status flips to Sliced, preview + scrubber appear, export unlocks.
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 60_000 });
    await expect(page.getByTestId('viewport')).toBeVisible();
    await expect(page.getByTestId('layer-scrubber')).toBeVisible();
    await expect(page.getByTestId('btn-export')).toBeEnabled();

    // Export → file on disk with the expected gcode contents.
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true);
    const gcode = readFileSync(exportPath, 'utf8');
    if (REAL) {
      expect(gcode).toContain('G1'); // real module: extruder moves
      expect(gcode).not.toContain('; mock gcode');
    } else {
      expect(gcode).toContain('; mock gcode (unit-test fixture)');
    }

    // Layer scrubber must invalidate the demand-mode frame: scrubbing from
    // layer 0 to the last layer changes the rendered canvas pixels (the
    // toolpath/mesh draw range follows the layer — ToolpathLines/SlicedMesh
    // call invalidate() after setDrawRange). Clip the screenshot to the canvas
    // region ABOVE the scrubber overlay: the overlay is positioned over the
    // canvas, so a plain canvas-element screenshot would include its changing
    // label/thumb and pass even if the GL view never redrew.
    const canvas = page.getByTestId('viewport').locator('canvas');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('viewport canvas has no bounding box');
    const glRegion = { x: box.x, y: box.y, width: box.width, height: Math.max(0, box.height - 130) };
    const shot = () => page.screenshot({ clip: glRegion });
    const layer0Shot = await shot();
    // Base UI thumb = div wrapper + native input[type=range] (visually hidden,
    // full thumb size); the input owns keydown handling incl. Home/End.
    await page.getByTestId('layer-scrubber').locator('input[type="range"]').focus();
    await page.keyboard.press('End');
    await expect
      .poll(async () => (await shot()).equals(layer0Shot), { timeout: 10_000 })
      .toBe(false);

    // Model drag must also invalidate the demand-mode frame: the mesh must
    // follow the cursor WHILE the pointer is held (before the offset commit
    // on release). Pointer events don't invalidate in demand mode — only the
    // explicit invalidate() in ModelMesh's onPointerMove does. Click first to
    // select: drag only starts on a selected object.
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.click(center.x, center.y);
    const beforeDrag = await shot();
    await page.mouse.down();
    await page.mouse.move(center.x + 80, center.y, { steps: 6 });
    await expect
      .poll(async () => (await shot()).equals(beforeDrag), { timeout: 10_000 })
      .toBe(false);
    await page.mouse.up();
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});
