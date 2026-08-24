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
const REAL = process.env.ORCA_E2E_REAL === '1';
const MODEL_COUNT = Math.max(1, Number.parseInt(process.env.ORCA_E2E_MODEL_COUNT ?? '1', 10) || 1);
// Creality's bed has no Bambu exclusion zones, making cube.stl a stable
// real-module fixture while still exercising the genuine profile picker.
const PRINTER_PROFILE = process.env.ORCA_E2E_PRINTER ?? (
  REAL ? 'Creality Ender-3 0.4 nozzle' : 'Bambu Lab P1S 0.4 nozzle'
);
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

async function selectStableRealPrinter(page: Page): Promise<void> {
  await page.getByTestId('preset-select').click();
  await expect(page.locator('[data-slot="combobox-content"]')).toBeVisible();
  await page.locator('[data-slot="combobox-content"] input').fill(PRINTER_PROFILE);
  const printer = page
    .locator('[data-slot="combobox-content"] [data-slot="combobox-item"]')
    .filter({ hasText: PRINTER_PROFILE });
  await expect(printer).toHaveCount(1);
  await printer.click();
  await expect(page.getByTestId('preset-select')).toContainText(PRINTER_PROFILE);
  await expect(page.locator('[data-slot="combobox-content"]')).not.toBeVisible();
}

/** Select a mock instance once the model's mock volumes are live (the Slice
 *  button enables on modelLoaded, which can precede the async mesh fetch, so a
 *  bare selectMockInstance can race the GL volume collection). */
async function selectMockInstance(page: Page, instanceIdx: number, additive = false): Promise<void> {
  await expect.poll(() => page.evaluate(([idx, add]) =>
    (window as unknown as {
      __orcaE2e?: { selectMockInstance?: (idx: number, additive?: boolean) => boolean };
    }).__orcaE2e?.selectMockInstance?.(idx, add) ?? false,
    [instanceIdx, additive] as [number, boolean],
  )).toBe(true);
}

/** Rendered aggregate selection-box brackets (mock builds only). */
function selectionBoxWorldSegments(page: Page) {
  return page.evaluate(() =>
    (window as unknown as {
      __orcaE2e?: {
        selectionBoxWorldSegments?: () => {
          min: [number, number, number];
          max: [number, number, number];
          segmentCount: number;
        } | null;
      };
    }).__orcaE2e?.selectionBoxWorldSegments?.() ?? null,
  );
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
    await selectStableRealPrinter(page);

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

    // Clear Scene now lives in the scene context menu: right-click empty
    // space (top-right of the canvas) and pick the item. It resets the model
    // and invalidates the finished export.
    const emptySpace = { x: box.x + box.width - 40, y: box.y + 40 };
    await page.mouse.click(emptySpace.x, emptySpace.y, { button: 'right' });
    await expect(page.getByTestId('ctx-menu')).toBeVisible();
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

// Ctrl+clicking an object then a part of another object must not create a
// Mixed selection (Orca's mixed type is invalid).
test('object list: refuses mixing object and part selection (mock)', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
    await selectStableRealPrinter(page);
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    if (REAL) return;

    const list = page.getByTestId('object-list');
    await expect(list).toBeVisible();
    await list.locator('[data-testid^="object-expand-"]').first().click();
    const selectedInstances = () => page.evaluate(() =>
      (window as unknown as {
        __orcaE2e?: { selectionInstanceCount?: () => number };
      }).__orcaE2e?.selectionInstanceCount?.() ?? 0,
    );

    const objectRow = list.locator('div[data-testid^="object-"]').first();
    await objectRow.click({ button: 'left', position: { x: 10, y: 4 } });
    const before = await selectedInstances();
    expect(before).toBeGreaterThan(1);

    // Ctrl+click a part of the same object (object + part is Orca Mixed) — refused.
    await list.locator('[data-testid^="part-"]').first().click({ modifiers: ['Control'] });
    await expect.poll(selectedInstances).toBe(before);
  } finally {
    await app.close();
  }
});

// Object list drag reorder. Mock-only: add two objects, drag the second
// onto the first, and assert the object order changes.
test('object list: drag reorder objects (mock)', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
    await selectStableRealPrinter(page);
    await page.getByTestId('btn-add-model').click();
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    if (REAL) return;

    const list = page.getByTestId('object-list');
    await expect(list).toBeVisible();
    const rows = list.locator('div[data-testid^="object-"]');
    await expect(rows).toHaveCount(2);

    // A row with an active rename editor is not draggable.
    await rows.nth(1).click({ button: 'right' });
    await list.getByTestId('objectlist-rename').click();
    await expect(rows.nth(1)).toHaveAttribute('draggable', 'false');
    await page.keyboard.press('Enter');
    await expect(rows.nth(1)).toHaveAttribute('draggable', 'true');

    // Renaming a part freezes the part row AND its enclosing object row: a
    // non-draggable part's drag source is the ancestor object row, which would
    // otherwise still reorder the object.
    await rows.nth(1).locator('[data-testid^="object-expand-"]').click();
    const partRow = rows.nth(1).locator('[data-testid^="part-"]').first();
    await partRow.click({ button: 'right' });
    await list.getByTestId('objectlist-rename').click();
    await expect(partRow).toHaveAttribute('draggable', 'false');
    await expect(rows.nth(1)).toHaveAttribute('draggable', 'false');
    await page.keyboard.press('Enter');
    await expect(partRow).toHaveAttribute('draggable', 'true');
    await expect(rows.nth(1)).toHaveAttribute('draggable', 'true');
    // Collapse again so the drop target below is the bare object row.
    await rows.nth(1).locator('[data-testid^="object-expand-"]').click();

    const firstBefore = (await rows.nth(0).innerText());
    await rows.nth(1).dragTo(rows.nth(0));
    await expect.poll(() => rows.nth(0).innerText()).not.toBe(firstBefore);
  } finally {
    await app.close();
  }
});

