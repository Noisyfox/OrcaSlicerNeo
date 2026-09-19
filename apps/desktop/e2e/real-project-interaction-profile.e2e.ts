// Dedicated visible, real-WASM acceptance profile for the exact u1 project.
// This file is launched only by scripts/run-real-project-profile.mjs, whose
// build uses VITE_REAL_PROJECT_PROFILE=1 and the profile-threaded WASM module.
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { performance as nodePerformance } from 'node:perf_hooks';

type Timing = { count: number; totalMs: number; lastMs: number };
type Layer = { mutation: Timing; restore: Timing; directRestore: Timing; fullRestore: Timing };
type Diagnostics = { worker: Layer | null; client: Layer | null; app: Layer & {
  queue: Timing;
  projection: Timing;
  filamentRefresh: Timing;
  primeTowerProjectionRead: Timing;
  transformReceiptApplication: Timing;
  selectionRestore: Timing;
  fullRestoreModelReloads: number;
  transformReceiptApplied: number;
  transformReceiptFallbacks: number;
  transformReceiptProofFailures: number;
  transformReceiptProofLastFailure: string | null;
} };
type NativeSample = { operation: string; stagesMs: Record<string, number>; perPlateStagesMs?: Array<Record<string, number>> };
type NativeProfile = { version: 1; samples: NativeSample[] };
type Point = { x: number; y: number };
type Bounds = { min: number[]; max: number[]; center: number[]; size: number[] } | null;
type JsWasmCall = { operation: string; wallMs: number; inputJsonBytes: number; outputJsonBytes: number };
type NativePlateMemory = {
  plate_id: string;
  native_core_materialized: boolean;
  core_cache_object_count: number;
  print_object_count: number;
  print_instance_count: number;
  layer_count: number;
  support_layer_count: number;
  gcode_move_count: number;
  gcode_line_end_count: number;
  structural_model_copy_estimated_bytes: number;
  derived_cache_estimated_bytes: number;
  shared_mesh_reference_count: number;
  shared_mesh_bytes_attributed_to_plate: number;
};
type NativeMemory = {
  version: 1;
  profile_build: true;
  build_identity: 'ORCA_REAL_PROJECT_PROFILE_V1';
  js_profile_identity: 'ORCA_REAL_PROJECT_PROFILE_JS_V1';
  threaded: true;
  wasm_heap_bytes: number;
  wasm_heap_buffer_bytes_after_read: number;
  registry_entry_count: number;
  retired_registry_entry_count: number;
  prime_tower_projection_cache_entries: number;
  history: { entry_count: number; retained_estimated_bytes: number; serialized_mesh_count: number;
    serialized_object_count: number; reused_object_count: number;
    object_cache_misses: Record<string, number>; object_fingerprint_misses: Record<string, number> };
  shared_source_mesh: { reference_count: number; unique_mesh_count: number; vertex_bytes: number;
    index_bytes: number; total_bytes: number };
  plates: NativePlateMemory[];
  js_wasm_calls: JsWasmCall[];
};
type RendererMemory = {
  identity: 'ORCA_REAL_PROJECT_PROFILE_RENDERER_V1';
  reactTypedArrayBytes: number;
  gpuProjectionEstimatedBytes: number;
  volumeCount: number;
  perPlate: Array<{ plateId: string; reactTypedArrayBytes: number; gpuProjectionEstimatedBytes: number; volumeCount: number }>;
};
type Attribution = { native: NativeMemory; renderer: RendererMemory };
type BoundsProfile = {
  identity: 'ORCA_REAL_PROJECT_BOUNDS_PROFILE_V1';
  durationMs: number;
  centers: Array<[number, number, number]>;
};
type BedState = {
  plateId?: string;
  current: boolean;
  outOfBounds: boolean;
  position: [number, number, number];
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
};

const EXPECTED_PROJECT_PATH = 'E:\\OneDrive\\Dokumente\\3d打印\\模型\\奥德赛\\OddseyHelmetFinalParts+(2)wholemorecolor-u1.3mf';
const PROJECT_PATH = resolve(process.env.ORCA_E2E_PRIME_TOWER_PROJECT?.trim() || EXPECTED_PROJECT_PATH);
const ENABLED = process.env.ORCA_E2E_REAL === '1' && process.env.ORCA_E2E_VISIBLE === '1' &&
  process.env.VITE_USE_MOCK === '0' && process.env.VITE_REAL_PROJECT_PROFILE === '1' &&
  PROJECT_PATH.toLowerCase() === resolve(EXPECTED_PROJECT_PATH).toLowerCase() && existsSync(PROJECT_PATH);
const DESKTOP_ROOT = resolve(__dirname, '..');

test.skip(!ENABLED, 'requires the dedicated visible real-project profile runner and exact u1 fixture');

function timingDelta(before: Timing, after: Timing, label: string): number {
  expect(after.count, `${label} must record exactly one operation`).toBe(before.count + 1);
  return after.lastMs;
}

function optionalTimingDelta(before: Timing, after: Timing): number {
  return after.count === before.count ? 0 : after.lastMs;
}

function expectFiniteNonNegative(value: number, label: string): void {
  expect(Number.isFinite(value) && value >= 0, `${label} must be finite and non-negative`).toBe(true);
}

