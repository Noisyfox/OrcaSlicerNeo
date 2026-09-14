// Real-WASM profile for the user-visible object-move boundary: completing one
// canvas drag until its matching Undo Move entry is enabled.
import { _electron, expect, test, type ElectronApplication } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

type Timing = { count: number; totalMs: number; lastMs: number };
type Layer = { mutation: Timing; restore: Timing; directRestore: Timing; fullRestore: Timing };
type Diagnostics = { worker: Layer | null; client: Layer | null; app: Layer & {
  queue: Timing; projection: Timing; fullRestoreModelReloads: number;
} };
type NativeSample = { operation: string; stagesMs: Record<string, number> };
type NativeProfile = { version: 1; samples: NativeSample[] };
type ProjectLoadEvidence = {
  receipt: {
    sourceDisplayName: string;
    sourceByteLength: number;
    nativeResult: { ok: boolean; mode?: string; objects: number; instances: number; multiPlate?: boolean; plateCount?: number };
  } | null;
};
type Point = { x: number; y: number };
type Bounds = { min: number[]; max: number[]; center: number[]; size: number[] } | null;

const EXPECTED_PROJECT_PATH = 'E:\\OneDrive\\Dokumente\\3d打印\\模型\\奥德赛\\OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf';
const configuredProjectPath = process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim();
const PROJECT_PATH = resolve(configuredProjectPath || EXPECTED_PROJECT_PATH);
const EXACT_FIXTURE = PROJECT_PATH.toLowerCase() === resolve(EXPECTED_PROJECT_PATH).toLowerCase();
const REAL = process.env.ORCA_E2E_REAL === '1';
const REAL_ARTIFACT = process.env.VITE_USE_MOCK === '0';
const DESKTOP_ROOT = resolve(__dirname, '..');

test.skip(!REAL || !REAL_ARTIFACT || !EXACT_FIXTURE || !existsSync(PROJECT_PATH),
  'requires ORCA_E2E_REAL=1, VITE_USE_MOCK=0, and the exact Odyssey u1 fixture');

function delta(before: Timing, after: Timing, label: string): number {
  expect(after.count, `${label} must record exactly one operation`).toBe(before.count + 1);
  return after.lastMs;
}