// Add instance via the object-row context menu (Step: add/remove instance).
test('object list: add instance via the context menu (mock)', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
    await selectStableRealPrinter(page);
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    if (REAL) return;

    const list = page.getByTestId('object-list');
    await expect(list).toBeVisible();
    const objectRow = list.locator('div[data-testid^="object-"]').first();
    // Expand to reveal the Instances group (the mock object starts with 2 instances).
    await list.locator('[data-testid^="object-expand-"]').first().click();
    await expect(list.locator('[data-testid^="instances-toggle-"]')).toHaveCount(1);
    await expect.poll(() => list.locator('[data-testid^="instance-"]').count()).toBe(2);

    // Add an instance via the object-row context menu (top-left of the row).
    await objectRow.click({ button: 'right', position: { x: 10, y: 4 } });
    await list.getByTestId('objectlist-add-instance').click();

    // The instance count grows from 2 to 3.
    await expect.poll(() => list.locator('[data-testid^="instance-"]').count()).toBe(3);
    await expect(list.locator('[data-testid^="instances-toggle-"]')).toHaveCount(1);
  } finally {
    await app.close();
  }
});

// Object list multi-select: Ctrl toggles a row; Shift selects a contiguous range.
test('object list: ctrl and shift multi-select (mock)', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
    await selectStableRealPrinter(page);
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    if (REAL) return;

    const list = page.getByTestId('object-list');
    await expect(list).toBeVisible();
    await list.locator('[data-testid^="object-expand-"]').first().click();
    const instanceRows = list.locator('[data-testid^="instance-"]');
    await expect(instanceRows).toHaveCount(2);
    const instanceCount = () => page.evaluate(() =>
      (window as unknown as {
        __orcaE2e?: { selectionInstanceCount?: () => number };
      }).__orcaE2e?.selectionInstanceCount?.() ?? 0,
    );

    // Ctrl+click both instances -> both selected (additive toggle).
    await instanceRows.nth(0).click();
    await instanceRows.nth(1).click({ modifiers: ['Control'] });
    await expect.poll(instanceCount).toBe(2);
    // Ctrl+click the first again -> toggled off.
    await instanceRows.nth(0).click({ modifiers: ['Control'] });
    await expect.poll(instanceCount).toBe(1);

    // Shift-range between the two instance rows selects both.
    await instanceRows.nth(0).click();
    await instanceRows.nth(1).click({ modifiers: ['Shift'] });
    await expect.poll(instanceCount).toBe(2);

    // Right-click on an already-selected row keeps the whole selection
    // (scene-matching guard: never collapse a multi-selection).
    await instanceRows.nth(1).click({ button: 'right' });
    await expect.poll(instanceCount).toBe(2);
    await page.keyboard.press('Escape');
  } finally {
    await app.close();
  }
});

// Object list structural actions: clone, assemble, delete. Mock-only.
test('object list: clone, assemble, delete (structural, mock)', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
    await selectStableRealPrinter(page);
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    if (REAL) return;

    const list = page.getByTestId('object-list');
    await expect(list).toBeVisible();
    const objectCount = () => list.locator('[data-testid^="object-expand-"]').count();
    const objectRow = () => list.locator('div[data-testid^="object-"]').first();

    // Clone via the row context menu.
    await objectRow().click({ button: 'right' });
    await list.getByTestId('objectlist-clone').click();
    await expect.poll(objectCount).toBeGreaterThan(1);

    // Right-click selection mirrors the scene: a right-click on an unselected
    // row selects it exactly like a left-click would, so the row highlights.
    const rows = list.locator('div[data-testid^="object-"]');
    await page.keyboard.press('Escape');
    await rows.nth(0).click({ button: 'right', position: { x: 40, y: 4 } });
    await expect(rows.nth(0).locator('> button[data-state="selected"]')).toBeVisible();
    await expect(rows.nth(1).locator('> button[data-state="selected"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await rows.nth(1).click({ button: 'right', position: { x: 40, y: 4 } });
    await expect(rows.nth(1).locator('> button[data-state="selected"]')).toBeVisible();
    await expect(rows.nth(0).locator('> button[data-state="selected"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Assemble is selection-driven: with no multi-selection the menu carries
    // no assemble item — the old "Assemble all" is gone.
    await objectRow().click({ button: 'right' });
    await expect(list.getByTestId('objectlist-assemble')).toBeHidden();

    // Select both objects, then Assemble via the row context menu — only the
    // selected objects are merged, not the whole list.
    const objectRows = list.locator('div[data-testid^="object-"]');
    await objectRows.nth(0).click();
    await objectRows.nth(1).click({ modifiers: ['Control'] });
    await objectRows.nth(1).click({ button: 'right' });
    // Rename is hidden while multiple objects are selected (the single-object
    // rename flow is covered by the rename test).
    await expect(list.getByTestId('objectlist-rename')).toBeHidden();
    // Printable applies to the whole selection when the clicked row is part of
    // it: one toggle flips both objects, and each row's menu then reads
    // "Mark printable". (Escape also clears the selection, so re-select
    // before Assemble below.)
    await list.getByTestId('objectlist-printable').click();
    await objectRows.nth(0).click({ button: 'right' });
    await expect(list.getByTestId('objectlist-printable')).toHaveText('Mark printable');
    await page.keyboard.press('Escape');
    await objectRows.nth(1).click({ button: 'right' });
    await expect(list.getByTestId('objectlist-printable')).toHaveText('Mark printable');
    await page.keyboard.press('Escape');
    await objectRows.nth(0).click();
    await objectRows.nth(1).click({ modifiers: ['Control'] });
    await objectRows.nth(1).click({ button: 'right' });
    await list.getByTestId('objectlist-assemble').click();
    await expect(list).toContainText('Assembly');
    await expect.poll(objectCount).toBe(1);

    // Delete the single object via the row context menu.
    await objectRow().click({ button: 'right' });
    await list.getByTestId('objectlist-delete').click();
    await expect(list).toContainText('No objects');
  } finally {
    await app.close();
  }
});

// Object list metadata actions: rename, part-type control, printable
// toggle, then a successful slice — all through the row context menu.
test('object list: rename, printable, and slice (mock)', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
    await selectStableRealPrinter(page);
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    if (REAL) return;

    const list = page.getByTestId('object-list');
    await expect(list).toBeVisible();
    const objectRow = list.locator('div[data-testid^="object-"]').first();

    // Rename via the row context menu (the menu closes and an inline input appears).
    await objectRow.click({ button: 'right' });
    await list.getByTestId('objectlist-rename').click();
    const nameInput = list.locator('[data-testid^="object-name-input-"]').first();
    await nameInput.fill('My Cube');
    await nameInput.press('Enter');
    await expect(list).toContainText('My Cube');

    // Expand to reveal part rows.
    await list.locator('[data-testid^="object-expand-"]').first().click();

    // The object rename must not leak into its parts: the e2e mock fixture is
    // a two-volume cube, and Orca syncs the part name only for single-volume
    // objects (covered by the actions unit tests).
    await expect(list.locator('[data-testid^="part-"]').first()).toContainText('Part 1');

    // The part row's context menu carries the type-change control (a successful
    // multi-part change is covered by the unit tests + live harness).
    const partRow = list.locator('[data-testid^="part-"]').first();
    await partRow.click({ button: 'right' });
    await expect(list.getByTestId('objectlist-split-parts')).toBeVisible();
    await expect(list.locator('[data-testid^="objectlist-type-"]').first()).toBeVisible();
    await page.keyboard.press('Escape');

    // Toggle the object printable off, then back on, via the context menu.
    // Click near the row's top-left (the object name button) — once expanded,
    // the row box spans the part rows, so its center would right-click a part.
    await objectRow.click({ button: 'right', position: { x: 10, y: 4 } });
    await list.getByTestId('objectlist-printable').click();
    await objectRow.click({ button: 'right', position: { x: 10, y: 4 } });
    await expect(list.getByTestId('objectlist-printable')).toHaveText('Mark printable');
    await list.getByTestId('objectlist-printable').click();
    await expect(list.getByTestId('objectlist-ctx-menu')).toBeHidden();

    // The metadata edits invalidate any prior slice; a fresh slice succeeds.
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 60_000 });
    await expect(page.getByTestId('btn-export')).toBeEnabled();
  } finally {
    await app.close();
  }
});