function expectCalls(snapshot: NativeMemory, expected: string[]): void {
  expect(snapshot.js_wasm_calls.map((call) => call.operation)).toEqual(expected);
  for (const call of snapshot.js_wasm_calls) {
    expectFiniteNonNegative(call.wallMs, `${call.operation} JS/WASM wall time`);
    expect(call.inputJsonBytes).toBeGreaterThanOrEqual(0);
    expect(call.outputJsonBytes).toBeGreaterThan(0);
  }
}

function expectAttribution(snapshot: Attribution, plateCount: number): void {
  expect(snapshot.native).toMatchObject({
    version: 1,
    profile_build: true,
    build_identity: 'ORCA_REAL_PROJECT_PROFILE_V1',
    js_profile_identity: 'ORCA_REAL_PROJECT_PROFILE_JS_V1',
    threaded: true,
    registry_entry_count: plateCount,
    retired_registry_entry_count: 0,
  });
  expect(snapshot.native.plates).toHaveLength(plateCount);
  expect(snapshot.native.wasm_heap_bytes).toBeGreaterThan(0);
  expect(snapshot.native.wasm_heap_buffer_bytes_after_read).toBeGreaterThanOrEqual(snapshot.native.wasm_heap_bytes);
  expect(snapshot.native.shared_source_mesh.unique_mesh_count).toBeGreaterThan(0);
  expect(snapshot.native.shared_source_mesh.total_bytes).toBe(
    snapshot.native.shared_source_mesh.vertex_bytes + snapshot.native.shared_source_mesh.index_bytes,
  );
  for (const plate of snapshot.native.plates) {
    expect(plate.core_cache_object_count).toBe(2);
    expect(plate.shared_mesh_bytes_attributed_to_plate).toBe(0);
    expectFiniteNonNegative(plate.structural_model_copy_estimated_bytes, `${plate.plate_id} structural bytes`);
    expectFiniteNonNegative(plate.derived_cache_estimated_bytes, `${plate.plate_id} derived bytes`);
  }
  expect(snapshot.renderer.identity).toBe('ORCA_REAL_PROJECT_PROFILE_RENDERER_V1');
  expect(snapshot.renderer.volumeCount).toBeGreaterThan(0);
  expect(snapshot.renderer.reactTypedArrayBytes).toBeGreaterThan(0);
  expect(snapshot.renderer.gpuProjectionEstimatedBytes).toBeGreaterThanOrEqual(snapshot.renderer.reactTypedArrayBytes);
  expect(snapshot.renderer.perPlate.reduce((sum, plate) => sum + plate.reactTypedArrayBytes, 0))
    .toBe(snapshot.renderer.reactTypedArrayBytes);
  expect(snapshot.renderer.perPlate.reduce((sum, plate) => sum + plate.gpuProjectionEstimatedBytes, 0))
    .toBe(snapshot.renderer.gpuProjectionEstimatedBytes);
}

async function openProject(page: Page): Promise<void> {
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
}

