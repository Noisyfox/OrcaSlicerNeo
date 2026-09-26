// Real threaded regression for an imported multi-plate project whose native
// Process config enables a prime tower without a Neo overlay entry.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const DESKTOP_ROOT = resolve(__dirname, '..');
const configuredProjectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
const PROJECT_PATH = configuredProjectPath ? resolve(configuredProjectPath) : '';
const PROJECT_FILE_NAME = PROJECT_PATH ? basename(PROJECT_PATH) : '';
const REAL = process.env.ORCA_E2E_REAL === '1';
test.skip(!REAL || !PROJECT_PATH || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PRIME_TOWER_PROJECT');
// The real serial artifact may spend several minutes generating the imported
// fixture's 743-layer first-plate Print. Keep the test-level budget above the
// explicit 600 s slice completion boundary so Playwright cannot mask it.
test.setTimeout(900_000);

async function expectFilamentRackReady(page: Page): Promise<void> {
  await expect(page.getByTestId('filament-rejected')).toHaveCount(0);
  const capacity = page.getByTestId('filament-rack').locator('span').filter({ hasText: /^\d+\/\d+$/ }).first();
  const text = await capacity.textContent();
  const match = text?.trim().match(/^(\d+)\/(\d+)$/);
  expect(match, `filament rack capacity must be visible, received ${text ?? '<none>'}`).not.toBeNull();
  const used = Number(match![1]);
  const maximum = Number(match![2]);
  expect(used).toBeGreaterThan(0);
  expect(maximum).toBeGreaterThanOrEqual(used);
  // This imported printer may be a fixed-extruder profile, where native
  // `canAdd` is false even below the generic 64-slot ceiling. The history
  // contract here is a healthy rack projection, not permission to add slots.
  await expect(page.getByTestId('filament-add')).toHaveCount(1);
}

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
    ORCA_E2E_PRIME_TOWER_PROJECT: PROJECT_PATH,
    ORCA_E2E_MODEL: PROJECT_PATH,
    ORCA_E2E_EXPORT: exportPath,
    ORCA_E2E_PREFERENCES: preferencesPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    const rendererErrors: string[] = [];
    const recordRendererError = (message: string) => {
      rendererErrors.push(message);
      if (rendererErrors.length > 20) rendererErrors.shift();
    };
    page.on('pageerror', (error) => recordRendererError(`pageerror: ${error.message}`));
    page.on('crash', () => recordRendererError('renderer crashed'));
    page.on('console', (message) => {
      if (message.type() === 'error') recordRendererError(`console: ${message.text()}`);
    });
    const clickPreviewTab = async (label: string) => {
      try {
        await page.locator('#app-tab-preview').click();
      } catch (error) {
        const pageState = await Promise.race([
          page.evaluate(() => ({
            href: window.location.href,
            readyState: document.readyState,
            bodyText: document.body?.innerText.slice(0, 2_000) ?? null,
            bodyHtml: document.body?.outerHTML.slice(0, 2_000) ?? null,
          })).catch((evaluateError: unknown) => ({ evaluateError: String(evaluateError) })),
          new Promise<{ evaluateTimeout: true }>((resolve) => setTimeout(() => resolve({ evaluateTimeout: true }), 5_000)),
        ]);
        const diagnostics = { label, pageState, rendererErrors };
        console.error('[real Prime Tower E2E] Preview tab unavailable', JSON.stringify(diagnostics));
        await test.info().attach('missing-preview-state', {
          body: Buffer.from(JSON.stringify(diagnostics, null, 2)), contentType: 'application/json',
        });
        await page.screenshot({ path: test.info().outputPath('missing-preview.png'), timeout: 5_000 }).catch(() => {});
        throw error;
      }
    };
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

    const readProjectLoadEvidence = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => {
        receipt: { sourceDisplayName: string; sourceByteLength: number; commitRoute: string; nativeResult: {
          ok: boolean; mode?: string; displayName?: string; objects: number; instances: number;
          projectSettingsAvailable?: boolean; multiPlate?: boolean; plateCount?: number;
        } } | null;
        session: { projectName: string; hasContent: boolean; scope: string; hasLocation: boolean };
      } } }).__orcaE2e?.projectLoadEvidence?.() ?? null,
    );
    // Prove the requested 3MF, rather than a fixture or stale/default path,
    // was committed into the native project session before tower assertions.
    await expect.poll(readProjectLoadEvidence, { timeout: 300_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: PROJECT_FILE_NAME,
        sourceByteLength: statSync(PROJECT_PATH).size,
        commitRoute: 'load-project',
        nativeResult: {
          ok: true, mode: 'project', displayName: PROJECT_FILE_NAME,
          projectSettingsAvailable: true, multiPlate: true, plateCount: 11,
        },
      },
      session: {
        projectName: PROJECT_FILE_NAME.replace(/\.3mf$/i, ''),
        hasContent: true, scope: 'project', hasLocation: true,
      },
    });

    // The native project contains eleven serialized plate previews. The
    // label instead reports the materialized PlateSessionSnapshot, so do not
    // equate it with that archive-preview count. Wait for the active first
    // plate and a valid session count; the later tower/history assertions
    // prove the multi-filament projection from the imported project.
    await expect(page.getByTestId('current-plate-label')).toBeVisible({ timeout: 300_000 });
    await expect(page.getByTestId('config-field-enable_prime_tower').getByRole('checkbox')).toBeChecked();
    await expect(page.locator('#wipe_tower_x')).toHaveCount(0);
    await expect(page.locator('#wipe_tower_y')).toHaveCount(0);

    const readTowers = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerStates?: () => Array<{
        plateId: string; displayIndex: number; current: boolean; eligible: boolean; position: { x: number; y: number };
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
    const readCommitBusy = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerCommitBusy?: () => boolean } }).__orcaE2e?.primeTowerCommitBusy?.() ?? false,
    );
    const readPointerOwner = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { pointerOwner?: () => string } }).__orcaE2e?.pointerOwner?.() ?? 'none',
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
      const entries = page.getByTestId(/history-undo-entry-/);
      await expect(entries.first()).toBeVisible({ timeout: 30_000 });
      const labels = await entries.allTextContents();
      await menuTrigger.click();
      await expect(entries).toHaveCount(0);
      await expect(page.locator('[data-base-ui-inert]')).toHaveCount(0);
      return labels;
    };
    // The pinned big-proj.3mf fixture owns eleven serialized plates and
    // materializes ten Prime Tower projections in the scene.
    await expect.poll(async () => (await readTowers()).length, { timeout: 300_000 }).toBe(10);
    await expect(page.getByTestId('project-progress-message')).toHaveCount(0, { timeout: 300_000 });
    await expect(page.locator('[role="dialog"]')).toHaveCount(0, { timeout: 300_000 });
    const towers = await readTowers();
    await expect.poll(readProxyIds, { timeout: 30_000 }).toEqual(towers.filter((tower) => tower.eligible).map((tower) => tower.plateId).sort());
    const current = towers.find((tower) => tower.current);
    expect(current).toBeDefined();
    expect(current?.eligible).toBe(true);
    expect(current?.bands).toBe(3);
    // big-proj.3mf resolves its first plate's three material bands in native
    // slot order (red, yellow, then light gray).
    expect(current?.colours).toEqual(['#E72F1D', '#F4C032', '#E5E5E5']);
    expect(current?.opacity.every((value) => Math.abs(value - 0.66) < 0.01)).toBe(true);
    // Every projected tower is eligible and has a distinct native plate
    // identity; this proves the tenth count is not a duplicate proxy.
    expect(towers.every((tower) => tower.eligible)).toBe(true);
    expect(new Set(towers.map((tower) => tower.plateId)).size).toBe(10);
    const other = towers.find((tower) => !tower.current);
    expect(other).toBeDefined();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const beds = await page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { bedPlateStates?: () => Array<{ plateId?: string; position: [number, number, number]; bounds?: { minX: number; maxX: number; minY: number; maxY: number } }> } }).__orcaE2e?.bedPlateStates?.() ?? [],
    );
    const otherBed = beds.find((bed) => bed.plateId === other!.plateId)?.position ?? [0, 0, 0];
    const projectWorldToScreen = (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => { x: number; y: number } | null } }).__orcaE2e?.projectWorldToScreen?.(p) ?? null, point);
    // Imported plate rotations/footprints vary by native profile. Search the
    // authoritative footprint through the same scene ray path instead of
    // assuming one fixed corner pixel is inside the rendered tower.
    expect(other!.footprint).toBeDefined();
    const otherWidth = Math.max(20, other!.footprint!.maxX - other!.footprint!.minX);
    const otherDepth = Math.max(20, other!.footprint!.maxY - other!.footprint!.minY);
    let otherPoint: { x: number; y: number } | null = null;
    for (let dx = 4; dx <= otherWidth; dx += 8) {
      for (let dy = 4; dy <= otherDepth; dy += 8) {
        const candidate = await projectWorldToScreen([
          otherBed[0] + other!.position.x + dx,
          otherBed[1] + other!.position.y + dy,
          9,
        ]);
        if (!candidate) continue;
        await page.mouse.click(box!.x + candidate.x, box!.y + candidate.y);
        if (await readSelection() === other!.plateId) {
          otherPoint = candidate;
          break;
        }
      }
      if (otherPoint) break;
    }
    expect(otherPoint, 'the non-current tower must be selectable through the real scene ray').not.toBeNull();

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
    const positionErrorFor = (plateId: string, expected: { x: number; y: number }) => page.evaluate(({ id, wanted }) => {
      const towers = (window as unknown as { __orcaE2e?: { primeTowerStates?: () => Array<{ current: boolean; position: { x: number; y: number } }> } })
        .__orcaE2e?.primeTowerStates?.() ?? [];
      const actual = towers.find((tower) => (tower as { plateId?: string }).plateId === id)?.position;
      return actual ? Math.max(Math.abs(actual.x - wanted.x), Math.abs(actual.y - wanted.y)) : Number.POSITIVE_INFINITY;
    }, { id: plateId, wanted: expected });
    const positionError = (expected: { x: number; y: number }) => positionErrorFor(current!.plateId, expected);
    await page.getByTestId('history-undo').click();
    await expect.poll(() => positionError(current!.position)).toBeLessThan(0.001);
    await expect(page.getByTestId('history-redo')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('history-redo').click();
    await expect.poll(() => positionError(movedPosition!)).toBeLessThan(0.001);
    await expect.poll(readCommitBusy).toBe(false);

    // A tower on another displayed plate is also a real scene target.  Drag
    // it toward/through the neighbouring plate area and assert that native
    // clamping remains local to its own plate.  The active plate and its
    // tower must remain untouched, and the move must still be one history
    // operation for the selected plateId.
    const currentBeforeOtherDrag = (await readTowers()).find((tower) => tower.current)!;
    const otherBeforeDrag = (await readTowers()).find((tower) => tower.plateId === other!.plateId)!;
    await page.mouse.click(box!.x + otherPoint!.x, box!.y + otherPoint!.y);
    await expect.poll(readSelection).toBe(other!.plateId);
    const historyBeforeOther = await readHistory();
    const movesBeforeOther = await readMoves();
    await page.mouse.move(box!.x + otherPoint!.x, box!.y + otherPoint!.y);
    await page.mouse.down();
    // This tower can sit near the canvas edge. Cross DragControls' movement
    // threshold while still inside the canvas before trying outside targets.
    await page.mouse.move(box!.x + otherPoint!.x - 24, box!.y + otherPoint!.y + 12, { steps: 3 });
    await expect.poll(readPointerOwner).toBe('body');
    let otherDrafted = false;
    for (const target of dragTargets) {
      await page.mouse.move(target.x, target.y, { steps: 4 });
      const draft = (await readTowers()).find((tower) => tower.plateId === other!.plateId)?.position;
      if (draft && (draft.x !== otherBeforeDrag.position.x || draft.y !== otherBeforeDrag.position.y)) {
        otherDrafted = true;
        break;
      }
    }
    expect(otherDrafted, 'non-current Prime Tower should produce a local draft').toBe(true);
    await page.mouse.up();
    await expect.poll(readMoves).toBe(movesBeforeOther + 1);
    await expect.poll(async () => {
      const labels = await readHistory();
      return labels.length === historyBeforeOther.length + 1 && labels[0] === 'Move Prime Tower';
    }, { timeout: 30_000 }).toBe(true);
    const otherMoved = (await readTowers()).find((tower) => tower.plateId === other!.plateId)!;
    expect(otherMoved.position).not.toEqual(otherBeforeDrag.position);
    await expect.poll(() => positionError(currentBeforeOtherDrag.position)).toBeLessThan(0.001);
    await expect.poll(readCurrentPlateId).toBe(current!.plateId);
    const otherTolerance = 0.001;
    expect(otherMoved.footprint?.minX).toBeGreaterThanOrEqual((otherMoved.buildArea?.minX ?? 0) - otherTolerance);
    expect(otherMoved.footprint?.maxX).toBeLessThanOrEqual((otherMoved.buildArea?.maxX ?? 0) + otherTolerance);
    expect(otherMoved.footprint?.minY).toBeGreaterThanOrEqual((otherMoved.buildArea?.minY ?? 0) - otherTolerance);
    expect(otherMoved.footprint?.maxY).toBeLessThanOrEqual((otherMoved.buildArea?.maxY ?? 0) + otherTolerance);
    await page.getByTestId('history-undo').click();
    await expect.poll(() => positionErrorFor(other!.plateId, otherBeforeDrag.position)).toBeLessThan(0.001);
    await expect.poll(() => positionError(currentBeforeOtherDrag.position)).toBeLessThan(0.001);
    await page.getByTestId('history-redo').click();
    await expect.poll(() => positionErrorFor(other!.plateId, otherMoved.position)).toBeLessThan(0.001);
    await expect.poll(readCurrentPlateId).toBe(current!.plateId);
    // Undo/redo of the narrow tower entry must not corrupt the imported
    // multi-filament routing projection while rebuilding the active plate.
    await expectFilamentRackReady(page);
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
    const firstTowerAfterOperations = (await readTowers()).find((tower) => tower.current);
    expect(firstTowerAfterOperations).toBeDefined();
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 600_000 });
    await expect.poll(readCurrentPlateId).toBe(current!.plateId);
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath), { timeout: 30_000 }).toBe(true);
    const gcode = readFileSync(exportPath, 'utf8');
    // Match emitted toolpath markers, rather than configuration headers or
    // filament-change/flush templates that may mention a tower without one.
    expect(gcode).toMatch(/^; WIPE_TOWER_START$/m);
    // Current Orca core emits the feature marker as a TYPE comment in the
    // imported printer's dialect; the former FEATURE marker was stale.
    expect(gcode).toMatch(/^;TYPE:Prime tower$/m);

    // The reusable native Print is also exercised against two explicitly
    // indexed plates.  Read the first two eligible scene projections in
    // display order; imported projects may legitimately have non-eligible
    // plates, so the selected native indices remain explicit in the proof.
    const eligibleByIndex = towers.filter((tower) => tower.eligible).sort((a, b) => a.displayIndex - b.displayIndex);
    expect(eligibleByIndex.length).toBeGreaterThanOrEqual(2);
    const indexedFirst = eligibleByIndex[0]!;
    const indexedSecond = eligibleByIndex[1]!;
    expect(current?.displayIndex).toBe(indexedFirst.displayIndex);
    expect(current?.plateId).toBe(indexedFirst.plateId);
    expect(firstTowerAfterOperations!.plateId).toBe(indexedFirst.plateId);
    expect(indexedSecond.displayIndex).toBeGreaterThan(indexedFirst.displayIndex);
    const clickPlateBed = async (plateId: string) => {
      // Keep the initial all-plate bed projection: slicing temporarily
      // replaces the active scene projection and can hide non-current beds.
      const bed = beds.find((candidate) => candidate.plateId === plateId);
      if (!bed) {
        await page.locator('#app-tab-preview').click();
        const item = page.getByTestId(`preview-plate-${plateId}`);
        await expect(item).toBeVisible({ timeout: 30_000 });
        await item.scrollIntoViewIfNeeded();
        await item.click();
        await expect.poll(readCurrentPlateId, { timeout: 30_000 }).toBe(plateId);
        await page.locator('#app-tab-prepare').click();
        return;
      }
      const candidates: Array<[number, number]> = [[5, 5], [215, 5], [5, 215], [215, 215], [110, 110]];
      for (const [x, y] of candidates) {
        const point = await projectWorldToScreen([bed!.position[0] + x, bed!.position[1] + y, bed!.position[2]]);
        if (!point) continue;
        await page.mouse.click(box!.x + point.x, box!.y + point.y);
        if (await readCurrentPlateId() === plateId) return;
      }
      // The preview list is the authoritative UI fallback after a slice has
      // replaced the prepare scene with only the active bed.
      await page.locator('#app-tab-preview').click();
      const item = page.getByTestId(`preview-plate-${plateId}`);
      await expect(item).toBeVisible({ timeout: 30_000 });
      await item.scrollIntoViewIfNeeded();
      await item.click();
      await expect.poll(readCurrentPlateId, { timeout: 30_000 }).toBe(plateId);
      await page.locator('#app-tab-prepare').click();
    };
    const readPrimeTowerEvidence = (source: string) => {
      const xLines = [...source.matchAll(/^; wipe_tower_x = ([^\r\n]+)$/gm)].map((match) => match[1]!);
      const yLines = [...source.matchAll(/^; wipe_tower_y = ([^\r\n]+)$/gm)].map((match) => match[1]!);
      const xValues = xLines.find((line) => line.includes(','))?.split(',').map(Number) ?? [];
      const yValues = yLines.find((line) => line.includes(','))?.split(',').map(Number) ?? [];
      const selectedX = Number(xLines.find((line) => !line.includes(',')));
      const selectedY = Number(yLines.find((line) => !line.includes(',')));
      expect(Number.isFinite(selectedX), 'G-code must emit the selected native wipe_tower_x').toBe(true);
      expect(Number.isFinite(selectedY), 'G-code must emit the selected native wipe_tower_y').toBe(true);
      expect(xValues.length, 'G-code must retain the complete native wipe_tower_x array').toBeGreaterThan(1);
      expect(yValues.length, 'G-code must retain the complete native wipe_tower_y array').toBe(xValues.length);
      const marker = source.indexOf(';TYPE:Prime tower');
      expect(marker, 'Prime Tower feature marker is required').toBeGreaterThanOrEqual(0);
      const start = source.indexOf('; WIPE_TOWER_START', marker);
      const end = source.indexOf('; WIPE_TOWER_END', start);
      expect(start, 'Prime Tower toolpath start marker is required').toBeGreaterThan(marker);
      expect(end, 'Prime Tower toolpath end marker is required').toBeGreaterThan(start);
      let x: number | undefined;
      let y: number | undefined;
      const points: Array<[number, number]> = [];
      for (const line of source.slice(start, end).split(/\r?\n/)) {
        if (!/^G[123]\b/.test(line)) continue;
        const xMatch = line.match(/\bX(-?\d+(?:\.\d+)?)/);
        const yMatch = line.match(/\bY(-?\d+(?:\.\d+)?)/);
        if (xMatch) x = Number(xMatch[1]);
        if (yMatch) y = Number(yMatch[1]);
        if (x !== undefined && y !== undefined) points.push([x, y]);
      }
      expect(points.length, 'Prime Tower toolpath must contain XY motion').toBeGreaterThan(0);
      return {
        native: { x: xValues, y: yValues },
        // Orca emits the selected scalar immediately before the complete
        // array. This is the actual Print plate-index value consumed by the
        // generated toolpath; the complete arrays are retained for mapping.
        actual: { x: selectedX, y: selectedY },
        motion: {
          minX: Math.min(...points.map(([x]) => x)), maxX: Math.max(...points.map(([x]) => x)),
          minY: Math.min(...points.map(([, y]) => y)), maxY: Math.max(...points.map(([, y]) => y)),
        },
      };
    };
    const expectPrimeTowerPosition = (source: string, tower: typeof indexedFirst, label: string) => {
      const evidence = readPrimeTowerEvidence(source);
      const nativeX = evidence.native.x[tower.displayIndex];
      const nativeY = evidence.native.y[tower.displayIndex];
      expect(nativeX, `${label} native wipe_tower_x index`).toBeCloseTo(tower.position.x, 5);
      expect(nativeY, `${label} native wipe_tower_y index`).toBeCloseTo(tower.position.y, 5);
      // The selected scalar is the value consumed by Print for this export;
      // unlike the full array it changes with Print::plate_index.
      // G-code config scalars are emitted at three decimal places, while the
      // native arrays retain their full parsed precision.
      expect(evidence.actual.x, `${label} G-code Prime Tower X`).toBeCloseTo(nativeX!, 2);
      expect(evidence.actual.y, `${label} G-code Prime Tower Y`).toBeCloseTo(nativeY!, 2);
      // The marker-scoped XY moves are the actual emitted tower geometry, not
      // merely the configuration header.  They must stay inside the native
      // plate-local projected footprint.
      expect(evidence.motion.minX, `${label} G-code tower min X`).toBeGreaterThanOrEqual((tower.footprint?.minX ?? nativeX!) - 1);
      expect(evidence.motion.maxX, `${label} G-code tower max X`).toBeLessThanOrEqual((tower.footprint?.maxX ?? nativeX!) + 1);
      expect(evidence.motion.minY, `${label} G-code tower min Y`).toBeGreaterThanOrEqual((tower.footprint?.minY ?? nativeY!) - 1);
      expect(evidence.motion.maxY, `${label} G-code tower max Y`).toBeLessThanOrEqual((tower.footprint?.maxY ?? nativeY!) + 1);
      return evidence;
    };
    const firstEvidence = expectPrimeTowerPosition(gcode, firstTowerAfterOperations!, `plate ${indexedFirst.displayIndex + 1}`);

    const readPreviewToolpathWorldBounds = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { previewToolpathWorldBounds?: () => {
        min: [number, number, number]; max: [number, number, number];
      } | null } }).__orcaE2e?.previewToolpathWorldBounds?.() ?? null,
    );
    const assertPreviewBounds = (
      previewBounds: { min: [number, number, number]; max: [number, number, number] },
      plate: { position: [number, number, number]; bounds?: { minX: number; maxX: number; minY: number; maxY: number } },
      adjacentPlate: { position: [number, number, number] },
      label: string,
    ) => {
      // Preview coordinates are world-space. Every extrusion endpoint must
      // stay inside the selected plate's translated printable rectangle, and
      // must not leak into the adjacent plate's footprint.
      const bounds = plate.bounds ?? { minX: 0, maxX: 220, minY: 0, maxY: 220 };
      const tolerance = 0.5;
      expect(previewBounds.min[0], `${label} extrusion min X`).toBeGreaterThanOrEqual(plate.position[0] + bounds.minX - tolerance);
      expect(previewBounds.max[0], `${label} extrusion max X`).toBeLessThanOrEqual(plate.position[0] + bounds.maxX + tolerance);
      expect(previewBounds.min[1], `${label} extrusion min Y`).toBeGreaterThanOrEqual(plate.position[1] + bounds.minY - tolerance);
      expect(previewBounds.max[1], `${label} extrusion max Y`).toBeLessThanOrEqual(plate.position[1] + bounds.maxY + tolerance);
      expect(previewBounds.max[0], `${label} extrusion has X extent`).toBeGreaterThan(previewBounds.min[0]);
      expect(previewBounds.max[1], `${label} extrusion has Y extent`).toBeGreaterThan(previewBounds.min[1]);
      if (plate.position[0] >= adjacentPlate.position[0]) {
        expect(previewBounds.min[0], `${label} extrusion excludes adjacent plate`).toBeGreaterThan(adjacentPlate.position[0] + bounds.maxX + tolerance);
      } else {
        expect(previewBounds.max[0], `${label} extrusion excludes adjacent plate`).toBeLessThan(adjacentPlate.position[0] + bounds.minX - tolerance);
      }
    };
    await clickPreviewTab('after first export');
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
    await expect.poll(readCurrentPlateId, { timeout: 30_000 }).toBe(indexedFirst.plateId);
    await expect.poll(readPreviewToolpathWorldBounds, { timeout: 30_000 }).not.toBeNull();
    const firstPreviewBounds = await readPreviewToolpathWorldBounds();
    expect(firstPreviewBounds).not.toBeNull();
    const firstBed = beds.find((bed) => bed.plateId === indexedFirst.plateId) ?? { position: [0, 0, 0] as [number, number, number] };
    const firstAdjacentBed = beds.find((bed) => bed.plateId !== indexedFirst.plateId) ?? { position: [0, 0, 0] as [number, number, number] };
    assertPreviewBounds(firstPreviewBounds!, firstBed, firstAdjacentBed, `plate ${indexedFirst.displayIndex + 1}`);
    await page.locator('#app-tab-prepare').click();

    // Select and really slice the next eligible plate. The export path is
    // overwritten by the same Electron save boundary, then parsed from disk.
    await clickPlateBed(indexedSecond.plateId);
    await expect(page.getByTestId('btn-slice')).toBeEnabled({ timeout: 30_000 });
    await expect.poll(async () => (await readTowers()).find((tower) => tower.plateId === indexedSecond.plateId), { timeout: 30_000 }).toBeDefined();
    const secondTowerBeforeSlice = (await readTowers()).find((tower) => tower.plateId === indexedSecond.plateId);
    expect(secondTowerBeforeSlice).toBeDefined();
    expect(secondTowerBeforeSlice!.plateId).toBe(indexedSecond.plateId);
    const firstExportMtime = statSync(exportPath).mtimeMs;
    await page.getByTestId('btn-slice').click();
    // Do not accept the previous plate's already-Sliced status as proof that
    // the second target ran.  Wait for the real native slice transition and
    // for the Electron export file to be replaced.
    await expect.poll(() => page.getByTestId('slicer-status').textContent(), { timeout: 30_000 }).toMatch(/^Slicing/);
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 600_000 });
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath) && statSync(exportPath).mtimeMs > firstExportMtime, { timeout: 30_000 }).toBe(true);
    const secondGcode = readFileSync(exportPath, 'utf8');
    const secondEvidence = expectPrimeTowerPosition(secondGcode, secondTowerBeforeSlice!, `plate ${indexedSecond.displayIndex + 1}`);
    // Distinct native plate identity is the isolation contract; two plates
    // may legitimately use the same tower coordinates. `expectPrimeTowerPosition`
    // above already proves this export consumed the second plate's indexed
    // values, so do not require stale coordinate inequality here.
    expect(indexedSecond.plateId).not.toBe(indexedFirst.plateId);
    expect(indexedSecond.displayIndex).not.toBe(indexedFirst.displayIndex);

    await clickPreviewTab('after second export');
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
    await expect.poll(readCurrentPlateId, { timeout: 30_000 }).toBe(indexedSecond.plateId);
    await expect.poll(readPreviewToolpathWorldBounds, { timeout: 30_000 }).not.toBeNull();
    const secondPreviewBounds = await readPreviewToolpathWorldBounds();
    expect(secondPreviewBounds).not.toBeNull();
    const secondBed = beds.find((bed) => bed.plateId === indexedSecond.plateId) ?? { position: [0, 0, 0] as [number, number, number] };
    assertPreviewBounds(secondPreviewBounds!, secondBed, firstBed, `plate ${indexedSecond.displayIndex + 1}`);
    expect(Math.abs(secondPreviewBounds!.min[0] - firstPreviewBounds!.min[0])).toBeGreaterThan(100);

    // Return to the first plate and activate its retained plate-local result.
    // This must not inherit the second plate's native Print index or tower
    // coordinates; it also proves the per-plate result cache remains isolated.
    await clickPlateBed(indexedFirst.plateId);
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced', { timeout: 30_000 });
    const secondExportMtime = statSync(exportPath).mtimeMs;
    await page.getByTestId('btn-export').click();
    await expect.poll(() => existsSync(exportPath) && statSync(exportPath).mtimeMs > secondExportMtime, { timeout: 30_000 }).toBe(true);
    const firstAgainGcode = readFileSync(exportPath, 'utf8');
    const firstAgainEvidence = expectPrimeTowerPosition(firstAgainGcode, firstTowerAfterOperations!, `plate ${indexedFirst.displayIndex + 1} after return`);
    // Coordinate equality across plates is valid; the retained-result proof is
    // the indexed plate identity and its own native values, checked above.
    expect(indexedFirst.plateId).not.toBe(indexedSecond.plateId);
    await page.locator('#app-tab-preview').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Sliced');
    await expect.poll(readCurrentPlateId, { timeout: 30_000 }).toBe(current!.plateId);
    await expect.poll(readProxyIds, { timeout: 30_000 }).toBeNull();
  } finally {
    await app.close();
  }
});