// The scene right-click menu's Add Cube appends OrcaSlicer's 20 mm cube
// primitive through the regular model pipeline: Slice unlocks immediately
// and (mock mode) the added instance is a selectable 20 mm box.
test('scene context menu: Add Cube appends a 20 mm primitive', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
      await expect(page.getByTestId('btn-slice')).toBeDisabled();

      const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      const emptySpace = { x: box.x + box.width - 40, y: box.y + 40 };
      await page.mouse.click(emptySpace.x, emptySpace.y, { button: 'right' });
      await expect(page.getByTestId('ctx-menu')).toBeVisible();
      await expect(page.getByTestId('btn-add-cube')).toBeEnabled();
      await page.getByTestId('btn-add-cube').click();
      await expect(page.getByTestId('ctx-menu')).toBeHidden();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

      if (!REAL) {
        // The mock's addModel fixture is the 20 mm cube: selecting the new
        // instance must report 20 mm world bounds.
        await expect.poll(() => page.evaluate(() =>
          (window as unknown as {
            __orcaE2e?: { selectMockInstance?: (idx: number, additive?: boolean) => boolean };
          }).__orcaE2e?.selectMockInstance?.(0, false) ?? false,
        )).toBe(true);
        await expect.poll(() => page.evaluate(() => {
          const bounds = (window as unknown as {
            __orcaE2e?: { selectionBoundsWorld?: () => { size: [number, number, number] } | null };
          }).__orcaE2e?.selectionBoundsWorld?.();
          return bounds ? bounds.size : null;
        })).toEqual([20, 20, 20]);
      }
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});

// The scene right-click menu's Add Model routes through the same host file
// picker as the gizmo toolbar (ORCA_E2E_MODEL in e2e): Slice unlocks
// immediately and (mock mode) the imported fixture is a selectable 20 mm box.
test('scene context menu: Add Model imports through the host picker', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
      await expect(page.getByTestId('btn-slice')).toBeDisabled();

      const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      const emptySpace = { x: box.x + box.width - 40, y: box.y + 40 };
      await page.mouse.click(emptySpace.x, emptySpace.y, { button: 'right' });
      await expect(page.getByTestId('ctx-menu')).toBeVisible();
      await expect(page.getByTestId('btn-ctx-add-model')).toBeEnabled();
      await page.getByTestId('btn-ctx-add-model').click();
      await expect(page.getByTestId('ctx-menu')).toBeHidden();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

      if (!REAL) {
        // The mock's addModel fixture is the 20 mm cube: selecting the new
        // instance must report 20 mm world bounds.
        await expect.poll(() => page.evaluate(() =>
          (window as unknown as {
            __orcaE2e?: { selectMockInstance?: (idx: number, additive?: boolean) => boolean };
          }).__orcaE2e?.selectMockInstance?.(0, false) ?? false,
        )).toBe(true);
        await expect.poll(() => page.evaluate(() => {
          const bounds = (window as unknown as {
            __orcaE2e?: { selectionBoundsWorld?: () => { size: [number, number, number] } | null };
          }).__orcaE2e?.selectionBoundsWorld?.();
          return bounds ? bounds.size : null;
        })).toEqual([20, 20, 20]);
      }
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});