test('profiles a real object move through the visible Undo Move boundary', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-object-move-history-profile-')), 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({ version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {} }));
  const env = {
    ...process.env,
    ORCA_E2E: '1', ORCA_E2E_REAL: '1', VITE_USE_MOCK: '0', VITE_E2E: '1',
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
    await expect.poll(readEvidence, { timeout: 300_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: basename(PROJECT_PATH),
        sourceByteLength: statSync(PROJECT_PATH).size,
        nativeResult: { ok: true, mode: 'project', multiPlate: true },
      },
    });
    const projectEvidence = await readEvidence();
    const plateCount = projectEvidence?.receipt?.nativeResult.plateCount;
    if (typeof plateCount !== 'number' || !Number.isSafeInteger(plateCount) || plateCount <= 1)
      throw new Error('the real u1 project must report its native multi-plate count');
    console.log('[object-move-history-profile] project receipt', JSON.stringify({
      filename: projectEvidence?.receipt?.sourceDisplayName,
      bytes: projectEvidence?.receipt?.sourceByteLength,
      nativePlates: plateCount,
    }));

    await page.locator('#app-tab-prepare').click();
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const readCenters = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
        .__orcaE2e?.modelWorldCenters?.() ?? [],
    );
    const project = (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => Point | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null, point,
    );
    const readSelectionCount = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { selectionInstanceCount?: () => number } })
        .__orcaE2e?.selectionInstanceCount?.() ?? 0,
    );
    const readBounds = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { selectionBoundsWorld?: () => Bounds } })
        .__orcaE2e?.selectionBoundsWorld?.() ?? null,
    );
    const readSelectionPivot = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { selectionPivotWorld?: () => number[] | null } })
        .__orcaE2e?.selectionPivotWorld?.() ?? null,
    );
    const readOwner = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { pointerOwner?: () => string } }).__orcaE2e?.pointerOwner?.() ?? 'none',
    );
    const readDiagnostics = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { historyDiagnostics?: () => Diagnostics } })
        .__orcaE2e?.historyDiagnostics?.() ?? null,
    );
    const takeNativeProfile = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { takeNativePerformanceProfile?: () => Promise<NativeProfile> } })
        .__orcaE2e?.takeNativePerformanceProfile?.() ?? Promise.resolve({ version: 1 as const, samples: [] }),
    );

    await expect.poll(readCenters, { timeout: 300_000 }).not.toHaveLength(0);
    const centers = await readCenters();
    const beforeCenters = centers.map((center) => [...center]);
    console.log('[object-move-history-profile] centers', JSON.stringify({
      canvas: { width: box!.width, height: box!.height }, centers,
    }));
    let start: Point | null = null;
    for (const center of centers) {
      const candidate = await project(center);
      if (!candidate || candidate.x < 0 || candidate.y < 0 || candidate.x > box!.width || candidate.y > box!.height) continue;
      // A real mesh can have a hollow/hidden centroid. Try a small canvas-only
      // neighborhood around each projected world center while retaining the
      // same genuine pointer-selection path.
      for (const [dx, dy] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]]) {
        const x = candidate.x + dx;
        const y = candidate.y + dy;
        if (x < 0 || y < 0 || x > box!.width || y > box!.height) continue;
        await page.mouse.click(box!.x + x, box!.y + y);
        if (await readSelectionCount() > 0) {
          start = { x, y };
          break;
        }
      }
      if (start) break;
    }
    expect(start, 'a real rendered object must be selectable through the canvas').not.toBeNull();
    const beforeBounds = await readBounds();
    expect(beforeBounds).not.toBeNull();
    const beforePivot = await readSelectionPivot();
    expect(beforePivot).not.toBeNull();

    const before = await readDiagnostics();
    if (!before?.worker || !before.client) throw new Error('real E2E must expose Worker/client history diagnostics');
    // Load, projection, and selection reads must not contaminate this move.
    await takeNativeProfile();
    await page.mouse.move(box!.x + start!.x, box!.y + start!.y);
    await page.mouse.down();
    await page.mouse.move(box!.x + start!.x + 80, box!.y + start!.y + 35, { steps: 5 });
    await expect.poll(readOwner, { timeout: 10_000 }).toBe('body');
    await page.mouse.up();
    const pointerUpAt = performance.now();

    let undoVisibleAt = 0;
    await expect.poll(async () => {
      const diagnostics = await readDiagnostics();
      const undo = page.getByTestId('history-undo');
      const matchingUndo = await undo.getAttribute('aria-label') === 'Undo Move';
      const afterBounds = await readBounds();
      const moved = Boolean(afterBounds && beforeBounds && afterBounds.center.some((value, index) => value !== beforeBounds.center[index]));
      const complete = diagnostics?.worker?.mutation.count === before.worker!.mutation.count + 1
        && diagnostics?.client?.mutation.count === before.client!.mutation.count + 1
        && diagnostics.app.mutation.count === before.app.mutation.count + 1
        && matchingUndo && await undo.isEnabled() && moved;
      if (complete && undoVisibleAt === 0) undoVisibleAt = performance.now();
      return complete;
    }, { timeout: 120_000, intervals: [20] }).toBe(true);

    const after = await readDiagnostics();
    if (!after?.worker || !after.client) throw new Error('history diagnostics disappeared during object move');
    const native = await takeNativeProfile();
    const samples = native.samples.filter((sample) =>
      sample.operation === 'history_begin' || sample.operation === 'set_model_transforms' || sample.operation === 'history_commit');
    expect(samples.map((sample) => sample.operation)).toEqual(['history_begin', 'set_model_transforms', 'history_commit']);
    const transform = samples.find((sample) => sample.operation === 'set_model_transforms')!;
    const stageNames = [
      'input_json_decode', 'request_validation_target_resolution', 'transform_mutation',
      'plate_membership_reflow', 'response_json_serialization', 'total',
    ];
    expect(Object.keys(transform.stagesMs).sort()).toEqual([...stageNames].sort());
    expect(stageNames.every((stage) => Number.isFinite(transform.stagesMs[stage]) && transform.stagesMs[stage] >= 0)).toBe(true);
    expect(transform.stagesMs.total).toBeGreaterThanOrEqual(Math.max(...stageNames.filter((stage) => stage !== 'total').map((stage) => transform.stagesMs[stage])));
    const begin = samples.find((sample) => sample.operation === 'history_begin')!;
    const commit = samples.find((sample) => sample.operation === 'history_commit')!;
    const captureStageNames = [
      'capture_collection_cache', 'capture_mutable_object_archive',
      'capture_immutable_mesh_retention', 'capture_model_state',
    ];
    expect(captureStageNames.every((stage) =>
      Number.isFinite(begin.stagesMs[stage]) && begin.stagesMs[stage] >= 0 &&
      Number.isFinite(commit.stagesMs[stage]) && commit.stagesMs[stage] >= 0)).toBe(true);
    expect(begin.stagesMs.capture_model_state).toBeGreaterThanOrEqual(Math.max(
      begin.stagesMs.capture_collection_cache,
      begin.stagesMs.capture_mutable_object_archive,
      begin.stagesMs.capture_immutable_mesh_retention));
    expect(commit.stagesMs.capture_model_state).toBeGreaterThanOrEqual(Math.max(
      commit.stagesMs.capture_collection_cache,
      commit.stagesMs.capture_mutable_object_archive,
      commit.stagesMs.capture_immutable_mesh_retention));
    expect(Object.keys(begin.stagesMs).sort()).toEqual([
      'capture_collection_cache', 'capture_immutable_mesh_retention',
      'capture_model_state', 'capture_mutable_object_archive', 'total',
    ].sort());
    expect(Object.keys(commit.stagesMs).sort()).toEqual([
      'capture_collection_cache', 'capture_immutable_mesh_retention',
      'capture_model_state', 'capture_mutable_object_archive', 'history_store', 'total',
    ].sort());

    const workerMs = delta(before.worker.mutation, after.worker.mutation, 'Worker transaction');
    const clientMs = delta(before.client.mutation, after.client.mutation, 'client transaction');
    const appMs = delta(before.app.mutation, after.app.mutation, 'application mutation/publication');
    const nativeMs = samples.reduce((total, sample) => total + (sample.stagesMs.total ?? 0), 0);
    console.log('[object-move-history-profile] ms', JSON.stringify({
      pointerUpToUndoVisibleMs: undoVisibleAt - pointerUpAt,
      applicationMutationAndPublicationMs: appMs,
      clientTransactionMs: clientMs,
      workerTransactionMs: workerMs,
      nativeInstrumentedTotalMs: nativeMs,
      rendererToWorkerTransportAndClientJsResidualMs: clientMs - workerMs,
      workerJsAndUninstrumentedNativeResidualMs: workerMs - nativeMs,
      historyBeginCaptureStagesMs: Object.fromEntries(captureStageNames.map((stage) => [stage, begin.stagesMs[stage]])),
      historyCommitCaptureStagesMs: Object.fromEntries(captureStageNames.map((stage) => [stage, commit.stagesMs[stage]])),
      nativeSamples: samples,
    }));

    // Profile the actual user-visible Undo action. Completion is deliberately
    // fenced on the consumed Undo entry, matching enabled Redo Move, the
    // restored native/renderer bounds, and a refreshed renderer projection.
    const undoBefore = after;
    const restoreClickAt = performance.now();
    const undo = page.getByTestId('history-undo');
    await expect(undo).toHaveAttribute('aria-label', 'Undo Move');
    await undo.click();
    let restoreCompleteAt = 0;
    const restoreTimeoutMs = 180_000;
    const readRestoreState = () => page.evaluate(() => {
      const e = (window as unknown as { __orcaE2e?: {
        historyDiagnostics?: () => Diagnostics;
        selectionBoundsWorld?: () => Bounds;
        selectionPivotWorld?: () => number[] | null;
        modelWorldCenters?: () => Array<[number, number, number]>;
      } }).__orcaE2e;
      const undo = document.querySelector('[data-testid="history-undo"]') as HTMLButtonElement | null;
      const redo = document.querySelector('[data-testid="history-redo"]') as HTMLButtonElement | null;
      return {
        diagnostics: e?.historyDiagnostics?.() ?? null,
        restoredBounds: e?.selectionBoundsWorld?.() ?? null,
        restoredPivot: e?.selectionPivotWorld?.() ?? null,
        restoredCenters: e?.modelWorldCenters?.() ?? [],
        undoLabel: undo?.getAttribute('aria-label') ?? null,
        redoLabel: redo?.getAttribute('aria-label') ?? null,
        undoEnabled: !undo?.disabled,
        redoEnabled: !redo?.disabled,
        restoreError: document.querySelector('[data-testid="history-restore-error"]')?.textContent ?? null,
      };
    });
    await expect.poll(async () => {
      const state = await readRestoreState();
      const { diagnostics, restoredBounds, restoredPivot, restoredCenters, restoreError } = state;
      if (restoreError) throw new Error(`Undo Move restore failed: ${restoreError}`);
      const boundsEqual = Boolean(restoredBounds && beforeBounds &&
        [...restoredBounds.min, ...restoredBounds.max, ...restoredBounds.center, ...restoredBounds.size]
          .every((value, index) => Math.abs(value - [
            ...beforeBounds!.min, ...beforeBounds!.max, ...beforeBounds!.center, ...beforeBounds!.size,
          ][index]) <= 1e-6));
      const projectionEqual = restoredCenters.length === beforeCenters.length && restoredCenters.every((center, index) =>
        center.every((value, axis) => Math.abs(value - beforeCenters[index][axis]) <= 1e-6));
      const pivotEqual = Boolean(restoredPivot && beforePivot && restoredPivot.length === beforePivot.length &&
        restoredPivot.every((value, index) => Math.abs(value - beforePivot[index]) <= 1e-6));
      const projectionMaxDelta = restoredCenters.length === beforeCenters.length
        ? Math.max(...restoredCenters.map((center, index) => Math.max(...center.map((value, axis) =>
          Math.abs(value - beforeCenters[index][axis]))))) : Infinity;
      const complete = diagnostics?.worker?.fullRestore.count === undoBefore.worker!.fullRestore.count + 1
        && diagnostics?.client?.fullRestore.count === undoBefore.client!.fullRestore.count + 1
        && diagnostics.app.fullRestore.count === undoBefore.app.fullRestore.count + 1
        && diagnostics.app.projection.count === undoBefore.app.projection.count + 1
        && diagnostics.app.fullRestoreModelReloads === undoBefore.app.fullRestoreModelReloads + 1
        && state.redoLabel === 'Redo Move'
        && state.redoEnabled
        && state.undoLabel !== 'Undo Move'
        && (boundsEqual || pivotEqual || projectionEqual)
        && projectionEqual;
      if (complete && restoreCompleteAt === 0) restoreCompleteAt = performance.now();
      return complete;
    }, { timeout: restoreTimeoutMs, intervals: [20] }).toBe(true);

    const undoAfter = await readDiagnostics();
    if (!undoAfter?.worker || !undoAfter.client) throw new Error('history diagnostics disappeared during Undo Move');
    const restoreNative = await takeNativeProfile();
    const restoreSamples = restoreNative.samples.filter((sample) => sample.operation === 'history_restore');
    expect(restoreNative.samples.map((sample) => sample.operation)).toEqual(['history_restore']);
    expect(restoreSamples).toHaveLength(1);
    const restoreStageNames = [
      'capture_model_equality_check', 'model_staging_deserialization', 'immutable_mesh_reconnect',
      'plate_session_project_overlay_restore', 'history_cursor_commit', 'response_json_serialization', 'total',
    ];
    expect(Object.keys(restoreSamples[0].stagesMs).sort()).toEqual([...restoreStageNames].sort());
    expect(restoreStageNames.every((stage) => Number.isFinite(restoreSamples[0].stagesMs[stage]) &&
      restoreSamples[0].stagesMs[stage] >= 0)).toBe(true);
    expect(restoreSamples[0].stagesMs.total).toBeGreaterThanOrEqual(Math.max(...restoreStageNames
      .filter((stage) => stage !== 'total').map((stage) => restoreSamples[0].stagesMs[stage])));
    const restoreWorkerMs = delta(undoBefore.worker!.fullRestore, undoAfter.worker.fullRestore, 'Worker Undo restore');
    const restoreClientMs = delta(undoBefore.client!.fullRestore, undoAfter.client.fullRestore, 'client Undo restore');
    const restoreAppMs = delta(undoBefore.app.fullRestore, undoAfter.app.fullRestore, 'application Undo restore');
    const restoreProjectionMs = delta(undoBefore.app.projection, undoAfter.app.projection, 'application Undo publication');
    const restoreNativeMs = restoreSamples[0].stagesMs.total;
    console.log('[object-move-history-undo-profile] ms', JSON.stringify({
      clickToRestoredProjectionMs: restoreCompleteAt - restoreClickAt,
      applicationRestoreMs: restoreAppMs,
      applicationPublicationMs: restoreProjectionMs,
      clientRestoreMs: restoreClientMs,
      workerRestoreMs: restoreWorkerMs,
      nativeInstrumentedTotalMs: restoreNativeMs,
      rendererToWorkerTransportAndClientJsResidualMs: restoreClientMs - restoreWorkerMs,
      workerJsAndUninstrumentedNativeResidualMs: restoreWorkerMs - restoreNativeMs,
      nativeStages: restoreSamples[0].stagesMs,
    }));
  } finally {
    await app.close();
  }
});
