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
const MODEL_PATH = process.env.ORCA_E2E_MODEL
  ? resolve(process.env.ORCA_E2E_MODEL)
  : resolve(DESKTOP_ROOT, '../../packages/slicer-wasm/fixtures/cube.stl');
const MODEL_COUNT = Math.max(1, Number.parseInt(process.env.ORCA_E2E_MODEL_COUNT ?? '1', 10) || 1);
const PRINTER_PROFILE = process.env.ORCA_E2E_PRINTER ?? 'Bambu Lab P1S 0.4 nozzle';
const REAL = process.env.ORCA_E2E_REAL === '1';
const PRESET_READY_TIMEOUT = REAL ? 300_000 : 30_000;
const SLICE_RESULT_TIMEOUT = REAL ? 60_000 : 5_000;

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

test('full v1 flow: add models → slice → preview → export gcode', async () => {
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
      timeout: PRESET_READY_TIMEOUT,
    });
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready');

    // Preset picker (popup style, base-mira): the trigger is a button showing
    // the current value; opening shows a searchable popup; typing filters the
    // list; picking updates the trigger and the real bridge selection. The
    // mock starts on the X1 Carbon — switch to a known printer to prove a
    // change. The profile can be overridden for real-model regression runs.
    await page.getByTestId('preset-select').click();
    await expect(page.locator('[data-slot="combobox-content"]')).toBeVisible();
    await expect(page.locator('[data-slot="combobox-content"] input')).toBeVisible();
    await page.locator('[data-slot="combobox-content"] input').fill(PRINTER_PROFILE);
    // The full preset bundle has several similar variants; target the exact
    // profile rather than assuming the search produces one result (the mock
    // does).
    const printer = page
      .locator('[data-slot="combobox-content"] [data-slot="combobox-item"]')
      .filter({ hasText: PRINTER_PROFILE });
    await expect(printer).toHaveCount(1);
    await printer.click();
    await expect(page.getByTestId('preset-select')).toContainText(PRINTER_PROFILE);
    // Single-select: the popup dismisses on pick.
    await expect(page.locator('[data-slot="combobox-content"]')).not.toBeVisible();

    // Slice gated until a model is loaded.
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await expect(page.getByTestId('btn-export')).toBeDisabled();

    // Add model(s). ORCA_E2E returns MODEL_PATH for every dialog request;
    // MODEL_COUNT makes a local multi-model regression reproducible without
    // adding a large user model to the repository.
    for (let i = 0; i < MODEL_COUNT; i += 1) {
      await page.getByTestId('btn-add-model').click();
    }
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

    // Slice → status flips to Sliced, preview + scrubber appear, export unlocks.
    await page.getByTestId('btn-slice').click();
    if (REAL) {
      // The threaded progress mailbox is polled by the renderer while the
      // module worker is busy in orc_slice. A real multi-model slice lasts
      // long enough to prove the status bar receives an in-flight update.
      await expect(page.getByTestId('slicer-progress')).toBeVisible();
      await expect.poll(async () => Number(await page.getByTestId('slicer-progress').getAttribute('data-progress')))
        .toBeGreaterThan(0);
    }
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 60_000 });
    await expect(page.getByTestId('viewport')).toBeVisible();
    await expect(page.getByTestId('layer-scrubber')).toBeVisible({ timeout: SLICE_RESULT_TIMEOUT });
    await expect(page.getByTestId('btn-export')).toBeEnabled();

    // The scrubber grabber (Base UI Thumb: div wrapper + visually-hidden
    // input) must render as a full 12x12 knob (base-mira size-3) straddling
    // the 4px track. Regression (2026-08-16): the Base UI migration nested
    // the Thumb inside the overflow-hidden Track, which clipped most of the
    // knob to a barely visible sliver. getBoundingClientRect ignores ancestor
    // overflow clipping, so probe hit-testing with elementFromPoint at the
    // thumb's vertical extremes: clipped, both hit the card overlay instead.
    const thumbFullyVisible = await page
      .getByTestId('layer-scrubber')
      .evaluate((el) => {
        const thumb = el.querySelector('input[type="range"]')?.parentElement;
        if (!thumb) return false;
        const r = thumb.getBoundingClientRect();
        const cx = r.x + r.width / 2;
        return (
          r.width === 12 &&
          r.height === 12 &&
          thumb.contains(document.elementFromPoint(cx, r.y + 1)) &&
          thumb.contains(document.elementFromPoint(cx, r.y + r.height - 1))
        );
      });
    expect(thumbFullyVisible).toBe(true);

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
    // toolpath draw range follows the layer — ToolpathLines calls
    // invalidate() after setDrawRange). Clip the screenshot to the canvas
    // region ABOVE the scrubber overlay: the overlay is positioned over the
    // canvas, so a plain canvas-element screenshot would include its changing
    // label/thumb and pass even if the GL view never redrew.
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
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

    // Drag must invalidate the demand-mode frame while the pointer is held:
    // the click at the canvas center is the projection of the mock cube's
    // corner vertex (the cube spans [0,20]³ at the origin) — a degenerate
    // hit at best — so the held drag is usually an orbit (camera rotates,
    // pixels change), or a gizmo free-move / body drag if the corner click
    // did select. Either way the assertion is pixels changed before
    // release; the move-gizmo test below covers the gizmo/body mechanics
    // in detail.
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await page.mouse.click(center.x, center.y);
    const beforeDrag = await shot();
    await page.mouse.down();
    await page.mouse.move(center.x + 80, center.y, { steps: 6 });
    await expect
      .poll(async () => (await shot()).equals(beforeDrag), { timeout: 10_000 })
      .toBe(false);
    await page.mouse.up();

    // Clear Scene resets the model and invalidates the finished export.
    await page.getByTestId('btn-clear-scene').click();
    await expect(page.getByTestId('btn-slice')).toBeDisabled();
    await expect(page.getByTestId('btn-export')).toBeDisabled();
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});