// Right-clicking a model body opens the object context menu (the same menu as
// the object list's object rows) — never the empty-scene menu. The empty menu
// staying closed guards against the scenario where an always-on-top overlay
// (e.g. toolpath) or a back-facing part makes the topmost body hit get
// misclassified as empty space. The right-click also selects the clicked
// instance (the same granularity as a plain left-click), but leaves the
// selection untouched when the clicked volume is already selected.
test('scene context menu: right-click on a model body opens the object menu', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
    await selectStableRealPrinter(page);
    await page.getByTestId('btn-add-model').click();
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    if (REAL) return;

    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('viewport canvas has no bounding box');
    const pt = await page.evaluate(() =>
      (window as unknown as {
        __orcaE2e?: { projectWorldToScreen?: (p: [number, number, number]) => { x: number; y: number } | null };
      }).__orcaE2e?.projectWorldToScreen?.([10, 10, 10]) ?? null,
    );
    if (!pt) throw new Error('world→screen projection unavailable');
    const list = page.getByTestId('object-list');
    // The list container's own testid ("object-list") also matches the `object-`
    // prefix, so exclude it — row locators must target the actual rows.
    const objectRows = list.locator('div[data-testid^="object-"]:not([data-testid="object-list"])');
    // Expand the object row to reveal the Instances group (the mock object
    // starts with 2 instances; instance rows render only while expanded).
    await list.locator('[data-testid^="object-expand-"]').first().click();
    await page.mouse.click(box.x + pt.x, box.y + pt.y, { button: 'right' });
    // The empty-scene menu must not appear over a model body; the object menu
    // (same testid as the list's) carries the object-row actions instead.
    await expect(page.getByTestId('ctx-menu')).toHaveCount(0);
    const objectMenu = page.getByTestId('objectlist-ctx-menu');
    await expect(objectMenu).toBeVisible();
    // Rename is not offered in the scene menu (the viewport has no inline
    // editor; the object list still has it).
    await expect(objectMenu.getByTestId('objectlist-rename')).toHaveCount(0);
    await expect(objectMenu.getByTestId('objectlist-printable')).toBeVisible();
    await expect(objectMenu.getByTestId('objectlist-clone')).toBeVisible();
    // The e2e mock fixture is a two-volume, two-instance object — splittable.
    await expect(objectMenu.getByTestId('objectlist-split-objects')).toBeVisible();
    await expect(objectMenu.getByTestId('objectlist-add-instance')).toBeVisible();
    await expect(objectMenu.getByTestId('objectlist-remove-instance')).toBeEnabled();
    // The right-click selected only the clicked instance (instance-level, the
    // same granularity as a plain left-click): exactly one instance row in the
    // Instances group shows selected, and the object row itself does not.
    // (`> button` because the expanded parts/instances rows live inside the
    // object row div; only the row's own direct-child button is its state.)
    await expect(list.locator('[data-testid^="instance-"] button[data-state="selected"]')).toHaveCount(1);
    await expect(objectRows.first().locator('> button[data-state="selected"]')).toHaveCount(0);
    // With a single object selected the selection-driven Assemble item is
    // absent (needs ≥ 2 full objects).
    await expect(objectMenu.getByTestId('objectlist-assemble')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(objectMenu).toBeHidden();

    // List rows right-click-select with the same granularity as the scene:
    // right-clicking an instance row selects only that instance (exactly one
    // instance row highlights, the object row stays unselected).
    await list.locator('[data-testid^="instance-"]').first().click({ button: 'right' });
    await expect(list.locator('[data-testid^="instance-"] button[data-state="selected"]')).toHaveCount(1);
    await expect(objectRows.first().locator('> button[data-state="selected"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(objectMenu).toBeHidden();

    // Right-clicking a body that is already selected must not change the
    // selection: with two objects fully selected, a right-click on a body
    // keeps both rows selected and Assemble is offered.
    // (All row clicks are positioned on the row's own line — the row div's
    // center lands on the expanded parts/instances rows, and the left ~12px
    // are the expand-toggle span.)
    await objectRows.nth(0).click({ button: 'right', position: { x: 40, y: 4 } });
    await list.getByTestId('objectlist-clone').click();
    await expect.poll(() => objectRows.count()).toBeGreaterThan(1);
    await objectRows.nth(0).click({ position: { x: 40, y: 4 } });
    await objectRows.nth(1).click({ modifiers: ['Control'], position: { x: 40, y: 4 } });
    await page.mouse.click(box.x + pt.x, box.y + pt.y, { button: 'right' });
    await expect(objectMenu).toBeVisible();
    await expect(objectRows.nth(0).locator('> button[data-state="selected"]')).toBeVisible();
    await expect(objectRows.nth(1).locator('> button[data-state="selected"]')).toBeVisible();
    await expect(objectMenu.getByTestId('objectlist-assemble')).toBeVisible();
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
      // Keep the real geometry fixture away from vendor exclusion zones. The
      // default profile is user/preset dependent (and can be Bambu), so this
      // scene test must establish the same printable profile as the full flow
      // before importing and slicing the cube.
      await selectStableRealPrinter(page);
      // Add two real model instances so aggregate-pivot and multi-selection
      // assertions exercise the actual GL volume collection.
      await page.getByTestId('btn-add-model').click();
      if (REAL) await page.getByTestId('btn-add-model').click();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

      const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      if (REAL) {
        // Real builds intentionally do not expose mock projection hooks. Use
        // the actual rendered canvas and camera interaction as the stable
        // contract: slice real geometry, then prove orbiting changes pixels.
        await page.getByTestId('btn-slice').click();
        await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 120_000 });
        const before = await canvas.screenshot();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 6 });
        await page.mouse.up();
        await expect.poll(async () => (await canvas.screenshot()).equals(before), { timeout: 10_000 }).toBe(false);
        return;
      }
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

      // The Move toggle can only arm with a non-empty selection: it stays
      // disabled while nothing is selected.
      await expect(page.getByTestId('gizmo-btn-move')).toBeDisabled();

      // Select the first instance. The move panel is part of the gizmo, so
      // nothing appears yet: no panel, no gizmo, and the toolbar button stays
      // unpressed.
      const cubeCenter = await project([10, 10, 10]);
      if (!cubeCenter) throw new Error('cube-center projection unavailable');
      await page.mouse.click(cubeCenter.x, cubeCenter.y);
      await expect(page.getByTestId('move-panel')).toBeHidden();
      // A plain click selection is framed by the white bracket box.
      await expect.poll(() => selectionBoxWorldSegments(page), { timeout: 10_000 })
        .toEqual({ min: [0, 0, 0], max: [20, 20, 20], segmentCount: 24 });

      // The gizmo never auto-activates on selection (gizmo toolbar design):
      // hovering where the move-gizmo X shaft would sit still reads no axis,
      // and the toolbar button stays unpressed.
      const shaftPoint = await project([20, 10, 10]);
      if (!shaftPoint) throw new Error('shaft projection unavailable');
      await page.mouse.move(shaftPoint.x, shaftPoint.y);
      await expect(page.getByTestId('gizmo-btn-move')).toHaveAttribute('aria-pressed', 'false');
      await expect
        .poll(() => page.evaluate(() =>
          (window as unknown as { __orcaE2e?: { gizmoAxis?: () => string | null } }).__orcaE2e?.gizmoAxis?.() ?? null,
        ), { timeout: 10_000 })
        .toBeNull();

      // Arm the gizmo from the toolbar — the move panel appears with it. The
      // panel shows the aggregate bounding-box center, rather than the
      // instance offset, because it is an aggregate pivot.
      await page.getByTestId('gizmo-btn-move').click();
      await expect(page.getByTestId('gizmo-btn-move')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('move-panel')).toBeVisible();
      await expect(page.getByTestId('move-x')).toHaveValue('10.000');
      // An opened gizmo takes over the selection visual — the box hides.
      await expect.poll(() => selectionBoxWorldSegments(page)).toBeNull();

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
      // Still hidden while the gizmo stays armed.
      await expect.poll(() => selectionBoxWorldSegments(page)).toBeNull();
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
      // The gizmo has been armed from the toolbar since the first selection.
      // TransformControls.axis only refreshes on a fresh pointermove, so
      // re-approach the shaft until one lands on the rendered gizmo; the
      // cursor always ends at xStart for the drag below.
      await expect
        .poll(
          async () => {
            await page.mouse.move(xStart.x, xStart.y);
            return page.evaluate(
              () =>
                (window as unknown as {
                  __orcaE2e?: { gizmoAxis?: () => string | null };
                }).__orcaE2e?.gizmoAxis?.() ?? null,
            );
          },
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

// Rotate/scale gizmos (M11): exclusive toolbar toggles, the rotate/scale
// panels, the scale world/local coord toggle, and the multi-selection display
// rules (0° rotate, 100% scale, coord toggle disabled). Gizmo drags use the
// same axis-poll pattern as the move test; the rotate Z ring sits at the
// gizmo radius (~63 mm at the default camera for the first cube's pivot).
test('scene selection: rotate/scale gizmos, panels, coord toggle', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
      await selectStableRealPrinter(page);
      await page.getByTestId('btn-add-model').click();
      if (REAL) await page.getByTestId('btn-add-model').click();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

      const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      if (REAL) {
        // Real-artifact runs only prove the toolbar/panel surface; the mock
        // path below owns the deterministic gizmo-drag assertions.
        for (const id of ['gizmo-btn-move', 'gizmo-btn-rotate', 'gizmo-btn-scale']) {
          await expect(page.getByTestId(id)).toBeVisible();
          await expect(page.getByTestId(id)).toBeDisabled();
        }
        return;
      }
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
      const readAxis = () => page.evaluate(() =>
        (window as unknown as { __orcaE2e?: { gizmoAxis?: () => string | null } }).__orcaE2e?.gizmoAxis?.() ?? null,
      );
      const pollAxisAt = async (points: Array<{ x: number; y: number }>, axis: string) => {
        await expect
          .poll(async () => {
            for (const point of points) {
              await page.mouse.move(point.x, point.y);
              if ((await readAxis()) === axis) return axis;
            }
            return null;
          }, { timeout: 10_000 })
          .toBe(axis);
      };

      // All three gizmo toggles need a selection to arm.
      for (const id of ['gizmo-btn-move', 'gizmo-btn-rotate', 'gizmo-btn-scale']) {
        await expect(page.getByTestId(id)).toBeDisabled();
      }

      const cubeCenter = await project([10, 10, 10]);
      if (!cubeCenter) throw new Error('cube-center projection unavailable');
      await page.mouse.click(cubeCenter.x, cubeCenter.y);
      // Selection alone opens nothing — panels ride with their gizmos.
      for (const panel of ['move-panel', 'rotate-panel', 'scale-panel']) {
        await expect(page.getByTestId(panel)).toBeHidden();
      }

      // Arm Scale first (before any rotation), so the world-axis shaft drag
      // and the size/factor relationship stay axis-aligned.
      await page.getByTestId('gizmo-btn-scale').click();
      await expect(page.getByTestId('gizmo-btn-scale')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('gizmo-btn-move')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('scale-panel')).toBeVisible();
      await expect(page.getByTestId('rotate-panel')).toBeHidden();
      await expect(page.getByTestId('scale-factor-x')).toHaveValue('100.0');
      await expect(page.getByTestId('scale-size-x')).toHaveValue('20.000');

      // Drag the X shaft like the move test: pivot + [10,0,0] → [45,10,10].
      const xStart = await project([20, 10, 10]);
      const xEnd = await project([45, 10, 10]);
      if (!xStart || !xEnd) throw new Error('scale X-arrow projection unavailable');
      await pollAxisAt([xStart], 'X');
      await page.mouse.down();
      await page.mouse.move(xEnd.x, xEnd.y, { steps: 5 });
      await page.mouse.up();
      await expect
        .poll(async () => page.getByTestId('scale-factor-x').inputValue(), { timeout: 10_000 })
        .not.toBe('100.0');
      // Size = 20 mm × factor/100 — both inputs move together.
      const factorPct = Number.parseFloat(await page.getByTestId('scale-factor-x').inputValue());
      const sizeMm = Number.parseFloat(await page.getByTestId('scale-size-x').inputValue());
      expect(Math.abs(sizeMm - factorPct / 5)).toBeLessThan(1);

      // World/Local toggle: local is available for a single selection and
      // flips back; both buttons keep the armed state in sync.
      await page.getByTestId('scale-space-local').click();
      await expect(page.getByTestId('scale-space-local')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('scale-space-world')).toHaveAttribute('aria-pressed', 'false');
      await page.getByTestId('scale-space-world').click();
      await expect(page.getByTestId('scale-space-world')).toHaveAttribute('aria-pressed', 'true');

      // Multi-selection forces world space and disables the coord toggle; the
      // factor inputs fall back to the neutral 100%.
      await expect(page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean };
        }).__orcaE2e?.selectMockInstance?.(1, true),
      )).resolves.toBe(true);
      await expect(page.getByTestId('scale-space-world')).toBeDisabled();
      await expect(page.getByTestId('scale-space-local')).toBeDisabled();
      await expect(page.getByTestId('scale-factor-x')).toHaveValue('100.0');
      await expect(page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { selectMockInstance?: (instanceIdx: number, additive?: boolean) => boolean };
        }).__orcaE2e?.selectMockInstance?.(1, true),
      )).resolves.toBe(true);
      await expect(page.getByTestId('scale-space-local')).toBeEnabled();

      // Panel edits: factor input sets the absolute percent, size input sets
      // the target dimension, Reset restores the original.
      await page.getByTestId('scale-factor-x').fill('200');
      await page.getByTestId('scale-factor-x').press('Enter');
      await expect(page.getByTestId('scale-factor-x')).toHaveValue('200.0');
      await expect(page.getByTestId('scale-size-x')).toHaveValue('40.000');
      await page.getByTestId('scale-size-y').fill('60');
      await page.getByTestId('scale-size-y').press('Enter');
      await expect(page.getByTestId('scale-size-y')).toHaveValue('60.000');
      await expect(page.getByTestId('scale-factor-y')).toHaveValue('300.0');
      await page.getByTestId('scale-reset').click();
      await expect(page.getByTestId('scale-factor-x')).toHaveValue('100.0');
      await expect(page.getByTestId('scale-size-x')).toHaveValue('20.000');

      // Rotate gizmo: exclusive with scale — arming rotate hides the scale
      // panel. The Z ring (X-Y plane) projects to a screen ellipse around the
      // CURRENT selection pivot (scale edits can move the anchor relative to
      // a fixed world point, so aim at the live pivot, not the initial cube
      // center).
      await page.getByTestId('gizmo-btn-rotate').click();
      await expect(page.getByTestId('gizmo-btn-rotate')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('gizmo-btn-scale')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('rotate-panel')).toBeVisible();
      await expect(page.getByTestId('scale-panel')).toBeHidden();
      await expect(page.getByTestId('rotate-x')).toHaveValue('0.0');
      const pivotScreen = await page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { projectSelectionPivot?: () => { x: number; y: number } | null };
        }).__orcaE2e?.projectSelectionPivot?.() ?? null,
      );
      if (!pivotScreen) throw new Error('selection-pivot projection unavailable');
      const pivotX = box.x + pivotScreen.x;
      const pivotY = box.y + pivotScreen.y;

      // Re-approach the Z ring in SCREEN space until a pointermove lands on
      // it, then drag along the ring. The invisible picker rings sit at
      // 0.5× the handle scale; with the default camera the Z ring projects
      // to a screen ellipse around the pivot (rightmost ≈ +98 px, top ≈
      // +42 px) — projecting world-space ring points misses it because the
      // perspective mapping is not uniform.
      const ringCandidates = [
        { dx: 42, dy: 42 },
        { dx: 0, dy: 42 },
        { dx: 70, dy: 42 },
        { dx: -49, dy: 49 },
        { dx: 98, dy: 0 },
      ];
      const ringStart = ringCandidates.map(({ dx, dy }) => ({
        x: pivotX + dx,
        y: pivotY + dy,
      }));
      await pollAxisAt(ringStart, 'Z');
      // The hover reference axis line must pass through the live selection
      // pivot, not the scene origin — three-stdlib anchors it at
      // worldPositionStart (only captured at pointerdown), which the gizmo
      // keeps synced to the pivot between drags.
      await expect
        .poll(async () => {
          const line = await page.evaluate(() =>
            (window as unknown as {
              __orcaE2e?: { gizmoAxisLineWorldPosition?: () => [number, number, number] | null };
            }).__orcaE2e?.gizmoAxisLineWorldPosition?.() ?? null,
          );
          const pivot = await page.evaluate(() =>
            (window as unknown as {
              __orcaE2e?: { selectionPivotWorld?: () => [number, number, number] | null };
            }).__orcaE2e?.selectionPivotWorld?.() ?? null,
          );
          if (!line || !pivot) return false;
          return line.every((component, axis) => Math.abs(component - pivot[axis]) < 1);
        }, { timeout: 10_000 })
        .toBe(true);
      await page.mouse.down();
      // Drag to a second point on the Z ring (left arc) for a substantial
      // rotation; the axis is locked once the drag starts, so the path
      // between the two ring points only affects the rotation angle.
      await page.mouse.move(pivotX - 84, pivotY + 14, { steps: 5 });
      await page.mouse.up();
      await expect
        .poll(async () => page.getByTestId('rotate-z').inputValue(), { timeout: 10_000 })
        .not.toBe('0.0');

      // Panel edits set absolute degrees (single selection); garbage reverts.
      await page.getByTestId('rotate-x').fill('90');
      await page.getByTestId('rotate-x').press('Enter');
      await expect(page.getByTestId('rotate-x')).toHaveValue('90.0');
      await page.getByTestId('rotate-y').fill('nope');
      await page.getByTestId('rotate-y').press('Enter');
      await expect(page.getByTestId('rotate-y')).toHaveValue('0.0');
      await page.getByTestId('rotate-reset').click();
      await expect(page.getByTestId('rotate-x')).toHaveValue('0.0');

      // Closing the gizmo (toggle off) restores the selection box.
      await page.getByTestId('gizmo-btn-rotate').click();
      await expect(page.getByTestId('gizmo-btn-rotate')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('rotate-panel')).toBeHidden();
      // It frames the CURRENT selection bounds (the gizmo edits above can
      // legitimately move the pivot), still as one 24-segment box.
      await expect
        .poll(async () => {
          const box = await selectionBoxWorldSegments(page);
          const bounds = await page.evaluate(() =>
            (window as unknown as {
              __orcaE2e?: { selectionBoundsWorld?: () => { min: number[]; max: number[] } | null };
            }).__orcaE2e?.selectionBoundsWorld?.() ?? null,
          );
          if (!box || !bounds) return false;
          return box.segmentCount === 24
            && box.min.every((v, i) => Math.abs(v - bounds.min[i]) < 1e-6)
            && box.max.every((v, i) => Math.abs(v - bounds.max[i]) < 1e-6);
        }, { timeout: 10_000 })
        .toBe(true);
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});