test('profiles Add Plate, Move availability, and Undo restoration with complete attribution', async () => {
  const preferencesPath = join(mkdtempSync(join(tmpdir(), 'orca-real-project-profile-')), 'preferences.json');
  writeFileSync(preferencesPath, JSON.stringify({
    version: 1, projectLoadBehaviour: 'load_all', selectedProfiles: {}, ui: {},
  }));
  const env = {
    ...process.env,
    ORCA_E2E: '1', ORCA_E2E_REAL: '1', ORCA_E2E_VISIBLE: '1',
    ORCA_E2E_MODEL: PROJECT_PATH, ORCA_E2E_PRIME_TOWER_PROJECT: PROJECT_PATH,
    ORCA_E2E_PREFERENCES: preferencesPath,
    VITE_USE_MOCK: '0', VITE_E2E: '1', VITE_REAL_PROJECT_PROFILE: '1',
  } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app: ElectronApplication = await _electron.launch({ args: ['.'], cwd: DESKTOP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.bringToFront();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.isVisible() ?? false), {
      message: 'the performance profile must drive a visible Electron window',
      timeout: 10_000,
    }).toBe(true);
    await expect(page.getByTestId('slicer-status')).toHaveText('Ready', { timeout: 300_000 });
    await page.locator('#app-tab-prepare').click();
    await openProject(page);

    const readEvidence = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { projectLoadEvidence?: () => unknown } })
        .__orcaE2e?.projectLoadEvidence?.() ?? null,
    );
    await expect.poll(readEvidence, { timeout: 300_000 }).toMatchObject({
      receipt: {
        sourceDisplayName: basename(PROJECT_PATH),
        sourceByteLength: statSync(PROJECT_PATH).size,
        nativeResult: { ok: true, mode: 'project', multiPlate: true, plateCount: 11 },
      },
    });

    const readDiagnostics = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { historyDiagnostics?: () => Diagnostics } })
        .__orcaE2e?.historyDiagnostics?.() ?? null,
    );
    const takeNativeProfile = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { takeNativePerformanceProfile?: () => Promise<NativeProfile> } })
        .__orcaE2e?.takeNativePerformanceProfile?.() ?? Promise.resolve({ version: 1 as const, samples: [] }),
    );
    const takeAttribution = () => page.evaluate(async () => {
      const hook = (window as unknown as { __orcaE2e?: {
        takeRealProjectProfileSnapshot?: () => Promise<NativeMemory>;
        realProjectRendererMemorySnapshot?: () => RendererMemory;
      } }).__orcaE2e;
      if (!hook?.takeRealProjectProfileSnapshot || !hook.realProjectRendererMemorySnapshot)
        throw new Error('dedicated profile hooks were compiled out of the enabled build');
      return { native: await hook.takeRealProjectProfileSnapshot(), renderer: hook.realProjectRendererMemorySnapshot() };
    });
    const readCenters = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { modelWorldCenters?: () => Array<[number, number, number]> } })
        .__orcaE2e?.modelWorldCenters?.() ?? [],
    );
    const readProfiledCenters = () => page.evaluate(() => {
      const sample = (window as unknown as { __orcaE2e?: {
        realProjectModelWorldCentersProfile?: () => BoundsProfile;
      } }).__orcaE2e?.realProjectModelWorldCentersProfile?.();
      if (!sample) throw new Error('dedicated renderer bounds profile hook was compiled out of the enabled build');
      return sample;
    });
    const readBounds = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { selectionBoundsWorld?: () => Bounds } })
        .__orcaE2e?.selectionBoundsWorld?.() ?? null,
    );
    const readBeds = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { bedPlateStates?: () => BedState[] } })
        .__orcaE2e?.bedPlateStates?.() ?? [],
    );
    const readPlateCenters = (plateId: string) => page.evaluate((id) =>
      (window as unknown as { __orcaE2e?: {
        realProjectPlateModelWorldCenters?: (target: string) => Array<[number, number, number]>;
      } }).__orcaE2e?.realProjectPlateModelWorldCenters?.(id) ?? [], plateId,
    );
    const readActiveSliceCount = () => page.evaluate(async () => Number(await
      (window as unknown as { __orcaE2e?: { realProjectProfileActiveSliceCount?: () => Promise<unknown> } })
        .__orcaE2e?.realProjectProfileActiveSliceCount?.() ?? -1),
    );
    const canvas = page.getByTestId('viewport').locator('canvas[data-engine^="three.js"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Prepare canvas has no visible bounds');
    const project = (point: [number, number, number]) => page.evaluate((p) =>
      (window as unknown as { __orcaE2e?: { projectWorldToScreen?: (q: [number, number, number]) => Point | null } })
        .__orcaE2e?.projectWorldToScreen?.(p) ?? null, point,
    );
    const readSelectionCount = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { selectionInstanceCount?: () => number } })
        .__orcaE2e?.selectionInstanceCount?.() ?? 0,
    );
    const readOwner = () => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { pointerOwner?: () => string } }).__orcaE2e?.pointerOwner?.() ?? 'none',
    );
    const selectVisibleCenter = async (candidates: Array<[number, number, number]>): Promise<Point | null> => {
      for (const center of candidates) {
        const candidate = await project(center);
        if (!candidate) continue;
        for (const [dx, dy] of [[0, 0], [20, 0], [-20, 0], [0, 20], [0, -20]]) {
          const x = candidate.x + dx;
          const y = candidate.y + dy;
          if (x < 0 || y < 0 || x > box.width || y > box.height) continue;
          await page.mouse.click(box.x + x, box.y + y);
          if (await readSelectionCount() > 0) return { x, y };
        }
      }
      return null;
    };

    await expect.poll(readCenters, { timeout: 300_000 }).not.toHaveLength(0);
    await takeNativeProfile();
    const baseline = await takeAttribution();
    expectAttribution(baseline, 11);
    expectCalls(baseline.native, []);

    // Prepare one real Move entry, then start a detached slice from that moved
    // state so Undo can restore its predecessor while Print::process() remains
    // active on the pthread.
    const activeBed = (await readBeds()).find((bed) => bed.current);
    if (!activeBed?.plateId) throw new Error('real project has no current rendered plate');
    const populated = baseline.renderer.perPlate.find((plate) => plate.plateId === activeBed.plateId);
    if (!populated || populated.volumeCount === 0)
      throw new Error(`current real project plate ${activeBed.plateId} has no projected model`);
    const layerHeight = page.locator('#layer_height');
    await layerHeight.fill('0.05');
    await layerHeight.blur();
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { realProjectProfileMutationPendingCount?: () => number } })
        .__orcaE2e?.realProjectProfileMutationPendingCount?.() ?? -1), {
      message: 'thin-layer setup must commit before the Move history entry',
      timeout: 30_000,
      intervals: [10],
    }).toBe(0);
    const activePlateCenters = await readPlateCenters(activeBed.plateId);
    expect(activePlateCenters.length, 'target plate must contain projected model volumes').toBeGreaterThan(0);
    const activeBeforeCenters = (await readCenters()).map((center) => [...center]);
    const activeMoveBefore = await readDiagnostics();
    if (!activeMoveBefore?.worker || !activeMoveBefore.client)
      throw new Error('history diagnostics unavailable before active-slice Move');
    await takeNativeProfile();
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…', { timeout: 30_000 });
    await expect.poll(readActiveSliceCount, {
      message: 'profile must observe the detached native slice before editing',
      timeout: 120_000,
      intervals: [20],
    }).toBe(1);
    // Slice requests Preview immediately. Threaded mode keeps Prepare
    // available, so return there before exercising an edit against the live
    // detached job.
    await page.locator('#app-tab-prepare').click();
    await takeAttribution();
    const activeSelected = await page.evaluate((plateId) =>
      (window as unknown as { __orcaE2e?: { realProjectSelectFirstModelOnPlate?: (id: string) => boolean } })
        .__orcaE2e?.realProjectSelectFirstModelOnPlate?.(plateId) ?? false, activeBed.plateId);
    expect(activeSelected, 'profile setup must select a real model on the active slice plate').toBe(true);
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as { __orcaE2e?: { realProjectProfileMutationPendingCount?: () => number } })
        .__orcaE2e?.realProjectProfileMutationPendingCount?.() ?? -1), {
      message: 'threaded edit must begin after the application mutation publication fence is idle',
      timeout: 30_000,
      intervals: [10],
    }).toBe(0);
    // Print::apply admission is complete once the detached job is observable.
    // Start the capture-work delta here so it measures the ordinary Move
    // transaction itself, not slice-time cache normalization.
    const activeCaptureBefore = await takeAttribution();
    const activeMove = await page.evaluate(() =>
      (window as unknown as { __orcaE2e?: {
        realProjectMoveSelectedX?: (delta: number) => { moved: boolean; startedAt: number };
      } }).__orcaE2e?.realProjectMoveSelectedX?.(5) ?? { moved: false, startedAt: 0 });
    expect(activeMove.moved, 'profile setup must submit one real Move through the scene controller').toBe(true);
    let activeUndoAt = 0;
    await expect.poll(async () => {
      const moved = (await readCenters()).some((center, index) =>
        center.some((value, axis) => Math.abs(value - activeBeforeCenters[index][axis]) > 1e-6));
      const undo = page.getByTestId('history-undo');
      const done = moved && await undo.getAttribute('aria-label') === 'Undo Move' && await undo.isEnabled();
      if (done && activeUndoAt === 0) activeUndoAt = await page.evaluate(() => performance.now());
      return done;
    }, { timeout: 120_000, intervals: [10] }).toBe(true);
    const activeMoveAfter = await readDiagnostics();
    if (!activeMoveAfter?.worker || !activeMoveAfter.client)
      throw new Error('history diagnostics unavailable after active-slice Move');
    const activeMoveVisibleMs = activeUndoAt - activeMove.startedAt;
    const activeMoveNative = await takeNativeProfile();
    const activeTransformIndex = activeMoveNative.samples.findIndex((sample) => sample.operation === 'set_model_transforms');
    expect(activeTransformIndex).toBeGreaterThanOrEqual(0);
    const activeMoveProjections = activeMoveNative.samples.slice(activeTransformIndex + 1)
      .filter((sample) => sample.operation === 'prime_tower_projection');
    expect(activeMoveProjections.length, 'the committed active-slice Move must refresh its tower projection').toBeGreaterThan(0);
    for (const sample of activeMoveProjections) {
      expect(sample.stagesMs.used_slot_full_scan_fallback,
        'slice cancellation must preserve valid input-derived usage summaries').toBe(0);
    }
    const activeMoveMemory = await takeAttribution();
    console.log('[active-slice-move-profile]', JSON.stringify({
      visibleMs: activeMoveVisibleMs,
      workerMutationMs: activeMoveAfter.worker.mutation.lastMs,
      clientMutationMs: activeMoveAfter.client.mutation.lastMs,
      appMutationMs: activeMoveAfter.app.mutation.lastMs,
      operations: activeMoveNative.samples.map((sample) => ({
        operation: sample.operation,
        totalMs: sample.stagesMs.total,
        stagesMs: sample.stagesMs,
      })),
      serializedObjectDelta: activeMoveMemory.native.history.serialized_object_count -
        activeCaptureBefore.native.history.serialized_object_count,
      reusedObjectDelta: activeMoveMemory.native.history.reused_object_count -
        activeCaptureBefore.native.history.reused_object_count,
      captureCounts: {
        beforeSerialized: activeCaptureBefore.native.history.serialized_object_count,
        beforeReused: activeCaptureBefore.native.history.reused_object_count,
        afterSerialized: activeMoveMemory.native.history.serialized_object_count,
        afterReused: activeMoveMemory.native.history.reused_object_count,
        beforeMisses: activeCaptureBefore.native.history.object_cache_misses,
        afterMisses: activeMoveMemory.native.history.object_cache_misses,
        beforeFingerprintMisses: activeCaptureBefore.native.history.object_fingerprint_misses,
        afterFingerprintMisses: activeMoveMemory.native.history.object_fingerprint_misses,
      },
      jsWasmOperations: activeMoveMemory.native.js_wasm_calls.map((sample) => ({
        operation: sample.operation,
        wallMs: sample.wallMs,
        inputJsonBytes: sample.inputJsonBytes,
        outputJsonBytes: sample.outputJsonBytes,
      })),
    }));
    expect.soft(activeMoveVisibleMs,
      'an active threaded slice must not delay Move Undo publication beyond 100 ms').toBeLessThan(100);
    await expect.poll(readActiveSliceCount, {
      message: 'the slice invalidated by Move must release the job slot before the Undo scenario',
      timeout: 300_000,
      intervals: [20],
    }).toBe(0);
    await page.getByTestId('btn-slice').click();
    await expect(page.getByTestId('slicer-status')).toHaveText('Slicing…', { timeout: 30_000 });
    await expect.poll(readActiveSliceCount, {
      message: 'profile must observe the detached native slice before Undo',
      timeout: 120_000,
      intervals: [20],
    }).toBe(1);
    await page.locator('#app-tab-prepare').click();
    await expect(page.getByTestId('history-undo')).toBeEnabled({ timeout: 30_000 });
    expect(await readActiveSliceCount(),
      'Undo acceptance must begin while the obsolete detached slice is still active').toBe(1);
    const activeUndoStartedAt = await page.evaluate(() => performance.now());
    await page.getByTestId('history-undo').click();
    await expect(page.getByTestId('history-redo')).toHaveAttribute('aria-label', 'Redo Move', { timeout: 30_000 });
    const restoredWhileSlicePending = await page.evaluate(() =>
      (window as unknown as {
        __orcaE2e?: { realProjectProfileLastRestoreSliceActive?: () => boolean | null };
      }).__orcaE2e?.realProjectProfileLastRestoreSliceActive?.() ?? null);
    expect(restoredWhileSlicePending,
      'native Undo response must precede the obsolete slice public terminal').toBe(true);
    await expect.poll(async () => {
      const restored = await readCenters();
      return restored.length === activeBeforeCenters.length && restored.every((center, index) =>
        center.every((value, axis) => Math.abs(value - activeBeforeCenters[index][axis]) <= 1e-6));
    }, { timeout: 30_000, intervals: [10] }).toBe(true);
    const activeUndoVisibleMs = await page.evaluate((startedAt) => performance.now() - startedAt,
      activeUndoStartedAt);
    expect(activeUndoVisibleMs,
      'threaded Undo must not await obsolete slice terminal cleanup').toBeLessThan(500);
    await expect.poll(readActiveSliceCount, {
      message: 'the obsolete slice must reach its terminal and release the global job slot',
      timeout: 300_000,
      intervals: [20],
    }).toBe(0);
    await expect(page.getByTestId('btn-export')).toBeDisabled();
    await expect(page.getByTestId('slicer-status')).not.toHaveText('Sliced');
    await expect(page.getByTestId('slicer-status')).not.toContainText('slice_busy');
    expect(activeMoveNative.samples.map((sample) => sample.operation).filter((operation) =>
      ['history_begin', 'set_model_transforms', 'history_commit'].includes(operation)))
      .toEqual(['history_begin', 'set_model_transforms', 'history_commit']);
    expect(activeMoveMemory.native.js_wasm_calls.map((sample) => sample.operation).filter((operation) =>
      ['orc_history_begin', 'orc_set_model_transforms', 'orc_history_commit'].includes(operation)))
      .toEqual(['orc_history_begin', 'orc_set_model_transforms', 'orc_history_commit']);
    expect(activeMoveMemory.native.history.serialized_object_count -
      activeCaptureBefore.native.history.serialized_object_count,
    'an active-slice Move must reuse the canonical archive beneath its transform overlay').toBe(0);
    // The active-slice Undo is independently asserted above. Clear its native
    // restore/projection samples so the following Add Plate attribution owns
    // an exact operation window.
    await takeNativeProfile();
    await takeAttribution();

    // Add Plate: event dispatch to the enabled matching Undo entry.
    const addBefore = await readDiagnostics();
    if (!addBefore?.worker || !addBefore.client) throw new Error('history diagnostics unavailable');
    const addStart = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('[data-testid="add-plate"]');
      if (!button || button.disabled) throw new Error('Add Plate is not enabled');
      const startedAt = window.performance.now();
      button.click();
      return startedAt;
    });
    let addUndoAt = 0;
    await expect.poll(async () => {
      const undo = page.getByTestId('history-undo');
      const done = await undo.getAttribute('aria-label') === 'Undo Add Plate' && await undo.isEnabled();
      if (done && addUndoAt === 0) addUndoAt = await page.evaluate(() => window.performance.now());
      return done;
    }, { timeout: 120_000, intervals: [10] }).toBe(true);
    const addAfter = await readDiagnostics();
    if (!addAfter?.worker || !addAfter.client) throw new Error('history diagnostics unavailable after Add Plate');
    const addNative = await takeNativeProfile();
    const addOperations = addNative.samples.map((sample) => sample.operation);
    expect(addOperations.slice(0, 3)).toEqual(['history_begin', 'add_plate', 'history_commit']);
    expect(addOperations.slice(3).every((operation) => operation === 'prime_tower_projection')).toBe(true);
    const addMemory = await takeAttribution();
    expectAttribution(addMemory, 12);
    expectCalls(addMemory.native, ['orc_history_begin', 'orc_add_plate', 'orc_history_commit']);
    const addNativeMs = addNative.samples.slice(0, 3).reduce((sum, sample) => sum + sample.stagesMs.total, 0);
    const addJsWasmMs = addMemory.native.js_wasm_calls.reduce((sum, sample) => sum + sample.wallMs, 0);
    const addVisibleMs = addUndoAt - addStart;
    console.log('[add-plate-gate-profile]', JSON.stringify({
      visibleMs: addVisibleMs,
      workerMutationMs: addAfter.worker.mutation.lastMs,
      clientMutationMs: addAfter.client.mutation.lastMs,
      appMutationMs: addAfter.app.mutation.lastMs,
      nativeStages: addNative.samples,
      jsWasmCalls: addMemory.native.js_wasm_calls,
    }));
    expect.soft(addVisibleMs, 'Add Plate must expose Undo within the accepted 100 ms boundary').toBeLessThan(100);

    // Select a genuine rendered model through the canvas and perform one full
    // pointer gesture. The newly-added empty plate remains part of the state.
    const centers = await readCenters();
    const start = await selectVisibleCenter(centers);
    expect(start, 'a real project model must be selectable through the visible canvas').not.toBeNull();
    const beforeMoveCenters = (await readCenters()).map((center) => [...center]);
    const beforeMoveBounds = await readBounds();
    expect(beforeMoveBounds).not.toBeNull();
    await takeNativeProfile();
    const moveCaptureBefore = await takeAttribution();
    const moveBefore = await readDiagnostics();
    if (!moveBefore?.worker || !moveBefore.client) throw new Error('history diagnostics unavailable before Move');
    await page.mouse.move(box.x + start!.x, box.y + start!.y);
    await page.mouse.down();
    await page.mouse.move(box.x + start!.x + 80, box.y + start!.y + 35, { steps: 5 });
    await expect.poll(readOwner, { timeout: 10_000 }).toBe('body');
    await page.mouse.up();
    const pointerUpAt = nodePerformance.now();
    let moveUndoAt = 0;
    await expect.poll(async () => {
      const undo = page.getByTestId('history-undo');
      const moved = (await readCenters()).some((center, index) =>
        center.some((value, axis) => Math.abs(value - beforeMoveCenters[index][axis]) > 1e-6));
      const done = moved && await undo.getAttribute('aria-label') === 'Undo Move' && await undo.isEnabled();
      if (done && moveUndoAt === 0) moveUndoAt = nodePerformance.now();
      return done;
    }, { timeout: 120_000, intervals: [10] }).toBe(true);
    const moveAfter = await readDiagnostics();
    if (!moveAfter?.worker || !moveAfter.client) throw new Error('history diagnostics unavailable after Move');
    const moveNative = await takeNativeProfile();
    const moveOperations = moveNative.samples.map((sample) => sample.operation);
    expect(moveOperations.slice(0, 3)).toEqual(['history_begin', 'set_model_transforms', 'history_commit']);
    expect(moveOperations.slice(3).every((operation) => operation === 'prime_tower_projection')).toBe(true);
    const transform = moveNative.samples[1];
    expect(Object.keys(transform.stagesMs).sort()).toEqual([
      'input_json_decode', 'plate_membership_reflow', 'request_validation_target_resolution',
      'response_json_serialization', 'total', 'transform_mutation',
    ]);
    const moveMemory = await takeAttribution();
    expectAttribution(moveMemory, 12);
    expectCalls(moveMemory.native, ['orc_history_begin', 'orc_set_model_transforms', 'orc_history_commit']);
    expect(moveMemory.native.history.serialized_object_count -
      moveCaptureBefore.native.history.serialized_object_count,
    'a one-object Move must reuse its canonical archive beneath the transform overlay').toBe(0);
    expect(moveMemory.native.history.reused_object_count -
      moveCaptureBefore.native.history.reused_object_count,
    'a Move must share untouched object archives across both complete timestamp roots').toBeGreaterThan(0);
    const moveVisibleMs = moveUndoAt - pointerUpAt;
    expect.soft(moveVisibleMs, 'Move must expose Undo within the accepted 100 ms boundary').toBeLessThan(100);
    console.log('[move-gate-profile]', JSON.stringify({
      visibleMs: moveVisibleMs,
      workerMutationMs: moveAfter.worker.mutation.lastMs,
      clientMutationMs: moveAfter.client.mutation.lastMs,
      appMutationMs: moveAfter.app.mutation.lastMs,
      operations: moveNative.samples.map((sample) => ({ operation: sample.operation, stagesMs: sample.stagesMs })),
      serializedObjectDelta: moveMemory.native.history.serialized_object_count -
        moveCaptureBefore.native.history.serialized_object_count,
      reusedObjectDelta: moveMemory.native.history.reused_object_count -
        moveCaptureBefore.native.history.reused_object_count,
    }));
    const movedCenters = await readCenters();

    // The Undo fence is the restored model projection plus consumed Undo Move
    // and enabled Redo Move, not merely the native history call returning.
    const undoBefore = moveAfter;
    const undoClickAt = nodePerformance.now();
    await page.getByTestId('history-undo').click();
    let restoredAt = 0;
    const rendererBoundsSamples: BoundsProfile[] = [];
    await expect.poll(async () => {
      const sample = await readProfiledCenters();
      rendererBoundsSamples.push(sample);
      const restored = sample.centers;
      const projectionEqual = restored.length === beforeMoveCenters.length && restored.every((center, index) =>
        center.every((value, axis) => Math.abs(value - beforeMoveCenters[index][axis]) <= 1e-6));
      const redo = page.getByTestId('history-redo');
      const undo = page.getByTestId('history-undo');
      const done = projectionEqual && await redo.getAttribute('aria-label') === 'Redo Move' &&
        await redo.isEnabled() && await undo.getAttribute('aria-label') !== 'Undo Move';
      if (done && restoredAt === 0) restoredAt = nodePerformance.now();
      return done;
    }, { timeout: 30_000, intervals: [10] }).toBe(true);
    const undoAfter = await readDiagnostics();
    if (!undoAfter?.worker || !undoAfter.client) throw new Error('history diagnostics unavailable after Undo');
    const undoNative = await takeNativeProfile();
    expect(undoNative.samples.map((sample) => sample.operation)).toEqual(['history_restore', 'prime_tower_projection']);
    expect(Object.keys(undoNative.samples[0].stagesMs).sort()).toEqual([
      'immutable_mesh_reconnect', 'model_staging_deserialization',
      'plate_session_project_overlay_restore', 'total',
    ]);
    expect(undoNative.samples[1].perPlateStagesMs).toHaveLength(12);
    const undoMemory = await takeAttribution();
    expectAttribution(undoMemory, 12);
    expectCalls(undoMemory.native, ['orc_history_undo']);
    expect(undoAfter.app.directRestore.count - undoBefore.app.directRestore.count,
      'real-project Move Undo must publish one stable-ID scene delta').toBe(1);
    expect(undoAfter.app.transformReceiptApplied - undoBefore.app.transformReceiptApplied,
      'timestamp history must not use the removed sparse transform receipt').toBe(0);
    expect(undoAfter.app.transformReceiptFallbacks - undoBefore.app.transformReceiptFallbacks,
      'real-project Move Undo must not fall back to a full projection reload').toBe(0);
    expect(undoAfter.app.fullRestoreModelReloads - undoBefore.app.fullRestoreModelReloads,
      'real-project Move Undo must not reload the full model projection').toBe(0);
    expect(undoAfter.app.transformReceiptProofFailures - undoBefore.app.transformReceiptProofFailures,
      'real-project Move Undo receipt proof must remain valid').toBe(0);
    expect.soft(restoredAt - undoClickAt,
      'real-project Move Undo restore fence must remain below the 500 ms regression boundary').toBeLessThan(500);

    await page.getByTestId('history-redo').click();
    await expect.poll(async () => {
      const redone = await readCenters();
      return redone.length === movedCenters.length && redone.every((center, index) =>
        center.every((value, axis) => Math.abs(value - movedCenters[index][axis]) <= 1e-6));
    }, { timeout: 30_000, intervals: [10] }).toBe(true);
    await expect(page.getByTestId('history-undo')).toHaveAttribute('aria-label', 'Undo Move');
    await expect(page.getByTestId('history-undo')).toBeEnabled();

    const report = {
      fixture: { name: basename(PROJECT_PATH), bytes: statSync(PROJECT_PATH).size, nativePlates: 11 },
      addPlate: {
        clickToVisibleUndoMs: addVisibleMs,
        applicationMs: timingDelta(addBefore.app.mutation, addAfter.app.mutation, 'Add Plate application'),
        clientMs: timingDelta(addBefore.client.mutation, addAfter.client.mutation, 'Add Plate client'),
        workerMs: timingDelta(addBefore.worker.mutation, addAfter.worker.mutation, 'Add Plate Worker'),
        jsWasmCallMs: addJsWasmMs,
        jsWasmResidualMs: addJsWasmMs - addNativeMs,
        nativeStages: addNative.samples,
      },
      move: {
        pointerUpToVisibleUndoMs: moveVisibleMs,
        applicationMs: timingDelta(moveBefore.app.mutation, moveAfter.app.mutation, 'Move application'),
        clientMs: timingDelta(moveBefore.client.mutation, moveAfter.client.mutation, 'Move client'),
        workerMs: timingDelta(moveBefore.worker.mutation, moveAfter.worker.mutation, 'Move Worker'),
        jsWasmCalls: moveMemory.native.js_wasm_calls,
        nativeStages: moveNative.samples,
      },
      activeSliceMove: {
        plateId: activeBed.plateId,
        editCommitToVisibleUndoMs: activeMoveVisibleMs,
        applicationMs: timingDelta(activeMoveBefore.app.mutation, activeMoveAfter.app.mutation,
          'active-slice Move application'),
        clientMs: timingDelta(activeMoveBefore.client.mutation, activeMoveAfter.client.mutation,
          'active-slice Move client'),
        workerMs: timingDelta(activeMoveBefore.worker.mutation, activeMoveAfter.worker.mutation,
          'active-slice Move Worker'),
        nativeStages: activeMoveNative.samples,
      },
      undo: {
        clickToRestoredModelMs: restoredAt - undoClickAt,
        clientMs: timingDelta(undoBefore.client!.restore, undoAfter.client.restore, 'Undo client'),
        workerMs: timingDelta(undoBefore.worker!.restore, undoAfter.worker.restore, 'Undo Worker'),
        jsWasmCalls: undoMemory.native.js_wasm_calls,
        nativeStages: undoNative.samples,
        application: {
          restoreMs: timingDelta(undoBefore.app.restore, undoAfter.app.restore, 'Undo application restore'),
          // Timestamp Undo publishes one stable-ID scene patch; unchanged
          // renderer resources remain live.
          projectionMs: optionalTimingDelta(undoBefore.app.projection, undoAfter.app.projection),
          filamentRefreshMs: timingDelta(undoBefore.app.filamentRefresh, undoAfter.app.filamentRefresh, 'Undo filament refresh'),
          // A matching narrow Prime Tower restore receipt patches the retained
          // projection without a Worker read; mismatches still measure the
          // authoritative fallback read here.
          primeTowerProjectionReadMs: optionalTimingDelta(undoBefore.app.primeTowerProjectionRead,
            undoAfter.app.primeTowerProjectionRead),
          transformReceiptApplicationMs: optionalTimingDelta(undoBefore.app.transformReceiptApplication,
            undoAfter.app.transformReceiptApplication),
          selectionRestoreMs: optionalTimingDelta(undoBefore.app.selectionRestore,
            undoAfter.app.selectionRestore),
          fullRestoreModelReloads: undoAfter.app.fullRestoreModelReloads - undoBefore.app.fullRestoreModelReloads,
          transformReceiptApplied: undoAfter.app.transformReceiptApplied - undoBefore.app.transformReceiptApplied,
          transformReceiptFallbacks: undoAfter.app.transformReceiptFallbacks - undoBefore.app.transformReceiptFallbacks,
          transformReceiptProofFailures: undoAfter.app.transformReceiptProofFailures - undoBefore.app.transformReceiptProofFailures,
          transformReceiptProofLastFailure: undoAfter.app.transformReceiptProofLastFailure,
        },
        rendererBounds: {
          samples: rendererBoundsSamples.map(({ identity, durationMs }) => ({ identity, durationMs })),
          totalMs: rendererBoundsSamples.reduce((sum, sample) => sum + sample.durationMs, 0),
          maxMs: Math.max(...rendererBoundsSamples.map((sample) => sample.durationMs)),
        },
      },
      attribution: { baseline, afterAddPlate: addMemory, afterMove: moveMemory, afterUndo: undoMemory },
      deltas: {
        wasmHeapAfterAdd: addMemory.native.wasm_heap_bytes - baseline.native.wasm_heap_bytes,
        wasmHeapAfterMove: moveMemory.native.wasm_heap_bytes - addMemory.native.wasm_heap_bytes,
        wasmHeapAfterUndo: undoMemory.native.wasm_heap_bytes - moveMemory.native.wasm_heap_bytes,
        reactTypedArraysAfterAdd: addMemory.renderer.reactTypedArrayBytes - baseline.renderer.reactTypedArrayBytes,
        reactTypedArraysAfterMove: moveMemory.renderer.reactTypedArrayBytes - addMemory.renderer.reactTypedArrayBytes,
        reactTypedArraysAfterUndo: undoMemory.renderer.reactTypedArrayBytes - moveMemory.renderer.reactTypedArrayBytes,
        gpuProjectionAfterAdd: addMemory.renderer.gpuProjectionEstimatedBytes - baseline.renderer.gpuProjectionEstimatedBytes,
        gpuProjectionAfterMove: moveMemory.renderer.gpuProjectionEstimatedBytes - addMemory.renderer.gpuProjectionEstimatedBytes,
        gpuProjectionAfterUndo: undoMemory.renderer.gpuProjectionEstimatedBytes - moveMemory.renderer.gpuProjectionEstimatedBytes,
      },
    };
    const undoTower = report.undo.nativeStages.find(stage => stage.operation === 'prime_tower_projection');
    expect(undoTower?.stagesMs.used_slot_full_scan_fallback).toBe(0);
    console.log('[real-project-interaction-profile-summary]', JSON.stringify({
      addPlateVisibleUndoMs: report.addPlate.clickToVisibleUndoMs,
      moveVisibleUndoMs: report.move.pointerUpToVisibleUndoMs,
      activeSliceMoveVisibleUndoMs: report.activeSliceMove.editCommitToVisibleUndoMs,
      activeSlicePlateId: report.activeSliceMove.plateId,
      undoRestoredModelMs: report.undo.clickToRestoredModelMs,
      undoProjectionMs: report.undo.application.projectionMs,
      undoTransformReceiptApplied: report.undo.application.transformReceiptApplied,
      undoTransformReceiptFallbacks: report.undo.application.transformReceiptFallbacks,
      undoTransformReceiptProofLastFailure: report.undo.application.transformReceiptProofLastFailure,
      wasmHeapBytes: undoMemory.native.wasm_heap_bytes,
      historyRetainedBytes: undoMemory.native.history.retained_estimated_bytes,
      sharedSourceMeshBytes: undoMemory.native.shared_source_mesh.total_bytes,
      plateStructuralBytes: undoMemory.native.plates.reduce((sum, plate) =>
        sum + plate.structural_model_copy_estimated_bytes, 0),
      plateDerivedCacheBytes: undoMemory.native.plates.reduce((sum, plate) =>
        sum + plate.derived_cache_estimated_bytes, 0),
      reactTypedArrayBytes: undoMemory.renderer.reactTypedArrayBytes,
      gpuProjectionEstimatedBytes: undoMemory.renderer.gpuProjectionEstimatedBytes,
    }));
    console.log('[real-project-interaction-profile]', JSON.stringify(report));
  } finally {
    await app.close();
  }
});