// Scene-owned selection: a TransformControls handle wins over an overlapping
// DragControls body, and the move panel edits the aggregate pivot for every
// selected instance. The mock e2e fixture has two 20 mm instances at X=0/50.
test('scene selection: gizmo priority, multi-instance move, slice sync, reset', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
      await page.getByTestId('btn-add-model').click();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

      const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      const project = (p: [number, number, number]) =>
        page
          .evaluate(
            (pt) =>
              (window as unknown as {
                __orcaE2e?: { projectWorldToScreen(q: [number, number, number]): { x: number; y: number } | null };
              }).__orcaE2e?.projectWorldToScreen(pt),
            p,
          )
          .then((s) => (s ? { x: box.x + s.x, y: box.y + s.y } : null));

      // Select the first instance. The panel shows its bounding-box center,
      // rather than the instance offset, because it is an aggregate pivot.
      const cubeCenter = await project([10, 10, 10]);
      if (!cubeCenter) throw new Error('cube-center projection unavailable');
      await page.mouse.click(cubeCenter.x, cubeCenter.y);
      await expect(page.getByTestId('move-panel')).toBeVisible();
      await expect(page.getByTestId('move-x')).toHaveValue('10.000');

      // Ctrl-select the second instance, then body-drag the first mesh away
      // from the aggregate gizmo. The panel proves the live DragControls path
      // moved the aggregate pivot; controller tests pin equal member deltas.
      const secondCubeCenter = await project([60, 10, 10]);
      if (!secondCubeCenter) throw new Error('second cube projection unavailable');
      await expect(page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean };
        }).__orcaE2e?.selectMockInstance?.(1, true),
      )).resolves.toBe(true);
      await expect(page.getByTestId('move-x')).toHaveValue('35.000');
      const bodyPivotBefore = await Promise.all(['x', 'y', 'z'].map((axis) =>
        page.getByTestId(`move-${axis}`).inputValue(),
      ));
      await page.mouse.move(cubeCenter.x, cubeCenter.y);
      await page.mouse.down();
      await page.mouse.move(cubeCenter.x + 8, cubeCenter.y + 4);
      await expect
        .poll(() => page.evaluate(() =>
          (window as unknown as { __orcaE2e?: { pointerOwner?: () => string } }).__orcaE2e?.pointerOwner?.(),
        ))
        .toBe('body');
      await page.mouse.move(cubeCenter.x + 40, cubeCenter.y + 20, { steps: 4 });
      await page.mouse.up();
      await expect
        .poll(async () => Promise.all(['x', 'y', 'z'].map((axis) =>
          page.getByTestId(`move-${axis}`).inputValue(),
        )))
        .not.toEqual(bodyPivotBefore);
      await page.getByTestId('move-reset').click();
      await expect(page.getByTestId('move-x')).toHaveValue('35.000');

      // A plain click on a selected member retains the group. Toggle the
      // second instance explicitly to return to one instance, so the
      // X-grabber overlaps its mesh below.
      await expect(page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean };
        }).__orcaE2e?.selectMockInstance?.(1, true),
      )).resolves.toBe(true);
      await expect(page.getByTestId('move-x')).toHaveValue('10.000');

      // The X shaft is at the first selection's pivot (10,10,10) plus
      // [10,0,0]. That point is also on the cube, exercising the collision
      // that must belong to TransformControls rather than DragControls.
      const xStart = await project([20, 10, 10]);
      const xEnd = await project([65, 10, 10]);
      if (!xStart || !xEnd) throw new Error('X-arrow projection unavailable');
      await page.mouse.move(xStart.x, xStart.y);
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                (window as unknown as {
                  __orcaE2e?: { gizmoAxis?: () => string | null };
                }).__orcaE2e?.gizmoAxis?.() ?? null,
            ),
          { timeout: 10_000 },
        )
        .toBe('X');
      await page.mouse.down();
      // This is the explicit arbitration assertion: even though the shaft
      // overlaps the mesh, no body drag may start or mutate state.
      await expect
        .poll(() => page.evaluate(() =>
          (window as unknown as { __orcaE2e?: { pointerOwner?: () => string } }).__orcaE2e?.pointerOwner?.(),
        ))
        .toBe('gizmo');
      await page.mouse.move(xEnd.x, xEnd.y, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByTestId('move-x')).toHaveValue('55.000', { timeout: 10_000 });

      // Reset proves the gizmo only changed the local scene, then select the
      // second instance additively. Its union bounds are [0,70], pivot X=35.
      await page.getByTestId('move-reset').click();
      await expect(page.getByTestId('move-x')).toHaveValue('10.000');
      const secondCenter = await project([60, 10, 10]);
      if (!secondCenter) throw new Error('second cube projection unavailable');
      await expect(page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean };
        }).__orcaE2e?.selectMockInstance?.(1, true),
      )).resolves.toBe(true);
      await expect(page.getByTestId('move-x')).toHaveValue('35.000');

      // Numeric edits translate the whole selection by the pivot delta.
      await page.getByTestId('move-x').fill('45');
      await page.getByTestId('move-x').press('Enter');
      await expect(page.getByTestId('move-x')).toHaveValue('45.000');

      // Garbage input is rejected and the aggregate pivot remains intact.
      await page.getByTestId('move-y').fill('nope');
      await page.getByTestId('move-y').press('Enter');
      await expect(page.getByTestId('move-y')).toHaveValue('10.000');

      // Lift with Z, then Drop to bed returns the selection's minimum Z to 0.
      await page.getByTestId('move-z').fill('20');
      await page.getByTestId('move-z').press('Enter');
      await expect(page.getByTestId('move-z')).toHaveValue('20.000');
      await page.getByTestId('move-drop-bed').click();
      await expect(page.getByTestId('move-z')).toHaveValue('10.000');

      // The bridge is synchronized at Slice (not gesture release).
      await page.getByTestId('btn-slice').click();
      await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
      await expect(page.getByTestId('move-x')).toHaveValue('45.000');
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});