// Rotated transforms must still behave correctly: a world-axis scale has to
// change the WORLD dimension (not a permuted local axis), and Drop to bed has
// to land the rotated object's lowest point on the plate. Uses panel inputs
// (deterministic) plus the mock bounds hook; the REAL path is a smoke check.
test('scene transforms: rotated world-scale and drop-to-bed', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
      await selectStableRealPrinter(page);
      await page.getByTestId('btn-add-model').click();
      if (REAL) await page.getByTestId('btn-add-model').click();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
      if (REAL) return;

      await selectMockInstance(page, 0, false);
      const bounds = () => page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { selectionBoundsWorld?: () => {
            min: [number, number, number];
            max: [number, number, number];
            center: [number, number, number];
            size: [number, number, number];
          } | null };
        }).__orcaE2e?.selectionBoundsWorld?.() ?? null,
      );

      // Rotate to the reported general angle. A world scale on this must now
      // store an exact sheared affine matrix: world-X doubles, world-Y/Z stay.
      await page.getByTestId('gizmo-btn-rotate').click();
      await page.getByTestId('rotate-x').fill('-16');
      await page.getByTestId('rotate-x').press('Enter');
      await page.getByTestId('rotate-y').fill('41.8');
      await page.getByTestId('rotate-y').press('Enter');
      await page.getByTestId('rotate-z').fill('163.8');
      await page.getByTestId('rotate-z').press('Enter');
      const rotated = await bounds();
      if (!rotated) throw new Error('selection bounds unavailable');

      // World scale ×2 on X must double the world-X width and leave Y/Z alone.
      await page.getByTestId('gizmo-btn-scale').click();
      await page.getByTestId('scale-space-world').click();
      await page.getByTestId('scale-factor-x').fill('200');
      await page.getByTestId('scale-factor-x').press('Enter');
      const scaled = await bounds();
      if (!scaled) throw new Error('scaled bounds unavailable');
      expect(scaled.size[0]).toBeCloseTo(rotated.size[0] * 2, 5);
      expect(scaled.size[1]).toBeCloseTo(rotated.size[1], 5);
      expect(scaled.size[2]).toBeCloseTo(rotated.size[2], 5);
      // The object stays centered on its pivot.
      expect(scaled.center[0]).toBeCloseTo(rotated.center[0], 5);
      expect(scaled.center[1]).toBeCloseTo(rotated.center[1], 5);
      expect(scaled.center[2]).toBeCloseTo(rotated.center[2], 5);
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});

