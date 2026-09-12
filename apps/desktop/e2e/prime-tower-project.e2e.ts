// Real threaded regression for an imported multi-plate project whose native
// Process config enables a prime tower without a Neo overlay entry.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const PROJECT_PATH = process.env.ORCA_E2E_PRIME_TOWER_PROJECT
  ? resolve(process.env.ORCA_E2E_PRIME_TOWER_PROJECT)
  : 'E:\\OneDrive\\Dokumente\\3d打印\\模型\\奥德赛\\OddseyHelmetFinalParts+(2)wholemorecolor-h2d.3mf';
const REAL = process.env.ORCA_E2E_REAL === '1';
test.skip(!REAL || !PROJECT_PATH || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PRIME_TOWER_PROJECT');

test('opened project keeps prime-tower UI and first-plate slice in agreement', async () => {
  const exportDir = mkdtempSync(join(tmpdir(), 'orca-prime-tower-e2e-'));
  const exportPath = join(exportDir, 'first-plate.gcode');
  const preferencesPath = join(exportDir, 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  }));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_REAL: '1',
    ORCA_E2E_MODEL: PROJECT_PATH,
    ORCA_E2E_EXPORT: exportPath,
    ORCA_E2E_PREFERENCES: preferencesPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();

    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-open-project').click();
    // With an empty startup scene the configured load policy opens directly;
    // a dirty scene instead presents the explicit geometry/project choice.
    const choice = page.getByTestId('project-load-choice-dialog');
    if (await choice.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await page.getByTestId('project-load-project').click();
      await page.getByTestId('project-load-confirm').click();
    }
    const confirmation = page.getByTestId('project-load-confirmation-dialog');
    if (await confirmation.isVisible({ timeout: 30_000 }).catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await expect(page.getByTestId('project-progress-dialog')).toHaveCount(0, { timeout: 300_000 });

    // The native project contains eleven serialized plate previews. The
    // label instead reports the materialized PlateSessionSnapshot, so do not
    // equate it with that archive-preview count. Wait for the active first
    // plate and a valid session count; the later tower/history assertions
    // prove the multi-filament projection from the imported project.
    await expect(page.getByTestId('current-plate-label')).toHaveText(
      /^Plate 1 \(([1-9]|[12]\d|3[0-6])\/36\)$/,
      { timeout: 300_000 },
    );
    await expect(page.locator('#enable_prime_tower')).toBeChecked();
    await expect(page.locator('#wipe_tower_x')).toHaveCount(0);
    await expect(page.locator('#wipe_tower_y')).toHaveCount(0);

    const readTowers = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerStates?: () => Array<{
        plateId: string; current: boolean; eligible: boolean; position: { x: number; y: number };
        bands: number; colours: string[]; opacity: number[];
        footprint?: { minX: number; maxX: number; minY: number; maxY: number };
        buildArea?: { minX: number; maxX: number; minY: number; maxY: number };
        outsideBoundaryWarning?: boolean;
      }> } }).__orcaE2e?.primeTowerStates?.() ?? [],
    );
    const readSelection = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerSelection?: () => string | null } }).__orcaE2e?.primeTowerSelection?.() ?? null,
    );
    const readMoves = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerMoveCommands?: () => number } }).__orcaE2e?.primeTowerMoveCommands?.() ?? 0,
    );
    const readProxyIds = () => page.evaluate(() => {
      const hook = (window as unknown as { __orcaE2e?: { primeTowerProxyIds?: () => string[] } }).__orcaE2e;
      return hook?.primeTowerProxyIds?.() ?? null;
    });
    const readCurrentPlateId = () => page.evaluate(() => {
      const beds = (window as unknown as { __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; current: boolean }> } }).__orcaE2e?.bedPlateStates?.() ?? [];
      return beds.find((bed) => bed.current)?.plateId ?? null;
    });
    const readHistory = async () => {
      const menuTrigger = page.getByTestId('history-undo-menu-trigger');
      if (!(await menuTrigger.isEnabled())) return [] as string[];
      await menuTrigger.click();
      const labels = await page.getByTestId(/history-undo-entry-/).allTextContents();
      await page.keyboard.press('Escape');
      return labels;
    };
    // The project owns eleven plates, but native eligibility intentionally
    // projects only its eight painted/multi-filament plates.  The remaining
    // single-filament plates are not Prime Tower scene volumes.
    await expect.poll(async () => (await readTowers()).length, { timeout: 300_000 }).toBe(8);
    await expect(page.getByTestId('project-progress-message')).toHaveCount(0, { timeout: 300_000 });
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 300_000 });
    const towers = await readTowers();
    await expect.poll(readProxyIds, { timeout: 30_000 }).toEqual(towers.filter((tower) => tower.eligible).map((tower) => tower.plateId).sort());
    const current = towers.find((tower) => tower.current);
    expect(current).toBeDefined();
    expect(current?.eligible).toBe(true);
    expect(current?.bands).toBe(2);
    expect(current?.colours).toEqual(['#E5B03D', '#333333']);
    expect(current?.opacity.every((value) => Math.abs(value - 0.66) < 0.01)).toBe(true);
    // Plates without a multi-filament transition remain visible as inert
    // projections; only eligible plates expose interaction geometry.
    expect(towers.filter((tower) => tower.eligible).length).toBe(8);
    const other = towers.find((tower) => !tower.current);
    expect(other).toBeDefined();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const beds = await page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; position: [number, number, number] }> } }).__orcaE2e?.bedPlateStates?.() ?? [],
    );
    const otherBed = beds.find((bed) => bed.plateId === other!.plateId)?.position ?? [0, 0, 0];
    const projectWorldToScreen = (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => { x: number; y: number } | null } }).__orcaE2e?.projectWorldToScreen?.(p) ?? null, point);
    const otherPoint = await projectWorldToScreen([otherBed[0] + other!.position.x + 5, otherBed[1] + other!.position.y + 5, 9]);
    expect(otherPoint).not.toBeNull();
    await page.mouse.click(box!.x + otherPoint!.x, box!.y + otherPoint!.y);
    await expect.poll(readSelection).not.toBe(other!.plateId);

    // The test-only projection helper supplies exact canvas coordinates, so a
    // large gesture can prove native boundary clamping without pixel diffs.
    const currentBed = await page.evaluate((plateId) => {
      const beds = (window as unknown as { __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; position: [number, number, number] }> } }).__orcaE2e?.bedPlateStates?.() ?? [];
      return beds.find((bed) => bed.plateId === plateId)?.position ?? [0, 0, 0];
    }, current!.plateId);
    // Locate a body point through the same scene ray path used by the user.
    // Imported projects can place/rotate towers differently, so a fixed
    // corner pixel is not a reliable hit even when the proxy is present.
    let start: { x: number; y: number } | null = null;
    const footprint = current!.footprint;
    expect(footprint).toBeDefined();
    const footprintWidth = Math.max(20, footprint!.maxX - footprint!.minX);
    const footprintDepth = Math.max(20, footprint!.maxY - footprint!.minY);
    for (let dx = 4; dx <= footprintWidth; dx += 8) {
      for (let dy = 4; dy <= footprintDepth; dy += 8) {
        const candidate = await projectWorldToScreen([
          currentBed[0] + current!.position.x + dx,
          currentBed[1] + current!.position.y + dy,
          9,
        ]);
        if (!candidate) continue;
        await page.mouse.click(box!.x + candidate.x, box!.y + candidate.y);
        if (await readSelection() === current!.plateId) {
          start = candidate;
          break;
        }
      }
      if (start) break;
    }
    expect(start, 'current Prime Tower body should be selectable through the real canvas ray').not.toBeNull();
    // The imported tower may begin at any native boundary, and its screen
    // axes depend on the fitted camera. During one captured gesture, try the
    // four outside-canvas directions until DragControls reports a local
    // draft. No pointer-up occurs before that draft, so this remains exactly
    // one native Move Prime Tower history operation.
    const dragTargets = [
      { x: box!.x - 800, y: box!.y - 800 },
      { x: box!.x + box!.width + 800, y: box!.y - 800 },
      { x: box!.x - 800, y: box!.y + box!.height + 800 },
      { x: box!.x + box!.width + 800, y: box!.y + box!.height + 800 },
    ];
    const historyBefore = await readHistory();
    const movesBefore = await readMoves();
    await page.mouse.move(box!.x + start!.x, box!.y + start!.y);
    await page.mouse.down();
    let drafted = false;
    for (const target of dragTargets) {
      await page.mouse.move(target.x, target.y, { steps: 4 });
      const draft = (await readTowers()).find((tower) => tower.current)?.position;
      if (draft && (draft.x !== current!.position.x || draft.y !== current!.position.y)) {
        drafted = true;
        break;
      }
    }
    expect(drafted, 'one outside-canvas direction should produce a local Prime Tower draft').toBe(true);
    expect(await readMoves()).toBe(movesBefore);
    await page.mouse.up();
    await expect.poll(readMoves).toBe(movesBefore + 1);
    // The native move commits before the toolbar's FIFO status publication;
    // wait for that authoritative label before opening the history menu.
    await expect(page.getByTestId('history-undo')).toHaveAttribute(
      'aria-label', 'Undo Move Prime Tower', { timeout: 30_000 });
    await expect.poll(async () => {
      const labels = await readHistory();
      return labels.length === historyBefore.length + 1 && labels[0] === 'Move Prime Tower';
    }, { timeout: 30_000 }).toBe(true);
    const clamped = (await readTowers()).find((tower) => tower.current);
    expect(clamped?.position).not.toEqual(current!.position);
    const movedPosition = clamped?.position;
    expect(movedPosition).toBeDefined();

    // Pointer-up must publish the native wipe_tower_x/y values immediately;
    // undo and redo then exercise the same authoritative config path rather
    // than replaying a renderer-only projection.
    await page.getByTestId('history-undo').click();
    await expect.poll(async () => (await readTowers()).find((tower) => tower.current)?.position)
      .toEqual(current!.position);
    await expect(page.getByTestId('history-redo')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('history-redo').click();
    await expect.poll(async () => (await readTowers()).find((tower) => tower.current)?.position)
      .toEqual(movedPosition);
    // Undo/redo of the narrow tower entry must not corrupt the imported
    // multi-filament routing projection while rebuilding the active plate.
    await expect(page.getByTestId('filament-add')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('filament-rejected')).toHaveCount(0);
    await expect(page.getByTestId('slicer-error')).toHaveCount(0);

    // Coordinates cross the native ConfigOptionFloat wire at six decimal
    // places, so accept only the tiny serialization edge while proving the
    // clamped footprint cannot leave the build area in a material amount.
    const boundaryTolerance = 0.001;
    expect(clamped?.footprint?.minX).toBeGreaterThanOrEqual((clamped?.buildArea?.minX ?? 0) - boundaryTolerance);
    expect(clamped?.footprint?.maxX).toBeLessThanOrEqual((clamped?.buildArea?.maxX ?? 0) + boundaryTolerance);
    expect(clamped?.footprint?.minY).toBeGreaterThanOrEqual((clamped?.buildArea?.minY ?? 0) - boundaryTolerance);
    expect(clamped?.footprint?.maxY).toBeLessThanOrEqual((clamped?.buildArea?.maxY ?? 0) + boundaryTolerance);

    await expect.poll(readCurrentPlateId).toBe(current!.plateId);
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 300_000 });
    await expect.poll(readCurrentPlateId).toBe(current!.plateId);
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true);
    await expect.poll(readCurrentPlateId).toBe(current!.plateId);
    const gcode = readFileSync(exportPath, 'utf8');
    // Match emitted toolpath markers, rather than configuration headers or
    // filament-change/flush templates that may mention a tower without one.
    expect(gcode).toMatch(/^; WIPE_TOWER_START$/m);
    expect(gcode).toMatch(/^; FEATURE: Prime tower$/m);
    await page.locator('#app-tab-preview').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
    await expect.poll(readCurrentPlateId).toBe(current!.plateId);
    await expect.poll(readProxyIds, { timeout: 30_000 }).toBeNull();
  } finally {
    await app.close();
  }
});
