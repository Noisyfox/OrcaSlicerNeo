// Real-WASM timing regression. This intentionally has its own Electron
// session so the functional eight-tower/slice scenario cannot hide a load or
// history performance regression.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

type Timing = { count: number; totalMs: number; lastMs: number };
type ReadLayer = { plateSessionSnapshot: Timing; primeTowerProjection: Timing; filamentSessionSnapshot: Timing };
type Layer = { mutation: Timing; restore: Timing; directRestore: Timing; fullRestore: Timing; reads?: ReadLayer };
type Diagnostics = {
  worker: Layer | null;
  client: Layer | null;
  app: Layer & {
    queue: Timing; projection: Timing; filamentRefresh: Timing; filamentSnapshot: Timing;
    filamentPreferencePersistence: Timing; primeTowerProjectionRead: Timing;
    primeTowerSetProjection: Timing; primeTowerReconcile: Timing; primeTowerEmit: Timing;
    plateSessionSnapshot: Timing;
  };
};
type ProjectLoadEvidence = {
  receipt: {
    sourceDisplayName: string;
    sourceByteLength: number;
    commitRoute: 'load-project';
    nativeResult: {
      ok: boolean; mode?: string; displayName?: string; objects: number; instances: number;
      projectSettingsAvailable?: boolean; multiPlate?: boolean; plateCount?: number;
    };
  } | null;
  session: { projectName: string; hasContent: boolean; scope: string; hasLocation: boolean };
};
type Tower = {
  plateId: string; current: boolean; eligible: boolean; position: { x: number; y: number };
  footprint?: { minX: number; maxX: number; minY: number; maxY: number };
};

// This is a liveness ceiling, not a microbenchmark threshold. It is deliberately
// wide enough for a loaded 45 MB project on a constrained CI worker, but makes a
// user-visible multi-minute post-release stall a deterministic failure.
const HISTORY_STAGE_LIVENESS_LIMIT_MS = 120_000;
const DESKTOP_ROOT = resolve(__dirname, '..');
const configuredProjectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
const PROJECT_PATH = configuredProjectPath ? resolve(configuredProjectPath) : '';
const PROJECT_FILE_NAME = basename(PROJECT_PATH);
const PROJECT_NAME = PROJECT_FILE_NAME.replace(/\.3mf$/i, '');
const REAL = process.env.ORCA_E2E_REAL === '1';

test.skip(!REAL || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1 and ORCA_E2E_PRIME_TOWER_PROJECT');

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
  // A fixed-extruder imported profile can report native canAdd=false below
  // the generic slot ceiling. Require the rack projection and no rejection;
  // slot-add permission is not part of this history restore contract.
  await expect(page.getByTestId('filament-add')).toHaveCount(1);
}

function withinLivenessLimit(label: string, durationMs: number): void {
  expect(durationMs, `${label} must settle within ${HISTORY_STAGE_LIVENESS_LIMIT_MS} ms`).toBeLessThan(HISTORY_STAGE_LIVENESS_LIMIT_MS);
}

function timingWhenAdvanced(before: Timing, after: Timing): number | null {
  return after.count > before.count ? after.lastMs : null;
}

function countDelta(before: Timing, after: Timing): number {
  return after.count - before.count;
}

function totalMsDelta(before: Timing, after: Timing): number {
  return after.totalMs - before.totalMs;
}