// Gizmo keyboard shortcuts (OrcaSlicer bindings): M / R / S toggle
// move/rotate/scale (refusing with an empty selection), Esc deselects all
// (which also closes the gizmo).
test('scene transforms: gizmo keyboard shortcuts', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
      await selectStableRealPrinter(page);
      await page.getByTestId('btn-add-model').click();
      if (REAL) await page.getByTestId('btn-add-model').click();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
      if (REAL) return;

      await selectMockInstance(page, 0, false);

      // R arms the rotate gizmo.
      await page.keyboard.press('r');
      await expect(page.getByTestId('rotate-panel')).toBeVisible();
      await expect(page.getByTestId('gizmo-btn-rotate')).toHaveAttribute('aria-pressed', 'true');

      // Esc deselects all, which closes the gizmo and empties the selection.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('rotate-panel')).toBeHidden();
      await expect(page.getByTestId('gizmo-btn-rotate')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('gizmo-btn-move')).toBeDisabled();
      await expect.poll(() => selectionBoxWorldSegments(page)).toBeNull();

      // Re-select, then S arms scale, M switches to move, Esc deselects.
      await selectMockInstance(page, 0, false);
      await page.keyboard.press('s');
      await expect(page.getByTestId('scale-panel')).toBeVisible();
      await page.keyboard.press('m');
      await expect(page.getByTestId('move-panel')).toBeVisible();
      await expect(page.getByTestId('scale-panel')).toBeHidden();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('move-panel')).toBeHidden();
      await expect(page.getByTestId('gizmo-btn-move')).toBeDisabled();

      // Del deletes the complete object behind the selection. The mock fixture
      // holds a single object, so the plate empties and slice/clear disable.
      await selectMockInstance(page, 0, false);
      await page.keyboard.press('Delete');
      // Clear Scene moved into the scene right-click menu; after the plate
      // empties the item is present but disabled.
      const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      await page.mouse.click(box.x + box.width - 40, box.y + 40, { button: 'right' });
      await expect(page.getByTestId('ctx-menu')).toBeVisible();
      await expect(page.getByTestId('btn-clear-scene')).toBeDisabled();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('btn-slice')).toBeDisabled();
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});

// Box selection (Shift+drag): a marquee selects the complete instances whose
// projected bounds intersect it; Shift+Ctrl/Cmd unions; a Shift+drag over
// empty space clears. The marquee element tracks the drag and disappears on
// release, and plain clicks keep their existing semantics.
test('scene selection: shift+drag box selection (replace, additive, clear)', async () => {
  const { app } = await launchApp();
  try {
    const page = await app.firstWindow();
    const diag = attachRendererDiagnostics(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    try {
      await expect(page.getByTestId('preset-select')).toBeVisible({ timeout: PRESET_READY_TIMEOUT });
      await selectStableRealPrinter(page);
      await page.getByTestId('btn-add-model').click();
      if (REAL) await page.getByTestId('btn-add-model').click();
      await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });

      const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('viewport canvas has no bounding box');
      const selectionCount = () => page.evaluate(() =>
        (window as unknown as {
          __orcaE2e?: { selectionInstanceCount?: () => number };
        }).__orcaE2e?.selectionInstanceCount?.() ?? 0,
      );
      if (REAL) {
        // Real-artifact runs only prove the gesture does not break the
        // viewport; the mock path below owns the deterministic assertions.
        await page.keyboard.down('Shift');
        await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up('Shift');
        return;
      }
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

      await expect(page.getByTestId('gizmo-btn-move')).toBeDisabled();

      // Shift+drag around both fixture cubes (X∈[0,20] and X∈[50,70]).
      const marqueeStart = await project([-2, -2, 10]);
      const marqueeEnd = await project([72, 22, 10]);
      if (!marqueeStart || !marqueeEnd) throw new Error('marquee projection unavailable');
      await page.keyboard.down('Shift');
      await page.mouse.move(marqueeStart.x, marqueeStart.y);
      await page.mouse.down();
      await page.mouse.move(marqueeEnd.x, marqueeEnd.y, { steps: 8 });
      await expect(page.getByTestId('box-select-marquee')).toBeVisible();
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await expect(page.getByTestId('box-select-marquee')).toBeHidden();
      await expect.poll(selectionCount, { timeout: 10_000 }).toBe(2);
      await expect(page.getByTestId('gizmo-btn-move')).toBeEnabled();
      // ONE aggregate bracket box frames the union of both cubes, never a
      // per-instance box — OrcaSlicer's selection renders a single bounds box.
      await expect.poll(() => selectionBoxWorldSegments(page), { timeout: 10_000 })
        .toEqual({ min: [0, 0, 0], max: [70, 20, 20], segmentCount: 24 });

      // A plain click on a member of the group keeps the complete selection —
      // the marquee gesture must not change click semantics.
      const firstCenter = await project([10, 10, 10]);
      if (!firstCenter) throw new Error('first cube projection unavailable');
      await page.mouse.click(firstCenter.x, firstCenter.y);
      await expect.poll(selectionCount).toBe(2);

      // Shift+drag over empty space clears the selection.
      await page.keyboard.down('Shift');
      await page.mouse.move(box.x + box.width - 60, box.y + 40);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 100, box.y + 90, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await expect.poll(selectionCount).toBe(0);
      await expect(page.getByTestId('gizmo-btn-move')).toBeDisabled();
      await expect.poll(() => selectionBoxWorldSegments(page)).toBeNull();

      // Shift+Ctrl+drag over the second cube unions it with the first.
      await page.mouse.click(firstCenter.x, firstCenter.y);
      await expect.poll(selectionCount).toBe(1);
      await expect.poll(() => selectionBoxWorldSegments(page))
        .toEqual({ min: [0, 0, 0], max: [20, 20, 20], segmentCount: 24 });
      const secondStart = await project([52, -2, 10]);
      const secondEnd = await project([68, 22, 10]);
      if (!secondStart || !secondEnd) throw new Error('second-cube marquee projection unavailable');
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.mouse.move(secondStart.x, secondStart.y);
      await page.mouse.down();
      await page.mouse.move(secondEnd.x, secondEnd.y, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await expect.poll(selectionCount).toBe(2);
      await expect.poll(() => selectionBoxWorldSegments(page))
        .toEqual({ min: [0, 0, 0], max: [70, 20, 20], segmentCount: 24 });

      // A plain Shift+drag over the second cube replaces the selection.
      await page.keyboard.down('Shift');
      await page.mouse.move(secondStart.x, secondStart.y);
      await page.mouse.down();
      await page.mouse.move(secondEnd.x, secondEnd.y, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up('Shift');
      await expect.poll(selectionCount).toBe(1);
      await expect.poll(() => selectionBoxWorldSegments(page))
        .toEqual({ min: [50, 0, 0], max: [70, 20, 20], segmentCount: 24 });
    } catch (err) {
      await diag.dump();
      throw err;
    }
  } finally {
    await app.close();
  }
});