test('measures Odyssey Prime Tower commit and history restore stages after a proven project load', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-prime-tower-history-performance-')), 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  }));
  const env = {
    ...process.env,
    ORCA_E2E: '1',
    ORCA_E2E_REAL: '1',
    ORCA_E2E_PRIME_TOWER_PROJECT: PROJECT_PATH,
    ORCA_E2E_MODEL: PROJECT_PATH,
    ORCA_E2E_PREFERENCES: preferencesPath,
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    const readEvidence = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => ProjectLoadEvidence } })
        .__orcaE2e?.projectLoadEvidence?.() ?? null,
    );
    const readTowers = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerStates?: () => Tower[] } })
        .__orcaE2e?.primeTowerStates?.() ?? [],
    );
    const readSelection = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerSelection?: () => string | null } })
        .__orcaE2e?.primeTowerSelection?.() ?? null,
    );
    const readMoves = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { primeTowerMoveCommands?: () => number } })
        .__orcaE2e?.primeTowerMoveCommands?.() ?? 0,
    );
    const readDiagnostics = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { historyDiagnostics?: () => Diagnostics } })
        .__orcaE2e?.historyDiagnostics?.() ?? null,
    );
    const requireDiagnostics = (value: Diagnostics | null): Diagnostics => {
      if (!value?.worker?.reads || !value.client?.reads)
        throw new Error('history diagnostics must expose Worker/client read timings in the real E2E build');
      return value;
    };

    await page.getByTestId('menu-file-trigger').click();
    await page.getByTestId('file-open-project').click();
    const choice = page.getByTestId('project-load-choice-dialog');
    if (await choice.isVisible({ timeout: 30_000 }).catch(() => false)) {
      await page.getByTestId('project-load-project').click();
      await page.getByTestId('project-load-confirm').click();
    }
    const confirmation = page.getByTestId('project-load-confirmation-dialog');
    if (await confirmation.isVisible({ timeout: 30_000 }).catch(() => false))
      await page.getByTestId('project-load-confirmation-dialog-continue').click();

    // Never measure an empty, geometry-only, or merely staged project.
    await expect.poll(readEvidence, { timeout: 300_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: PROJECT_FILE_NAME,
        sourceByteLength: statSync(PROJECT_PATH).size,
        commitRoute: 'load-project',
        nativeResult: {
          ok: true, mode: 'project', displayName: PROJECT_FILE_NAME,
          projectSettingsAvailable: true, multiPlate: true,
        },
      },
      session: { projectName: PROJECT_NAME, hasContent: true, scope: 'project', hasLocation: true },
    });
    const evidence = await readEvidence();
    expect(evidence?.receipt?.nativeResult.objects).toBeGreaterThan(0);
    expect(evidence?.receipt?.nativeResult.instances).toBeGreaterThan(0);
    expect(evidence?.receipt?.nativeResult.plateCount).toBeGreaterThan(1);
    console.log('[prime-tower-history-performance] committed load receipt', JSON.stringify({
      sourceDisplayName: evidence?.receipt?.sourceDisplayName,
      sourceByteLength: evidence?.receipt?.sourceByteLength,
      commitRoute: evidence?.receipt?.commitRoute,
      nativeResult: {
        mode: evidence?.receipt?.nativeResult.mode,
        objects: evidence?.receipt?.nativeResult.objects,
        instances: evidence?.receipt?.nativeResult.instances,
        multiPlate: evidence?.receipt?.nativeResult.multiPlate,
        plateCount: evidence?.receipt?.nativeResult.plateCount,
      },
    }));

    await page.locator('#app-tab-prepare').click();
    await expect.poll(async () => await readTowers(), { timeout: 300_000 }).toHaveLength(9);
    const eligibleTowers = await readTowers();
    expect(eligibleTowers).toHaveLength(9);
    expect(eligibleTowers.every((tower) => tower.eligible)).toBe(true);
    expect(new Set(eligibleTowers.map((tower) => tower.plateId)).size).toBe(9);
    const current = eligibleTowers.find((tower) => tower.current && tower.eligible);
    expect(current, 'the committed project must expose an active eligible Prime Tower').toBeDefined();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const projectWorldToScreen = (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => { x: number; y: number } | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null,
    point);
    const bedPosition = await page.evaluate((plateId) => {
      const beds = (window as unknown as { __orcaE2e?: { bedPlateStates?: () => Array<{
        plateId?: string; position: [number, number, number];
      }> } }).__orcaE2e?.bedPlateStates?.() ?? [];
      return beds.find((bed) => bed.plateId === plateId)?.position ?? [0, 0, 0];
    }, current!.plateId);

    let start: { x: number; y: number } | null = null;
    const footprint = current!.footprint;
    expect(footprint).toBeDefined();
    for (let dx = 4; dx <= Math.max(20, footprint!.maxX - footprint!.minX); dx += 8) {
      for (let dy = 4; dy <= Math.max(20, footprint!.maxY - footprint!.minY); dy += 8) {
        const candidate = await projectWorldToScreen([
          bedPosition[0] + current!.position.x + dx,
          bedPosition[1] + current!.position.y + dy,
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
    expect(start, 'the active tower must be selectable through the real scene ray').not.toBeNull();

    const moveDiagnosticsBefore = requireDiagnostics(await readDiagnostics());
    const movesBefore = await readMoves();
    await page.mouse.move(box!.x + start!.x, box!.y + start!.y);
    await page.mouse.down();
    let drafted = false;
    for (const target of [
      { x: box!.x - 800, y: box!.y - 800 },
      { x: box!.x + box!.width + 800, y: box!.y - 800 },
      { x: box!.x - 800, y: box!.y + box!.height + 800 },
      { x: box!.x + box!.width + 800, y: box!.y + box!.height + 800 },
    ]) {
      await page.mouse.move(target.x, target.y, { steps: 4 });
      const draft = (await readTowers()).find((tower) => tower.current)?.position;
      if (draft && (draft.x !== current!.position.x || draft.y !== current!.position.y)) {
        drafted = true;
        break;
      }
    }
    expect(drafted, 'one captured gesture must produce a local tower draft').toBe(true);

    const pointerUpAt = performance.now();
    await page.mouse.up();
    await expect.poll(async () => {
      const diagnostics = await readDiagnostics();
      const tower = (await readTowers()).find((candidate) => candidate.current);
      return (await readMoves()) === movesBefore + 1
        && (tower?.position.x !== current!.position.x || tower?.position.y !== current!.position.y)
        && diagnostics?.worker?.mutation.count === moveDiagnosticsBefore.worker!.mutation.count + 1
        && diagnostics?.client?.mutation.count === moveDiagnosticsBefore.client!.mutation.count + 1
        && diagnostics?.app.mutation.count === moveDiagnosticsBefore.app.mutation.count + 1;
    }).toBe(true);
    const movedPosition = (await readTowers()).find((tower) => tower.current)?.position;
    expect(movedPosition).toBeDefined();
    // The narrow move publication must keep the selected tower and the shared
    // Move gizmo usable; otherwise a correct mesh coordinate can still leave
    // the visible selection box/gizmo at an obsolete transform.
    await expect.poll(readSelection).toBe(current!.plateId);
    await expect(page.getByTestId('gizmo-btn-move')).toBeEnabled();
    const pointerUpToCommitMs = performance.now() - pointerUpAt;
    withinLivenessLimit('pointer-up to authoritative native commit', pointerUpToCommitMs);
    const moveDiagnosticsAfter = requireDiagnostics(await readDiagnostics());

    const undoDiagnosticsBefore = requireDiagnostics(await readDiagnostics());
    const undoAt = performance.now();
    await page.getByTestId('history-undo').click();
    await expect.poll(async () => {
      const diagnostics = await readDiagnostics();
      const tower = (await readTowers()).find((candidate) => candidate.current);
      return tower !== undefined
        && Math.max(Math.abs(tower.position.x - current!.position.x), Math.abs(tower.position.y - current!.position.y)) < 0.001
        && diagnostics?.worker?.directRestore.count === undoDiagnosticsBefore.worker!.directRestore.count + 1
        && diagnostics?.client?.directRestore.count === undoDiagnosticsBefore.client!.directRestore.count + 1
        && diagnostics?.app.directRestore.count === undoDiagnosticsBefore.app.directRestore.count + 1
        && diagnostics?.app.projection.count === undoDiagnosticsBefore.app.projection.count + 1
        && diagnostics?.app.filamentRefresh.count === undoDiagnosticsBefore.app.filamentRefresh.count + 1;
    }).toBe(true);
    await expectFilamentRackReady(page);
    await expect(page.getByTestId('slicer-error')).toHaveCount(0);
    const undoToProjectionMs = performance.now() - undoAt;
    withinLivenessLimit('undo to authoritative tower and valid filament rack', undoToProjectionMs);
    // The prime-tower impact requests one authoritative all-plate projection
    // after the direct receipt; the idle effect must not duplicate that read.
    await page.waitForTimeout(1_000);
    const undoDiagnosticsAfter = requireDiagnostics(await readDiagnostics());
    expect(countDelta(undoDiagnosticsBefore.worker!.reads!.primeTowerProjection, undoDiagnosticsAfter.worker!.reads!.primeTowerProjection)).toBe(1);
    expect(countDelta(undoDiagnosticsBefore.client!.reads!.primeTowerProjection, undoDiagnosticsAfter.client!.reads!.primeTowerProjection)).toBe(1);
    expect(countDelta(undoDiagnosticsBefore.app.primeTowerProjectionRead, undoDiagnosticsAfter.app.primeTowerProjectionRead)).toBe(1);

    const redoDiagnosticsBefore = requireDiagnostics(await readDiagnostics());
    const redoAt = performance.now();
    await page.getByTestId('history-redo').click();
    await expect.poll(async () => {
      const diagnostics = await readDiagnostics();
      const tower = (await readTowers()).find((candidate) => candidate.current);
      return tower !== undefined
        && Math.max(Math.abs(tower.position.x - movedPosition!.x), Math.abs(tower.position.y - movedPosition!.y)) < 0.001
        && diagnostics?.worker?.directRestore.count === redoDiagnosticsBefore.worker!.directRestore.count + 1
        && diagnostics?.client?.directRestore.count === redoDiagnosticsBefore.client!.directRestore.count + 1
        && diagnostics?.app.directRestore.count === redoDiagnosticsBefore.app.directRestore.count + 1
        && diagnostics?.app.projection.count === redoDiagnosticsBefore.app.projection.count + 1
        && diagnostics?.app.filamentRefresh.count === redoDiagnosticsBefore.app.filamentRefresh.count + 1;
    }).toBe(true);
    await expectFilamentRackReady(page);
    await expect(page.getByTestId('slicer-error')).toHaveCount(0);
    const redoToProjectionMs = performance.now() - redoAt;
    withinLivenessLimit('redo to authoritative tower and valid filament rack', redoToProjectionMs);
    await page.waitForTimeout(1_000);
    const redoDiagnosticsAfter = requireDiagnostics(await readDiagnostics());
    expect(countDelta(redoDiagnosticsBefore.worker!.reads!.primeTowerProjection, redoDiagnosticsAfter.worker!.reads!.primeTowerProjection)).toBe(1);
    expect(countDelta(redoDiagnosticsBefore.client!.reads!.primeTowerProjection, redoDiagnosticsAfter.client!.reads!.primeTowerProjection)).toBe(1);
    expect(countDelta(redoDiagnosticsBefore.app.primeTowerProjectionRead, redoDiagnosticsAfter.app.primeTowerProjectionRead)).toBe(1);

    console.log('[prime-tower-history-performance] timings (ms)', JSON.stringify({
      pointerUpToCommitMs,
      pointerUp: {
        workerNativeMutationMs: moveDiagnosticsAfter.worker!.mutation.lastMs,
        clientRoundTripMs: moveDiagnosticsAfter.client!.mutation.lastMs,
        appMutationAndPublicationMs: moveDiagnosticsAfter.app.mutation.lastMs,
      },
      undoToProjectionMs,
      undo: {
        workerNativeRestoreMs: undoDiagnosticsAfter.worker!.directRestore.lastMs,
        clientRestoreRoundTripMs: undoDiagnosticsAfter.client!.directRestore.lastMs,
        appNativeRestoreMs: undoDiagnosticsAfter.app.directRestore.lastMs,
        appPrimeTowerProjectionMs: undoDiagnosticsAfter.app.projection.lastMs,
        workerPlateSessionSnapshot: {
          countDelta: countDelta(undoDiagnosticsBefore.worker!.reads!.plateSessionSnapshot, undoDiagnosticsAfter.worker!.reads!.plateSessionSnapshot),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.worker!.reads!.plateSessionSnapshot, undoDiagnosticsAfter.worker!.reads!.plateSessionSnapshot),
        },
        clientPlateSessionSnapshotRoundTrip: {
          countDelta: countDelta(undoDiagnosticsBefore.client!.reads!.plateSessionSnapshot, undoDiagnosticsAfter.client!.reads!.plateSessionSnapshot),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.client!.reads!.plateSessionSnapshot, undoDiagnosticsAfter.client!.reads!.plateSessionSnapshot),
        },
        appPlateSessionSnapshot: {
          countDelta: countDelta(undoDiagnosticsBefore.app.plateSessionSnapshot, undoDiagnosticsAfter.app.plateSessionSnapshot),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.app.plateSessionSnapshot, undoDiagnosticsAfter.app.plateSessionSnapshot),
        },
        workerPrimeTowerProjection: {
          countDelta: countDelta(undoDiagnosticsBefore.worker!.reads!.primeTowerProjection, undoDiagnosticsAfter.worker!.reads!.primeTowerProjection),
          totalMs: totalMsDelta(undoDiagnosticsBefore.worker!.reads!.primeTowerProjection, undoDiagnosticsAfter.worker!.reads!.primeTowerProjection),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.worker!.reads!.primeTowerProjection, undoDiagnosticsAfter.worker!.reads!.primeTowerProjection),
        },
        clientPrimeTowerProjectionRoundTrip: {
          countDelta: countDelta(undoDiagnosticsBefore.client!.reads!.primeTowerProjection, undoDiagnosticsAfter.client!.reads!.primeTowerProjection),
          totalMs: totalMsDelta(undoDiagnosticsBefore.client!.reads!.primeTowerProjection, undoDiagnosticsAfter.client!.reads!.primeTowerProjection),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.client!.reads!.primeTowerProjection, undoDiagnosticsAfter.client!.reads!.primeTowerProjection),
        },
        appPrimeTowerProjectionRead: {
          countDelta: countDelta(undoDiagnosticsBefore.app.primeTowerProjectionRead, undoDiagnosticsAfter.app.primeTowerProjectionRead),
          totalMs: totalMsDelta(undoDiagnosticsBefore.app.primeTowerProjectionRead, undoDiagnosticsAfter.app.primeTowerProjectionRead),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.app.primeTowerProjectionRead, undoDiagnosticsAfter.app.primeTowerProjectionRead),
        },
        appPrimeTowerSetProjection: {
          countDelta: countDelta(undoDiagnosticsBefore.app.primeTowerSetProjection, undoDiagnosticsAfter.app.primeTowerSetProjection),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.app.primeTowerSetProjection, undoDiagnosticsAfter.app.primeTowerSetProjection),
        },
        appPrimeTowerReconcile: {
          countDelta: countDelta(undoDiagnosticsBefore.app.primeTowerReconcile, undoDiagnosticsAfter.app.primeTowerReconcile),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.app.primeTowerReconcile, undoDiagnosticsAfter.app.primeTowerReconcile),
        },
        appPrimeTowerEmit: {
          countDelta: countDelta(undoDiagnosticsBefore.app.primeTowerEmit, undoDiagnosticsAfter.app.primeTowerEmit),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.app.primeTowerEmit, undoDiagnosticsAfter.app.primeTowerEmit),
        },
        workerFilamentSnapshot: {
          countDelta: countDelta(undoDiagnosticsBefore.worker!.reads!.filamentSessionSnapshot, undoDiagnosticsAfter.worker!.reads!.filamentSessionSnapshot),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.worker!.reads!.filamentSessionSnapshot, undoDiagnosticsAfter.worker!.reads!.filamentSessionSnapshot),
        },
        clientFilamentSnapshotRoundTrip: {
          countDelta: countDelta(undoDiagnosticsBefore.client!.reads!.filamentSessionSnapshot, undoDiagnosticsAfter.client!.reads!.filamentSessionSnapshot),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.client!.reads!.filamentSessionSnapshot, undoDiagnosticsAfter.client!.reads!.filamentSessionSnapshot),
        },
        appRememberedFilamentSnapshot: {
          countDelta: countDelta(undoDiagnosticsBefore.app.filamentSnapshot, undoDiagnosticsAfter.app.filamentSnapshot),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.app.filamentSnapshot, undoDiagnosticsAfter.app.filamentSnapshot),
        },
        appFilamentPreferencePersistence: {
          countDelta: countDelta(undoDiagnosticsBefore.app.filamentPreferencePersistence, undoDiagnosticsAfter.app.filamentPreferencePersistence),
          lastMs: timingWhenAdvanced(undoDiagnosticsBefore.app.filamentPreferencePersistence, undoDiagnosticsAfter.app.filamentPreferencePersistence),
        },
        appFilamentRefreshMs: undoDiagnosticsAfter.app.filamentRefresh.lastMs,
      },
      redoToProjectionMs,
      redo: {
        workerNativeRestoreMs: redoDiagnosticsAfter.worker!.directRestore.lastMs,
        clientRestoreRoundTripMs: redoDiagnosticsAfter.client!.directRestore.lastMs,
        appNativeRestoreMs: redoDiagnosticsAfter.app.directRestore.lastMs,
        appPrimeTowerProjectionMs: redoDiagnosticsAfter.app.projection.lastMs,
        workerPlateSessionSnapshot: {
          countDelta: countDelta(redoDiagnosticsBefore.worker!.reads!.plateSessionSnapshot, redoDiagnosticsAfter.worker!.reads!.plateSessionSnapshot),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.worker!.reads!.plateSessionSnapshot, redoDiagnosticsAfter.worker!.reads!.plateSessionSnapshot),
        },
        clientPlateSessionSnapshotRoundTrip: {
          countDelta: countDelta(redoDiagnosticsBefore.client!.reads!.plateSessionSnapshot, redoDiagnosticsAfter.client!.reads!.plateSessionSnapshot),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.client!.reads!.plateSessionSnapshot, redoDiagnosticsAfter.client!.reads!.plateSessionSnapshot),
        },
        appPlateSessionSnapshot: {
          countDelta: countDelta(redoDiagnosticsBefore.app.plateSessionSnapshot, redoDiagnosticsAfter.app.plateSessionSnapshot),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.app.plateSessionSnapshot, redoDiagnosticsAfter.app.plateSessionSnapshot),
        },
        workerPrimeTowerProjection: {
          countDelta: countDelta(redoDiagnosticsBefore.worker!.reads!.primeTowerProjection, redoDiagnosticsAfter.worker!.reads!.primeTowerProjection),
          totalMs: totalMsDelta(redoDiagnosticsBefore.worker!.reads!.primeTowerProjection, redoDiagnosticsAfter.worker!.reads!.primeTowerProjection),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.worker!.reads!.primeTowerProjection, redoDiagnosticsAfter.worker!.reads!.primeTowerProjection),
        },
        clientPrimeTowerProjectionRoundTrip: {
          countDelta: countDelta(redoDiagnosticsBefore.client!.reads!.primeTowerProjection, redoDiagnosticsAfter.client!.reads!.primeTowerProjection),
          totalMs: totalMsDelta(redoDiagnosticsBefore.client!.reads!.primeTowerProjection, redoDiagnosticsAfter.client!.reads!.primeTowerProjection),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.client!.reads!.primeTowerProjection, redoDiagnosticsAfter.client!.reads!.primeTowerProjection),
        },
        appPrimeTowerProjectionRead: {
          countDelta: countDelta(redoDiagnosticsBefore.app.primeTowerProjectionRead, redoDiagnosticsAfter.app.primeTowerProjectionRead),
          totalMs: totalMsDelta(redoDiagnosticsBefore.app.primeTowerProjectionRead, redoDiagnosticsAfter.app.primeTowerProjectionRead),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.app.primeTowerProjectionRead, redoDiagnosticsAfter.app.primeTowerProjectionRead),
        },
        appPrimeTowerSetProjection: {
          countDelta: countDelta(redoDiagnosticsBefore.app.primeTowerSetProjection, redoDiagnosticsAfter.app.primeTowerSetProjection),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.app.primeTowerSetProjection, redoDiagnosticsAfter.app.primeTowerSetProjection),
        },
        appPrimeTowerReconcile: {
          countDelta: countDelta(redoDiagnosticsBefore.app.primeTowerReconcile, redoDiagnosticsAfter.app.primeTowerReconcile),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.app.primeTowerReconcile, redoDiagnosticsAfter.app.primeTowerReconcile),
        },
        appPrimeTowerEmit: {
          countDelta: countDelta(redoDiagnosticsBefore.app.primeTowerEmit, redoDiagnosticsAfter.app.primeTowerEmit),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.app.primeTowerEmit, redoDiagnosticsAfter.app.primeTowerEmit),
        },
        workerFilamentSnapshot: {
          countDelta: countDelta(redoDiagnosticsBefore.worker!.reads!.filamentSessionSnapshot, redoDiagnosticsAfter.worker!.reads!.filamentSessionSnapshot),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.worker!.reads!.filamentSessionSnapshot, redoDiagnosticsAfter.worker!.reads!.filamentSessionSnapshot),
        },
        clientFilamentSnapshotRoundTrip: {
          countDelta: countDelta(redoDiagnosticsBefore.client!.reads!.filamentSessionSnapshot, redoDiagnosticsAfter.client!.reads!.filamentSessionSnapshot),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.client!.reads!.filamentSessionSnapshot, redoDiagnosticsAfter.client!.reads!.filamentSessionSnapshot),
        },
        appRememberedFilamentSnapshot: {
          countDelta: countDelta(redoDiagnosticsBefore.app.filamentSnapshot, redoDiagnosticsAfter.app.filamentSnapshot),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.app.filamentSnapshot, redoDiagnosticsAfter.app.filamentSnapshot),
        },
        appFilamentPreferencePersistence: {
          countDelta: countDelta(redoDiagnosticsBefore.app.filamentPreferencePersistence, redoDiagnosticsAfter.app.filamentPreferencePersistence),
          lastMs: timingWhenAdvanced(redoDiagnosticsBefore.app.filamentPreferencePersistence, redoDiagnosticsAfter.app.filamentPreferencePersistence),
        },
        appFilamentRefreshMs: redoDiagnosticsAfter.app.filamentRefresh.lastMs,
      },
    }));
  } finally {
    await app.close();
  }
});
