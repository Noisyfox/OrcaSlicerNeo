// packages/slicer-wasm/src/client/client.test.ts
// Contract tests for the typed bridge client, driven against the
// bridge-shaped mock module (Task 1). These pin the M2 bridge
// contract that Task 7 implements in C++.
import { afterEach, describe, it, expect } from 'vitest';
import { createMockModule, type MockFeature } from './testing/mock-module';
import { createClient, normalizeSceneDelta } from './client';
import { PREVIEW_TEXT_CHUNK_MAX_BYTES, PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES } from './types';
import type { ModelTransform, VolumeType } from './types';

function makeClient() {
  return createClient(async () => createMockModule());
}

describe('SlicerClient bridge contract', () => {
  it('validates the native retained-geometry proof and its complete transform transport', () => {
    const transform = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    const native = { version: 1, object_ids: [1], volume_ids: [2], instance_ids: [3], plate_ids: ['plate-1'],
      object_order: [1], retained_renderer_object_ids: [1], retained_volume_transforms: [{ volume_id: 2, transform }] };
    expect(normalizeSceneDelta(native)).toMatchObject({ retainedRendererObjectIds: [1],
      retainedVolumeTransforms: [{ volumeId: 2, transform }] });
    expect(normalizeSceneDelta({ ...native, retained_renderer_object_ids: [99] })).toBeUndefined();
    expect(normalizeSceneDelta({ ...native, retained_volume_transforms: undefined })).toBeUndefined();
    expect(normalizeSceneDelta({ ...native, retained_volume_transforms: [{ volume_id: 99, transform }] })).toBeUndefined();
  });
  const originalPerformanceMemory = Object.getOwnPropertyDescriptor(performance, 'memory');

  afterEach(() => {
    if (originalPerformanceMemory) Object.defineProperty(performance, 'memory', originalPerformanceMemory);
    else delete (performance as Performance & { memory?: unknown }).memory;
  });

  it('reads Worker JavaScript heap and WASM linear-memory capacity without a native profiling hook', async () => {
    Object.defineProperty(performance, 'memory', { configurable: true, value: { usedJSHeapSize: 123 } });
    const module = createMockModule();
    await expect(createClient(async () => module).getRuntimeMemory()).resolves.toEqual({
      jsHeapUsedBytes: 123,
      wasmLinearMemoryBytes: module.HEAPU8.buffer.byteLength,
    });
  });

  it('normalizes the strict scalar native Prime Tower profile schema', async () => {
    const aggregateStages = {
      session_preparation: 0.1, bounds_scan: 0.2, effective_config_construction: 1,
      plate_local_model_construction: 2, used_slot_summary_hit: 0.1, used_slot_summary_delta: 0.2,
      used_slot_full_scan_fallback: 2.7, used_slot_scan: 3, printable_height_bounds_scan: 4,
      direct_wipe_tower_estimate: 5, print_apply_wipe_tower_data_fallback: 0,
      footprint_bands_projection_json: 6,
      final_json_serialization: 0.7, final_json_copy: 0.8, total: 23.8,
    };
    const plateStages = {
      effective_config_construction: 0.1, plate_local_model_construction: 0.2,
      used_slot_summary_hit: 0.01, used_slot_summary_delta: 0.02,
      used_slot_full_scan_fallback: 0.27, used_slot_scan: 0.3, printable_height_bounds_scan: 0.4,
      direct_wipe_tower_estimate: 0.5, print_apply_wipe_tower_data_fallback: 0,
      footprint_bands_projection_json: 0.6, total: 2.1,
    };
    const profile = await createClient(async () => createMockModule({ nativePerformanceProfile: {
      version: 1, samples: [{ operation: 'prime_tower_projection', stages_ms: aggregateStages,
        per_plate_stages_ms: [plateStages, plateStages] }],
    } })).takeNativePerformanceProfile!();
    expect(profile).toEqual({ version: 1, samples: [{ operation: 'prime_tower_projection',
      stagesMs: aggregateStages, perPlateStagesMs: [plateStages, plateStages] }] });
  });

  it('rejects malformed Prime Tower native profile stage shape', async () => {
    const profile = { version: 1, samples: [{ operation: 'prime_tower_projection', stages_ms: {
      total: 1,
    }, per_plate_stages_ms: [] }] };
    await expect(createClient(async () => createMockModule({ nativePerformanceProfile: profile }))
      .takeNativePerformanceProfile!()).rejects.toThrow('invalid prime tower performance stages');
  });

  it('keeps disabled prime towers non-empty while clearing eligibility', async () => {
    const module = createMockModule({ primeTowerFixture: true });
    const c = createClient(async () => module);
    const enabled = await c.getPrimeTowerProjection();
    expect(enabled).toMatchObject({ ok: true, plates: [{ eligible: true, empty: false }] });
    const disabled = await c.setNativeScopedConfig({ scope: 'project' }, 'enable_prime_tower', '0');
    expect(disabled).toMatchObject({ ok: true });
    const projection = await c.getPrimeTowerProjection();
    expect(projection).toMatchObject({ ok: true, plates: [{ eligible: false, empty: false, usedSlots: [] }] });
  });

  it('normalizes the native Prime Tower projection and keeps geometry out of React', async () => {
    const payload = {
      ok: true, version: 1, current_plate_id: 'plate-session-1-plate-1',
      build_area: { min_x: 0, max_x: 200, min_y: 0, max_y: 200, max_z: 300 },
      plates: [{ plate_id: 'plate-session-1-plate-1', display_index: 0,
        eligible: true, empty: false, forced: false, used_slots: [1, 2],
        width: 60, depth: 20, height: 10, position: { x: 15, y: 220 }, rotation: 90,
        brim_margin: 3, footprint: { min_x: -8, max_x: 18, min_y: 217, max_y: 283 },
        bands: [
          { slot: 1, start_depth: 0, end_depth: 10, colour: '#333333', opacity: 0.66 },
          { slot: 2, start_depth: 10, end_depth: 20, colour: '#FFD700', opacity: 0.66 },
        ], build_area: { min_x: 0, max_x: 200, min_y: 0, max_y: 200, max_z: 300 } }],
    };
    const result = await createClient(async () => createMockModule({ primeTowerProjection: payload }))
      .getPrimeTowerProjection();
    expect(result).toEqual({ ok: true, version: 1, currentPlateId: 'plate-session-1-plate-1',
      buildArea: { minX: 0, maxX: 200, minY: 0, maxY: 200, maxZ: 300 }, plates: [{
        plateId: 'plate-session-1-plate-1', displayIndex: 0, eligible: true, empty: false, forced: false,
        usedSlots: [1, 2], width: 60, depth: 20, height: 10, position: { x: 15, y: 220 }, rotation: 90,
        brimMargin: 3, footprint: { minX: -8, maxX: 18, minY: 217, maxY: 283 },
        bands: [{ slot: 1, startDepth: 0, endDepth: 10, colour: '#333333', opacity: 0.66 },
          { slot: 2, startDepth: 10, endDepth: 20, colour: '#FFD700', opacity: 0.66 }],
        buildArea: { minX: 0, maxX: 200, minY: 0, maxY: 200, maxZ: 300 },
      }] });
  });

  it('rejects malformed Prime Tower geometry and unsupported versions', async () => {
    await expect(createClient(async () => createMockModule({ primeTowerProjection: { ok: true, version: 2 } }))
      .getPrimeTowerProjection()).resolves.toEqual({ ok: false, error: 'invalid prime tower projection response' });
    const base = { ok: true, version: 1, current_plate_id: 'p',
      build_area: { min_x: 0, max_x: 200, min_y: 0, max_y: 200, max_z: 300 },
      plates: [{ plate_id: 'p', display_index: 0, eligible: false, empty: true, forced: false,
        used_slots: [], width: 0, depth: 0, height: 0, position: { x: 0, y: 0 }, rotation: 0,
        brim_margin: 0, footprint: { min_x: 0, max_x: 0, min_y: 0, max_y: 0 }, bands: [],
        build_area: { min_x: 0, max_x: 200, min_y: 0, max_y: 200, max_z: 300 } }] };
    await expect(createClient(async () => createMockModule({ primeTowerProjection: {
      ...base, plates: [{ ...base.plates[0], eligible: true }],
    } })).getPrimeTowerProjection()).resolves.toEqual({ ok: false, error: 'invalid prime tower projection plates' });
  });

  it('moves Prime Tower position with one clamped history mutation and fences stale revisions', async () => {
    const plateId = 'plate-session-1-plate-1';
    const payload = {
      ok: true, version: 1, current_plate_id: plateId,
      build_area: { min_x: 0, max_x: 200, min_y: 0, max_y: 200, max_z: 300 },
      plates: [{ plate_id: plateId, display_index: 0,
        eligible: true, empty: false, forced: false, used_slots: [1, 2],
        width: 20, depth: 30, height: 10, position: { x: 15, y: 15 }, rotation: 45,
        brim_margin: 3, footprint: { min_x: 0, max_x: 30, min_y: 0, max_y: 30 },
        bands: [{ slot: 1, start_depth: 0, end_depth: 15, colour: '#333333', opacity: 0.66 },
          { slot: 2, start_depth: 15, end_depth: 30, colour: '#FFD700', opacity: 0.66 }],
        build_area: { min_x: 0, max_x: 200, min_y: 0, max_y: 200, max_z: 300 } }],
    };
    const module = createMockModule({ primeTowerProjection: payload });
    const c = createClient(async () => module);
    const before = await c.getPlateSessionSnapshot();
    expect(before).toMatchObject({ ok: true, inputRevisions: { [plateId]: 0 } });
    if (!before.ok) throw new Error(before.error);
    const moved = await c.movePrimeTower({ version: 1, plateId, revision: before.inputRevisions?.[plateId] ?? -1, x: 999, y: 999 });
    expect(moved).toMatchObject({ ok: true, result: { mutation: {
      kind: 'move', plateId, historyEntryDelta: 1, revisionBefore: 0, revisionAfter: 1,
      dirty: true, affectedPlateIds: [plateId], clamped: true, outsideBoundaryWarning: false,
    } } });
    if (!moved.ok) throw new Error(moved.error);
    expect(moved.result.historyStatus.revision).toBeGreaterThanOrEqual(1);
    if (!moved.result.mutation.position) throw new Error('move response omitted authoritative position');
    expect(moved.result.mutation.position.x).toBeLessThan(200);
    expect(moved.result.mutation.position.y).toBeLessThan(200);
    const noOp = await c.movePrimeTower({ version: 1, plateId, revision: 1,
      x: moved.result.mutation.position.x, y: moved.result.mutation.position.y });
    expect(noOp).toMatchObject({ ok: true, result: { mutation: {
      historyEntryDelta: 0, revisionBefore: 1, revisionAfter: 1, dirty: false, affectedPlateIds: [],
    } } });
    await expect(c.movePrimeTower({ version: 1, plateId, revision: 0, x: 20, y: 20 }))
      .resolves.toMatchObject({ ok: false, errorCode: 'stale_revision' });
    await expect(c.getPlateSessionSnapshot()).resolves.toMatchObject({ ok: true, inputRevisions: { [plateId]: 1 } });
  });

  it('init loads preset collections', async () => {
    const c = makeClient();
    const r = await c.init();
    expect(r.ok).toBe(true);
    expect(r.printers).toBeGreaterThan(0);
  });

  it('projects the authoritative filament session with one-based slots and Default maps', async () => {
    const c = makeClient();
    const snapshot = await c.getFilamentSessionSnapshot();
    expect(snapshot).toMatchObject({ ok: true, version: 1, status: { state: 'ready', error: null } });
    if (!snapshot.ok) throw new Error(snapshot.error);
    expect(snapshot.slots).toEqual([{
      slot: 1,
      preset: { id: 'Generic PLA @System', name: 'Generic PLA @System' },
      colour: { effective: '#F2754E', provenance: 'preset' },
    }]);
    expect(snapshot.mappings).toEqual({ filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] });
    expect(snapshot.assignments.objects).toEqual([]);
    expect(snapshot.flushing).toMatchObject({ matrix: [0], matrixDimension: 1, planeCount: 1, source: 'default' });
    expect(snapshot.capabilities).toMatchObject({ minSlots: 1, maxSlots: 64, flexible: true, canAdd: true, canDelete: false, canMerge: false });
  });

  it('rejects malformed and unsupported filament session payloads at the client boundary', async () => {
    await expect(createClient(async () => createMockModule({ filamentSession: { ok: true, version: 1, slots: [] } }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'invalid filament session slots' });
    await expect(createClient(async () => createMockModule({ filamentSession: { ok: true, version: 2 } }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'unsupported filament session version' });
  });

  it('frees filament JSON responses, including malformed native JSON', async () => {
    const module = createMockModule();
    const originalCall = module.ccall.bind(module);
    let responsePointer = 0;
    module.ccall = ((name, ret, argTypes, args) => {
      if (name === 'orc_get_filament_session_snapshot') {
        const bytes = new TextEncoder().encode('{malformed');
        responsePointer = Number(module._malloc(bytes.length + 1));
        module.HEAPU8.set(bytes, responsePointer);
        return responsePointer;
      }
      return originalCall(name, ret, argTypes, args);
    }) as typeof module.ccall;
    const c = createClient(async () => module);
    await expect(c.getFilamentSessionSnapshot()).rejects.toThrow(SyntaxError);
    expect(module._freedPointers).toContain(responsePointer);
  });

  it('frees every filament command response without retaining a native pointer', async () => {
    const module = createMockModule();
    const c = createClient(async () => module);
    const before = module._freedPointers.length;
    const snapshot = await c.getFilamentSessionSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.error);
    const result = await c.addFilamentSlot({ version: 1, revision: snapshot.revisions.session });
    expect(result.ok).toBe(true);
    expect(module._freedPointers.length).toBeGreaterThanOrEqual(before + 2);
  });

  it('requires the versioned native failure envelope', async () => {
    const failure = { ok: false, version: 1, error: 'native projection failed', error_code: 'native_failure',
      status: { state: 'error', error: 'native projection failed' } };
    await expect(createClient(async () => createMockModule({ filamentSession: failure }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'native projection failed', errorCode: 'native_failure',
        status: { state: 'error', error: 'native projection failed' } });
    await expect(createClient(async () => createMockModule({ filamentSession: { ok: false, error: 'unversioned' } }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'unsupported filament session version' });
    await expect(createClient(async () => createMockModule({ filamentSession: { ok: false, version: 2, error: 'future', error_code: 'future', status: { state: 'error', error: 'future' } } }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'unsupported filament session version' });
    await expect(createClient(async () => createMockModule({ filamentSession: { ok: false, version: 1, error: 'missing code' } }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'invalid filament session error envelope' });
  });

  it('preserves native preset-equivalent and user colour provenance', async () => {
    const payload = {
      ok: true, version: 1,
      slots: [
        { slot: 1, preset: { id: 'preset-a', name: 'preset-a' }, colour: { effective: '#26A69A', provenance: 'preset' } },
        { slot: 2, preset: { id: 'preset-b', name: 'preset-b' }, colour: { effective: '#112233', provenance: 'user' } },
      ],
      mappings: { filament: [1, 1], volume: [0, 0], nozzle: [1, 1], filament2: [1, 1], physical_extruder: [0] },
      flushing: { matrix: [0, 0, 0, 0], vector: [], matrix_dimension: 2, plane_count: 1, source: 'native' },
      capabilities: { min_slots: 1, max_slots: 64, nozzle_count: 1, flexible: true, can_add: true, can_delete: true, can_merge: true },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 0, project: 0, result: 0, plates: {} },
      status: { state: 'ready', error: null },
    };
    const result = await createClient(async () => createMockModule({ filamentSession: payload })).getFilamentSessionSnapshot();
    expect(result).toMatchObject({ ok: true, slots: [
      { colour: { effective: '#26A69A', provenance: 'preset' } },
      { colour: { effective: '#112233', provenance: 'user' } },
    ] });
  });

  it('executes atomic filament commands and rejects stale or injected mutations without changing the snapshot', async () => {
    const c = makeClient();
    const before = await c.getFilamentSessionSnapshot();
    if (!before.ok) throw new Error(before.error);
    const selected = await c.selectFilamentSlotPreset({
      version: 1, revision: before.revisions.session, slot: 1, preset: 'Bambu PLA Matte @BBL X1C',
    });
    expect(selected).toMatchObject({ ok: true, result: { mutation: {
      kind: 'select-preset', historyEntryDelta: 1, revisionBefore: before.revisions.session,
    }, snapshot: { slots: [{ preset: { name: 'Bambu PLA Matte @BBL X1C' } }] } } });
    if (!selected.ok) throw new Error(selected.error);
    const added = await c.addFilamentSlot({ version: 1, revision: selected.result.snapshot.revisions.session });
    expect(added).toMatchObject({ ok: true, result: { mutation: {
      kind: 'add', historyEntryDelta: 1, revisionBefore: selected.result.snapshot.revisions.session,
      dirty: true, allPlateResultsInvalidated: true,
    } } });
    if (!added.ok) throw new Error(added.error);
    expect(added.result.snapshot.slots).toHaveLength(2);
    const edited = await c.setFilamentSlotColour({ version: 1, revision: added.result.snapshot.revisions.session, slot: 2, colour: '#112233' });
    expect(edited).toMatchObject({ ok: true, result: { snapshot: { slots: [
      {}, { colour: { effective: '#112233', provenance: 'user' } },
    ] } } });
    if (!edited.ok) throw new Error(edited.error);
    const beforeInjected = edited.result.snapshot;
    await expect(c.deleteFilamentSlot({ version: 1, revision: beforeInjected.revisions.session, slot: 1, inject_failure: true } as any))
      .resolves.toMatchObject({ ok: false, errorCode: 'native_validation_failure' });
    await expect(c.getFilamentSessionSnapshot()).resolves.toEqual(beforeInjected);
    await expect(c.deleteFilamentSlot({ version: 1, revision: beforeInjected.revisions.session - 1, slot: 1 }))
      .resolves.toMatchObject({ ok: false, errorCode: 'stale_revision' });
    await expect(c.getFilamentSessionSnapshot()).resolves.toEqual(beforeInjected);
  });

  it('applies a remembered rack as a revision-fenced session baseline', async () => {
    const c = makeClient();
    const before = await c.getFilamentSessionSnapshot();
    if (!before.ok) throw new Error(before.error);
    const applied = await c.applyRememberedFilamentRack({ version: 1, revision: before.revisions.session,
      slots: [
        { preset: 'Generic PLA @System', colour: '#112233' },
        { preset: 'Generic PETG @System', colour: '#445566' },
      ] });
    expect(applied).toMatchObject({ ok: true, slots: [
      { slot: 1, preset: { name: 'Generic PLA @System' }, colour: { effective: '#112233', provenance: 'user' } },
      { slot: 2, preset: { name: 'Generic PETG @System' }, colour: { effective: '#445566', provenance: 'user' } },
    ] });
    if (!applied.ok) throw new Error(applied.error);
    await expect(c.applyRememberedFilamentRack({ version: 1, revision: before.revisions.session,
      slots: [{ preset: 'Generic PLA @System', colour: '#112233' }] }))
      .resolves.toMatchObject({ ok: false, errorCode: 'stale_revision' });
    await expect(c.getFilamentSessionSnapshot()).resolves.toEqual(applied);
  });

  it('keeps the filament command fence stable without standalone context history', async () => {
    const c = makeClient();
    const before = await c.getFilamentSessionSnapshot();
    if (!before.ok) throw new Error(before.error);

    const afterContext = await c.getFilamentSessionSnapshot();
    if (!afterContext.ok) throw new Error(afterContext.error);
    expect(afterContext.revisions.session).toBe(before.revisions.session);

    const added = await c.addFilamentSlot({ version: 1, revision: afterContext.revisions.session });
    expect(added.ok).toBe(true);
  });

  it('rejects kind-specific mutation response fields and post-mutation ranges', async () => {
    const base = await makeClient().getFilamentSessionSnapshot();
    if (!base.ok) throw new Error(base.error);
    const toWire = (snapshot: typeof base) => ({ ...snapshot,
      mappings: { ...snapshot.mappings, physical_extruder: snapshot.mappings.physicalExtruder },
      flushing: { ...snapshot.flushing, matrix_dimension: snapshot.flushing.matrixDimension, plane_count: snapshot.flushing.planeCount },
      capabilities: { min_slots: snapshot.capabilities.minSlots, max_slots: snapshot.capabilities.maxSlots,
        nozzle_count: snapshot.capabilities.nozzleCount, flexible: snapshot.capabilities.flexible,
        can_add: snapshot.capabilities.canAdd, can_delete: snapshot.capabilities.canDelete, can_merge: snapshot.capabilities.canMerge },
      assignments: Object.fromEntries(Object.entries(snapshot.assignments).map(([key, entries]) => [key,
        entries.map((entry: { objectId: number; [name: string]: unknown }) => ({ ...entry, object_id: entry.objectId }))])),
    });
    const validSnapshot = { ...base, revisions: { ...base.revisions, session: 1 } };
    const receipt = (revision = 1, dirty = true) => ({
      canUndo: true, canRedo: false, undoEntries: [], redoEntries: [], cursor: revision,
      savedCheckpoint: 0, savedCheckpointEvicted: false, dirty, bytesUsed: 1,
      byteBudget: 10, evictedEntryCount: 0,
      lastEvictedEntryId: null, oldestRetainedEntryId: 'entry-0', oversizedEntryRetained: false,
      disabled: false, activeTransactionId: null, revision,
    });
    const response = (mutation: Record<string, unknown>, snapshot = validSnapshot) => ({
      ok: true, version: 1, result: { snapshot: toWire(snapshot), history_status: receipt(), mutation: {
        kind: 'select-preset', history_entry_delta: 1, revision_before: 0,
        revision_after: 1, dirty: true, all_plate_results_invalidated: true,
        slot: 1, preset: 'p', ...mutation,
      } },
    });
    const assignmentResponse = (fields: Record<string, unknown>, snapshot = validSnapshot) => ({
      ok: true, version: 1, result: { snapshot: toWire(snapshot), history_status: receipt(), mutation: {
        kind: 'assign', history_entry_delta: 1, revision_before: 0, revision_after: 1,
        dirty: true, all_plate_results_invalidated: false, slot: 0,
        accepted_targets: [{ kind: 'object', id: 7, object_id: 7 }], affected_plate_ids: [], ...fields,
      } },
    });
    const missingReceipt = response({});
    delete (missingReceipt.result as Record<string, unknown>).history_status;
    await expect(createClient(async () => createMockModule({ filamentMutation: missingReceipt }))
      .selectFilamentSlotPreset({ version: 1, revision: 0, slot: 1, preset: 'p' }))
      .resolves.toEqual({ ok: false, version: 1, error: 'missing filament mutation history status', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({
      filamentMutation: assignmentResponse({ preset: 'unexpected' }),
    })).assignFilament({ version: 1, revision: 0, slot: 0, targets: [{ kind: 'object', id: 7 }] }))
      .resolves.toEqual({ ok: false, version: 1, error: 'extraneous filament mutation field', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({
      filamentMutation: assignmentResponse({ accepted_targets: [] }),
    })).assignFilament({ version: 1, revision: 0, slot: 0, targets: [{ kind: 'object', id: 7 }] }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament accepted targets', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({
      filamentMutation: assignmentResponse({ all_plate_results_invalidated: true }),
    })).assignFilament({ version: 1, revision: 0, slot: 0, targets: [{ kind: 'object', id: 7 }] }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament invalidation scope', errorCode: 'invalid_response' });
    const routingResponse = (fields: Record<string, unknown>) => ({
      ok: true, version: 1, result: { snapshot: toWire(validSnapshot), history_status: receipt(), mutation: {
        kind: 'routing', history_entry_delta: 1, revision_before: 0, revision_after: 1,
        dirty: true, all_plate_results_invalidated: true, selector: 'support-base', slot: 1,
        accepted_targets: [{ kind: 'project', id: 0, object_id: 0 }], affected_plate_ids: ['plate-1'], ...fields,
      } },
    });
    await expect(createClient(async () => createMockModule({
      filamentMutation: routingResponse({ all_plate_results_invalidated: false }),
    })).setFilamentRouting({ version: 1, revision: 0, selector: 'support-base', slot: 1, targets: [{ kind: 'project' }] }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament invalidation scope', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({
      filamentMutation: routingResponse({ accepted_targets: [{ kind: 'project', id: 2, object_id: 0 }] }),
    })).setFilamentRouting({ version: 1, revision: 0, selector: 'support-base', slot: 1, targets: [{ kind: 'project' }] }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament accepted targets', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({
      filamentMutation: response({ slot_count: 1 }),
    })).selectFilamentSlotPreset({ version: 1, revision: 0, slot: 1, preset: 'p' }))
      .resolves.toEqual({ ok: false, version: 1, error: 'extraneous filament mutation field', errorCode: 'invalid_response' });

    await expect(createClient(async () => createMockModule({
      filamentMutation: response({ revision_after: 2 }),
    })).selectFilamentSlotPreset({ version: 1, revision: 0, slot: 1, preset: 'p' }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament mutation summary', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({
      filamentMutation: response({}, { ...validSnapshot, revisions: { ...validSnapshot.revisions, session: 2 } }),
    })).selectFilamentSlotPreset({ version: 1, revision: 0, slot: 1, preset: 'p' }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament mutation summary', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({
      filamentMutation: response({ dirty: false }),
    })).selectFilamentSlotPreset({ version: 1, revision: 0, slot: 1, preset: 'p' }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament mutation summary', errorCode: 'invalid_response' });

    const twoSlot = { ...base,
      slots: [base.slots[0], { ...base.slots[0], slot: 2 }],
      mappings: { filament: [1, 1], volume: [0, 0], nozzle: [1, 1], filament2: [1, 1], physicalExtruder: [0] },
      flushing: { matrix: [0, 0, 0, 0], matrixDimension: 2, planeCount: 1, vector: [], source: 'native' as const },
      capabilities: { ...base.capabilities, canDelete: true, canMerge: true },
      revisions: { ...base.revisions, session: 1 },
    };
    const oneSlot = { ...twoSlot,
      slots: [twoSlot.slots[0]],
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
      flushing: { ...twoSlot.flushing, matrix: [0], matrixDimension: 1 },
      capabilities: { ...twoSlot.capabilities, canDelete: false, canMerge: false },
    };
    const deleteMutation = (fields: Record<string, unknown>) => ({
      ok: true, version: 1, result: { snapshot: toWire(oneSlot), history_status: receipt(), mutation: {
        kind: 'delete', history_entry_delta: 1, revision_before: 0, revision_after: 1,
        dirty: true, all_plate_results_invalidated: true, source: 2, destination: null,
        slot_count: 1, ...fields,
      } },
    });
    await expect(createClient(async () => createMockModule({ filamentMutation: deleteMutation({ destination: 1 }) }))
      .deleteFilamentSlot({ version: 1, revision: 0, slot: 2 }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament delete destination', errorCode: 'invalid_response' });
    await expect(createClient(async () => createMockModule({ filamentMutation: deleteMutation({ slot_count: 2 }) }))
      .deleteFilamentSlot({ version: 1, revision: 0, slot: 2 }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament mutation slot count', errorCode: 'invalid_response' });

    const mergeResponse = {
      ok: true, version: 1, result: { snapshot: toWire(oneSlot), history_status: receipt(), mutation: {
        kind: 'merge', history_entry_delta: 1, revision_before: 0, revision_after: 1,
        dirty: true, all_plate_results_invalidated: true, source: 2, destination: 2, slot_count: 1,
      } },
    };
    await expect(createClient(async () => createMockModule({ filamentMutation: mergeResponse }))
      .mergeFilamentSlots({ version: 1, revision: 0, source: 2, destination: 1 }))
      .resolves.toEqual({ ok: false, version: 1, error: 'invalid filament merge destination range', errorCode: 'invalid_response' });
  });

  it('remaps middle merge and preserves destination colour in the atomic client contract', async () => {
    const payload = {
      ok: true, version: 1,
      slots: [1, 2, 3].map((slot) => ({ slot, preset: { id: `p${slot}`, name: `p${slot}` }, colour: { effective: `#00000${slot}`, provenance: slot === 2 ? 'user' : 'preset' } })),
      mappings: { filament: [1, 1, 1], volume: [0, 0, 0], nozzle: [1, 1, 1], filament2: [1, 1, 1], physical_extruder: [0] },
      flushing: { matrix: Array(9).fill(0), vector: [], matrix_dimension: 3, plane_count: 1, source: 'native' },
      capabilities: { min_slots: 1, max_slots: 64, nozzle_count: 1, flexible: true, can_add: true, can_delete: true, can_merge: true },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 4, project: 4, result: 0, plates: {} },
      status: { state: 'ready', error: null },
    };
    const c = createClient(async () => createMockModule({ filamentSession: payload }));
    const merged = await c.mergeFilamentSlots({ version: 1, revision: 4, source: 2, destination: 1 });
    expect(merged).toMatchObject({ ok: true, result: { snapshot: { slots: [
      { slot: 1, colour: { effective: '#000001' } }, { slot: 2, colour: { effective: '#000003' } },
    ] } } });
  });

  it('rejects a flush plane count that does not match native nozzle count', async () => {
    const payload = {
      ok: true, version: 1,
      slots: [1, 2].map((slot) => ({ slot, preset: { id: `p${slot}`, name: `p${slot}` }, colour: { effective: '#000000', provenance: 'preset' } })),
      mappings: { filament: [1, 1], volume: [0, 0], nozzle: [1, 1], filament2: [1, 1], physical_extruder: [0] },
      flushing: { matrix: [0, 0, 0, 0, 0, 0, 0, 0], vector: [], matrix_dimension: 2, plane_count: 2, source: 'native' },
      capabilities: { min_slots: 1, max_slots: 64, nozzle_count: 1, flexible: true, can_add: true, can_delete: true, can_merge: true },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 0, project: 0, result: 0, plates: {} },
      status: { state: 'ready', error: null },
    };
    await expect(createClient(async () => createMockModule({ filamentSession: payload })).getFilamentSessionSnapshot())
      .resolves.toEqual({ ok: false, error: 'inconsistent filament session flushing planes' });
  });

  it.each([
    ['reversed', [{ slot: 2 }, { slot: 1 }]],
    ['duplicate', [{ slot: 1 }, { slot: 1 }]],
    ['gap', [{ slot: 1 }, { slot: 3 }]],
  ])('rejects %s native slot ordering without sorting', async (_label, slots) => {
    const payload = {
      ok: true, version: 1, slots: slots.map((entry) => ({ ...entry,
        preset: { id: 'p', name: 'p' }, colour: { effective: '#000000', provenance: 'preset' } })),
      mappings: { filament: [1, 1], volume: [0, 0], nozzle: [1, 1], filament2: [1, 1], physical_extruder: [0] },
      flushing: { matrix: [0, 0, 0, 0], vector: [], matrix_dimension: 2, plane_count: 1, source: 'default' },
      capabilities: { min_slots: 1, max_slots: 64, nozzle_count: 1, flexible: true, can_add: true, can_delete: true, can_merge: true },
      assignments: { objects: [], parts: [], modifiers: [] }, revisions: { session: 0, project: 0, result: 0, plates: {} },
      status: { state: 'ready', error: null },
    };
    await expect(createClient(async () => createMockModule({ filamentSession: payload }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'invalid filament session slot ordering' });
  });

  it('enforces flexible and fixed-device capability semantics', async () => {
    const base = await makeClient().getFilamentSessionSnapshot();
    if (!base.ok) throw new Error(base.error);
    const withSlots = (capabilities: Record<string, unknown>) => ({ ...base,
      slots: [1, 2].map((slot) => ({ slot, preset: { id: `p${slot}`, name: `p${slot}` }, colour: { effective: '#000000', provenance: 'preset' } })),
      mappings: { filament: [1, 1], volume: [0, 0], nozzle: [1, 1], filament2: [1, 1], physical_extruder: (capabilities.nozzle_count === 2 ? [0, 1] : [0]) },
      flushing: { matrix: Array.from({ length: 4 * Number(capabilities.nozzle_count) }, () => 0), vector: [], matrix_dimension: 2,
        plane_count: Number(capabilities.nozzle_count), source: 'default' },
      capabilities,
      assignments: { objects: [], parts: [], modifiers: [] },
      revisions: { session: 0, project: 0, result: 0, plates: {} },
    });
    await expect(createClient(async () => createMockModule({ filamentSession: withSlots({
      min_slots: 1, max_slots: 64, nozzle_count: 1, flexible: true, can_add: true, can_delete: true, can_merge: true,
    }) })).getFilamentSessionSnapshot()).resolves.toMatchObject({ ok: true });
    await expect(createClient(async () => createMockModule({ filamentSession: withSlots({
      min_slots: 2, max_slots: 64, nozzle_count: 2, flexible: false, can_add: false, can_delete: false, can_merge: false,
    }) })).getFilamentSessionSnapshot()).resolves.toMatchObject({ ok: true });
    await expect(createClient(async () => createMockModule({ filamentSession: withSlots({
      min_slots: 2, max_slots: 64, nozzle_count: 2, flexible: false, can_add: true, can_delete: false, can_merge: false,
    }) })).getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'inconsistent filament session capabilities' });
  });

  it('rejects assignment slots outside the ordered slot projection and inconsistent inheritance', async () => {
    const c = makeClient();
    const base = await c.getFilamentSessionSnapshot();
    if (!base.ok) throw new Error(base.error);
    const payload = { ...base,
      mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physical_extruder: [0] },
      flushing: { matrix: [0], vector: [], matrix_dimension: 1, plane_count: 1, source: 'default' },
      capabilities: { min_slots: 1, max_slots: 64, nozzle_count: 1, flexible: true, can_add: true, can_delete: false, can_merge: false },
      revisions: { session: 0, project: 0, result: 0, plates: {} },
      assignments: {
      objects: [{ target: 'object', id: 1, object_id: 1, explicit_slot: 0, effective_slot: 1, inherited: false }],
      parts: [], modifiers: [],
    }};
    await expect(createClient(async () => createMockModule({ filamentSession: payload }))
      .getFilamentSessionSnapshot()).resolves.toEqual({ ok: false, error: 'invalid filament session assignments' });
  });

  it('exposes one deterministic default plate and opaque runtime identity', async () => {
    const c = makeClient();
    const first = await c.getPlateSessionSnapshot();
    expect(first).toMatchObject({ ok: true, version: 1, currentPlateId: expect.any(String) });
    if (!first.ok) throw new Error(first.error);
    expect(first.plates).toEqual([{
      plateId: first.currentPlateId,
      instanceIds: [], outOfBoundsInstanceIds: [], valid: true,
      displayIndex: 0,
      origin: [0, 0, 0],
      name: 'Plate 1',
    }]);
    expect(await c.getPlateSessionSnapshot()).toEqual(first);
    expect(await c.selectPlate(first.currentPlateId)).toEqual({
      ok: true, version: 1, currentPlateId: first.currentPlateId,
    });
    const reset = await c.resetPlateSession();
    expect(reset.ok).toBe(true);
    if (!reset.ok) throw new Error(reset.error);
    expect(reset.currentPlateId).not.toBe(first.currentPlateId);
    expect(await c.selectPlate('malformed-or-stale-id')).toEqual({ ok: false, error: 'plate not found' });
    expect(await c.getPlateSessionSnapshot()).toEqual(reset);
  });

  it('exposes atomic plate mutations and preserves rejection snapshots', async () => {
    const c = makeClient();
    const initial = await c.getPlateSessionSnapshot();
    if (!initial.ok) throw new Error(initial.error);

    const added = await c.addPlate();
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(added.error);
    expect(added.plates).toHaveLength(2);
    expect(added.currentPlateId).toBe(added.plates[1].plateId);
    expect(added.instanceTransforms).toEqual([]);
    expect(added.nativeScopedConfig).toMatchObject({ kind: 'full', revision: expect.any(Number),
      snapshot: { project: {}, objects: {}, parts: {}, plates: {} } });

    const restored = await c.selectPlate(initial.currentPlateId);
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw new Error(restored.error);
    expect(restored.currentPlateId).toBe(initial.currentPlateId);

    const deleted = await c.deletePlate(added.plates[1].plateId);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) throw new Error(deleted.error);
    expect(deleted.plates).toHaveLength(1);
    expect(deleted.currentPlateId).toBe(initial.currentPlateId);
    expect(deleted.instanceTransforms).toEqual([]);
    expect(deleted.nativeScopedConfig).toMatchObject({ kind: 'full', revision: expect.any(Number),
      snapshot: { project: {}, objects: {}, parts: {}, plates: {} } });

    const beforeRejectedDelete = await c.getPlateSessionSnapshot();
    const rejected = await c.deletePlate(initial.currentPlateId);
    expect(rejected).toEqual({ ok: false, error: 'at least one plate must remain' });
    expect(await c.getPlateSessionSnapshot()).toEqual(beforeRejectedDelete);

    const recomputed = await c.recomputePlateMembership();
    expect(recomputed.ok).toBe(true);
    if (!recomputed.ok) throw new Error(recomputed.error);
    expect(recomputed.instanceTransforms).toEqual([]);
  });

  it.each([
    ['malformed opaque metadata', (payload: Record<string, any>) => { payload.plates[0].opaque_metadata = [{ key: 'future-key', value: 42 }]; }],
    ['missing membership', (payload: Record<string, any>) => { delete payload.instances; }],
    ['invalid membership', (payload: Record<string, any>) => { payload.instances = {}; }],
  ] as const)('rejects %s instead of projecting an incomplete plate session', async (_label, corrupt) => {
    const module = createMockModule();
    const originalCall = module.ccall;
    module.ccall = (name, ret, argTypes, args) => {
      const pointer = originalCall(name, ret, argTypes, args);
      if (name !== 'orc_get_plate_session_snapshot') return pointer;
      const payload = JSON.parse(module.UTF8ToString(Number(pointer))) as Record<string, any>;
      module._free(Number(pointer));
      corrupt(payload);
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const replacement = module._malloc(bytes.byteLength + 1);
      module.HEAPU8.set(bytes, replacement);
      module.HEAPU8[replacement + bytes.byteLength] = 0;
      return replacement;
    };
    const c = createClient(async () => module);
    await expect(c.getPlateSessionSnapshot()).resolves.toEqual({
      ok: false,
      error: 'invalid plate session response',
    });
  });

  it('keeps the current plate identity when adding a model', async () => {
    const c = makeClient();
    const before = await c.getPlateSessionSnapshot();
    if (!before.ok) throw new Error(before.error);

    const added = await c.addModel(new Uint8Array([1, 2, 3, 4]), 'stl');
    expect(added.ok).toBe(true);

    const after = await c.getPlateSessionSnapshot();
    if (!after.ok) throw new Error(after.error);
    expect(after.currentPlateId).toBe(before.currentPlateId);
    expect(after.plates[0]?.plateId).toBe(before.plates[0]?.plateId);
  });

  it('returns an all-plate transaction for shared configuration changes', async () => {
    const c = makeClient();
    await c.addPlate();
    const before = await c.getPlateSessionSnapshot();
    if (!before.ok) throw new Error(before.error);
    const changed = await c.markSharedConfigurationMutation();
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error(changed.error);
    expect(changed.dirtyReasons).toEqual(['shared-configuration']);
    expect(changed.affectedPlateIdsBefore).toEqual(before.plates.map((plate) => plate.plateId));
    expect(changed.affectedPlateIdsAfter).toEqual(before.plates.map((plate) => plate.plateId));
    for (const plate of before.plates) {
      expect(changed.inputRevisions?.[plate.plateId]).toBe((before.inputRevisions?.[plate.plateId] ?? 0) + 1);
    }
  });

  it('keeps native scoped configuration values by stable identity', async () => {
    const c = makeClient();
    const initial = await c.getNativeScopedConfig();
    expect(initial).toMatchObject({ ok: true, nativeScopedConfig: { kind: 'full',
      snapshot: { project: {}, objects: {}, parts: {}, plates: {} } } });
    const project = await c.setNativeScopedConfig({ scope: 'project' }, 'layer_height', '0.16');
    expect(project).toMatchObject({ ok: true, nativeScopedConfig: { kind: 'affected',
      replacements: [{ scope: 'project', values: { layer_height: '0.16' } }] } });
    await c.addModel(new Uint8Array([1, 2, 3, 4]), 'stl');
    const structure = await c.getModelStructure();
    const objectId = structure.objects[0]?.id;
    const partId = structure.objects[0]?.volumes[0]?.id;
    if (objectId === undefined || partId === undefined) throw new Error('mock structure missing IDs');
    await expect(c.setNativeScopedConfig({ scope: 'object', id: objectId }, 'wall_loops', '3'))
      .resolves.toMatchObject({ nativeScopedConfig: { kind: 'affected',
        replacements: [{ scope: 'object', id: String(objectId), values: { wall_loops: '3' } }] } });
    await expect(c.setNativeScopedConfig({ scope: 'part', id: partId }, 'enable_support', '1'))
      .resolves.toMatchObject({ nativeScopedConfig: { kind: 'affected',
        replacements: [{ scope: 'part', id: String(partId), values: { enable_support: '1' } }] } });
    const plateSession = await c.getPlateSessionSnapshot();
    if (!plateSession.ok) throw new Error(plateSession.error);
    const plateId = plateSession.currentPlateId;
    const plateRevision = plateSession.inputRevisions?.[plateId] ?? 0;
    await expect(c.setNativeScopedConfig({ scope: 'plate', id: plateId }, 'curr_bed_type', 'Engineering Plate'))
      .resolves.toMatchObject({
        nativeScopedConfig: { kind: 'affected',
          replacements: [{ scope: 'plate', id: plateId, values: { curr_bed_type: 'Engineering Plate' } }] },
        plateSession: { affectedPlateIds: [plateId], inputRevisions: { [plateId]: plateRevision + 1 } },
      });
    const revalidated = await c.revalidateNativeScopedConfig();
    expect(revalidated).toMatchObject({ ok: true, nativeScopedConfig: { kind: 'full',
      snapshot: { project: { layer_height: '0.16' } } } });
  });

  it('sends one typed multi-target reset request through the native command', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array([1, 2, 3, 4]), 'stl');
    const structure = await c.getModelStructure();
    const objectId = structure.objects[0]?.id;
    if (objectId === undefined) throw new Error('mock structure missing object ID');
    await expect(c.mutateNativeScopedConfig({
      version: 1,
      operation: 'set',
      targets: [{ scope: 'project' }, { scope: 'object', id: objectId }],
      key: 'layer_height',
      value: '0.2',
    })).resolves.toMatchObject({ ok: true, nativeScopedConfig: { kind: 'affected' } });
    await expect(c.mutateNativeScopedConfig({
      version: 1,
      operation: 'reset',
      targets: [{ scope: 'project' }, { scope: 'object', id: objectId }],
      key: 'layer_height',
    })).resolves.toMatchObject({ ok: true, nativeScopedConfig: { kind: 'affected' } });
  });

  it('retains deleted-target tombstones in the typed transport', async () => {
    const client = await createClient(async () => createMockModule({ nativeScopedConfigOverride: {
      version: 1, ok: true, native_scoped_config: {
        version: 1, revision: 4, kind: 'full',
        snapshot: { project: {}, objects: {}, parts: {}, plates: {} },
        removed_targets: [{ scope: 'object', id: '42' }],
      },
    } }));
    const result = await client.setNativeScopedConfig({ scope: 'project' }, 'layer_height', '0.2');
    expect(result).toMatchObject({ ok: true, nativeScopedConfig: {
      kind: 'full', revision: 4, removedTargets: [{ scope: 'object', id: '42' }],
    } });
  });

  it('rejects generic prime-tower coordinates and malformed status envelopes', async () => {
    const corrected = await makeClient().setNativeScopedConfig({ scope: 'project' }, 'wipe_tower_x', '1,2,3');
    expect(corrected).toMatchObject({ ok: false, errorCode: 'unsupported_reference' });

    const malformed = await createClient(async () => createMockModule({ nativeScopedConfigOverride: {
      version: 1, ok: true, native_scoped_config: { version: 1, revision: 0, kind: 'affected',
        replacements: [], removed_targets: [] },
      configuration_status: { state: 'ready', corrections: [{ key: 'wipe_tower_x' }], warnings: [], errors: [] },
    } })).setNativeScopedConfig({ scope: 'project' }, 'enable_prime_tower', '1');
    expect(malformed).toEqual({ ok: false, version: 1, error: 'invalid native scoped configuration status' });

    const nativeError = await createClient(async () => createMockModule({ nativeScopedConfigOverride: {
      version: 1, ok: false, error: 'native option rejected', error_code: 'native_validation_failure',
      status: { state: 'error', error: 'native option rejected' },
    } })).setNativeScopedConfig({ scope: 'project' }, 'enable_prime_tower', 'bad');
    expect(nativeError).toEqual({ ok: false, version: 1, error: 'native option rejected', errorCode: 'native_validation_failure',
      status: { state: 'error', error: 'native option rejected' } });
  });

  it('returns printer-bound reflow transforms for every member while preserving empty plates', async () => {
    const c = makeClient();
    const first = await c.getPlateSessionSnapshot();
    if (!first.ok) throw new Error(first.error);
    await c.addShape('Cube', 'Plate one object');
    const second = await c.addPlate();
    if (!second.ok) throw new Error(second.error);
    await c.addShape('Cube', 'Plate two object');
    const third = await c.addPlate();
    if (!third.ok) throw new Error(third.error);
    const selected = await c.selectPlate(second.plates[1].plateId);
    if (!selected.ok) throw new Error(selected.error);

    const changedPrinter = await c.selectProfile('printer', 'Bambu Lab P1S 0.4 nozzle');
    expect(changedPrinter.ok).toBe(true);
    const mutation = await c.markSharedConfigurationMutation();
    expect(mutation.ok).toBe(true);
    if (!mutation.ok) throw new Error(mutation.error);
    expect(mutation.currentPlateId).toBe(second.plates[1].plateId);
    expect(mutation.plates.map((plate) => plate.origin)).toEqual([[0, 0, 0], [307.2, 0, 0], [0, -307.2, 0]]);
    expect(mutation.plates[2].instanceIds).toEqual([]);
    expect(mutation.instanceTransforms).toHaveLength(1);
    expect(mutation.instanceTransforms[0]?.objectIndex).toBe(1);
    expect(mutation.instanceTransforms[0]?.worldTransform.offset).toEqual([307.2, 0, 0]);
    expect(mutation.instances?.map((instance) => instance.plateId)).toEqual([first.currentPlateId, second.plates[1].plateId]);
    expect(mutation.affectedPlateIds).toEqual(mutation.plates.map((plate) => plate.plateId));
  });

  it('refreshes the runtime plate identity when clearing or loading a project', async () => {
    const c = makeClient();
    const initial = await c.getPlateSessionSnapshot();
    if (!initial.ok) throw new Error(initial.error);
    await c.clearModel();
    const afterClear = await c.getPlateSessionSnapshot();
    if (!afterClear.ok) throw new Error(afterClear.error);
    expect(afterClear.currentPlateId).not.toBe(initial.currentPlateId);
    expect(afterClear.plates[0]?.plateId).toBe(afterClear.currentPlateId);
    await c.loadProject(new Uint8Array([1]), 'project', 'legacy.3mf');
    const afterLoad = await c.getPlateSessionSnapshot();
    if (!afterLoad.ok) throw new Error(afterLoad.error);
    expect(afterLoad.currentPlateId).not.toBe(afterClear.currentPlateId);
    expect(afterLoad.plates).toHaveLength(1);
    expect(afterLoad.plates[0]?.plateId).toBe(afterLoad.currentPlateId);
  });

  it('getProfileSnapshot returns the coherent strict-hide picker state', async () => {
    const c = makeClient();
    const snapshot = await c.getProfileSnapshot();
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) throw new Error(snapshot.error);
    expect(snapshot.printers.map((preset) => preset.name)).toEqual([
      'Bambu Lab X1 Carbon 0.4 nozzle',
      'Bambu Lab P1S 0.4 nozzle',
    ]);
    expect(snapshot.prints.map((preset) => preset.name)).toEqual([
      '0.20mm Standard @BBL X1C',
      '0.16mm Optimal @BBL X1C',
    ]);
    expect(snapshot.filamentCatalog.map((preset) => preset.name)).toEqual([
      'Bambu PLA Basic @BBL X1C',
      'Bambu PLA Matte @BBL X1C',
      'Generic PLA @System',
    ]);
    expect(snapshot.filamentCatalog.every((preset) => !Object.hasOwn(preset, 'selected'))).toBe(true);
    expect(snapshot.printer.name).toBe('Bambu Lab X1 Carbon 0.4 nozzle');
    expect(snapshot.print.name).toBe('0.20mm Standard @BBL X1C');
    expect(snapshot.printable_area).toEqual([[0, 0], [220, 0], [220, 220], [0, 220]]);
  });

  it('selectProfile returns the resolved printer-to-process-to-rack snapshot', async () => {
    const c = makeClient();
    const r = await c.selectProfile('printer', 'Bambu Lab P1S 0.4 nozzle');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.printer.name).toBe('Bambu Lab P1S 0.4 nozzle');
    expect(r.print.name).toBe('0.20mm Standard @BBL P1S');
    expect(r.prints.map((preset) => preset.name)).toEqual(['0.20mm Standard @BBL P1S']);
    expect(r.filamentCatalog.map((preset) => preset.name)).toEqual([
      'Bambu PLA Basic @BBL P1S',
      'Generic PLA @System',
    ]);
    expect(r.printable_area).toEqual([[0, 0], [256, 0], [256, 256], [0, 256]]);
  });

  it('selecting a process refreshes the rack filament catalogue and native fallback', async () => {
    const c = makeClient();
    const r = await c.selectProfile('print', '0.16mm Optimal @BBL X1C');
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(r.print.name).toBe('0.16mm Optimal @BBL X1C');
    expect(r.filamentCatalog.map((preset) => preset.name)).toEqual([
      'Bambu PLA Basic @BBL X1C',
      'Bambu PLA Silk @BBL X1C',
      'Generic PLA @System',
    ]);
  });

  it('selectProfile rejects unavailable requests without mutating the snapshot', async () => {
    const c = makeClient();
    const before = await c.getProfileSnapshot();
    const unknown = await c.selectProfile('printer', 'No Such Printer');
    expect(unknown.ok).toBeFalsy();
    if (unknown.ok) throw new Error('expected unknown printer rejection');
    expect(unknown.error).toContain('not found');
    const hidden = await c.selectProfile('printer', 'Afinia H+1(HS)');
    expect(hidden.ok).toBeFalsy();
    if (hidden.ok) throw new Error('expected hidden printer rejection');
    expect(hidden.error).toContain('not visible');
    const incompatible = await c.selectProfile('print', '0.20mm Standard @BBL P1S');
    expect(incompatible.ok).toBeFalsy();
    if (incompatible.ok) throw new Error('expected incompatible process rejection');
    expect(incompatible.error).toContain('incompatible');
    expect(await c.getProfileSnapshot()).toEqual(before);
  });

  it('getOptionMetadata exposes typed keys', async () => {
    const c = makeClient();
    const m = await c.getOptionMetadata();
    expect(m.layer_height?.type).toBe('float');
    expect(m.sparse_infill_pattern?.enum_values).toContain('grid');
  });

  it('addModel stages bytes, preserves the selected basename, and reports objects', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const r = await c.addModel(bytes, 'drc', 'cube_att.drc');
    expect(r.ok).toBe(true);
    expect(r.objects).toBe(1);
    expect(Number.isFinite(r.instances)).toBe(true);
    expect(r.instances).toBe(1);
    expect(r.plateSession?.instances).toHaveLength(1);
    await expect(c.getModelStructure()).resolves.toMatchObject({
      objects: [{ name: 'cube_att.drc' }],
    });
  });

  it('addShape builds every primitive with the engine tessellation', async () => {
    // Vertex counts mirror the libslic3r builders at OrcaSlicer's step
    // angles (the native bridge's orc_add_shape — see bridge-smoke).
    const EXPECTED: Array<[string, number]> = [
      ['Cube', 8], ['Cylinder', 362], ['Sphere', 16022],
      ['Cone', 183], ['Disc', 362], ['Torus', 14400],
    ];
    for (const [type, vertexCount] of EXPECTED) {
      const c = makeClient();
      const added = await c.addShape(type, type);
      expect(added).toMatchObject({ ok: true, objects: 1, instances: 1 });
      expect(Number.isFinite(added.instances)).toBe(true);
      expect(added.plateSession?.instances).toHaveLength(1);
      const s = await c.getModelStructure();
      expect(s.ok).toBe(true);
      expect(s.objects?.[0].name).toBe(type);
      expect(s.objects?.[0].volumes[0].name).toBe(type);
      const m = await c.getModelMesh();
      expect(m.objects?.[0].vertexCount).toBe(vertexCount);
    }
  });

  it('addShape defaults the name to the primitive type', async () => {
    const c = makeClient();
    await c.addShape('Cube');
    const s = await c.getModelStructure();
    expect(s.ok).toBe(true);
    expect(s.objects?.[0].name).toBe('Cube');
  });

  it('addShape rejects an unsupported primitive', async () => {
    const c = makeClient();
    await expect(c.addShape('Dodecahedron')).resolves.toMatchObject({
      error: expect.stringContaining('unsupported primitive type'),
    });
  });

  it('addModel preserves existing objects and clearModel resets the scene', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const added = await c.addModel(new Uint8Array(4), 'stl');
    expect(added).toMatchObject({ ok: true, objects: 2, instances: 2 });
    expect((await c.getModelMesh()).objects).toHaveLength(2);
    expect(await c.clearModel()).toMatchObject({ ok: true });
    expect((await c.getModelMesh()).objects).toEqual([]);
  });

  it('deleteObjects removes whole objects, dedupes, and shifts remaining indices', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    await c.addModel(new Uint8Array(4), 'stl');
    await c.addModel(new Uint8Array(4), 'stl');
    const { objects } = await c.getModelStructure();
    const ids = objects.map((o) => o.id);
    const r = await c.deleteObjects([ids[1], ids[0], ids[1]]);
    expect(r).toMatchObject({ ok: true, objects: 1, deleted: 2 });
    const mesh = await c.getModelMesh();
    expect(mesh.objects.map((o) => o.objectIdx)).toEqual([0]);
  });

  it('deleteObjects rejects empty lists and unknown object IDs', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    expect((await c.deleteObjects([])).error).toContain('no object ids');
    const missing = await c.deleteObjects([5]);
    expect(missing.error).toContain('object not found');
    expect((await c.getModelMesh()).objects).toHaveLength(1);
  });

  it('deleteObjects on the last object leaves an empty mesh', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const { objects } = await c.getModelStructure();
    await c.deleteObjects([objects[0].id]);
    const mesh = await c.getModelMesh();
    expect(mesh.ok).toBe(true);
    expect(mesh.objects).toHaveLength(0);
  });

  it('setInstanceOffset round-trips x/y', async () => {
    const c = makeClient();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await c.addModel(bytes, 'stl');
    const r = await c.setInstanceOffset(0, 0, 10, 20, 0);
    expect(r.ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].offset[0]).toBe(10);
    expect(mesh.objects[0].offset[1]).toBe(20);
  });

  it('round-trips a CompositeID transform pair', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const instance: ModelTransform = { offset: [10, 20, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    const volume: ModelTransform = { offset: [1, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] };
    expect((await c.setModelTransform(0, 0, 0, instance, volume)).ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0]).toMatchObject({ objectIdx: 0, volumeIdx: 0, instanceIdx: 0, instanceTransform: instance, volumeTransform: volume });
  });

  it('getModelMesh extracts vertices and indices, frees the heap', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const mesh = await c.getModelMesh();
    expect(mesh.objects[0].vertexCount).toBe(8);
    expect(mesh.objects[0].indexCount).toBe(36);
    expect(mesh.objects[0].positions.byteLength).toBe(8 * 3 * 4);
    expect(mesh.objects[0].indices.byteLength).toBe(36 * 4);
    expect(mesh.objects[0].indices[0]).toBe(0);
  });

  it('mock fixture keeps instance placement independent while sharing part transforms', async () => {
    const c = createClient(async () => createMockModule({ instanceCount: 2, volumeCount: 2 }));
    await c.addModel(new Uint8Array(4), 'stl');
    const before = await c.getModelMesh();
    expect(before.objects).toHaveLength(4);
    expect(before.objects).toMatchObject([
      { instanceIdx: 0, volumeIdx: 0, offset: [0, 0, 0] },
      { instanceIdx: 1, volumeIdx: 0, offset: [50, 0, 0] },
      { instanceIdx: 0, volumeIdx: 1, offset: [0, 0, 0] },
      { instanceIdx: 1, volumeIdx: 1, offset: [50, 0, 0] },
    ]);

    await c.setInstanceOffset(0, 1, 75, 0, 0);
    const after = await c.getModelMesh();
    expect(after.objects.filter((o) => o.instanceIdx === 0).map((o) => o.offset)).toEqual([[0, 0, 0], [0, 0, 0]]);
    expect(after.objects.filter((o) => o.instanceIdx === 1).map((o) => o.offset)).toEqual([[75, 0, 0], [75, 0, 0]]);

    const volume = { offset: [3, 4, 5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    const instance = { offset: [75, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    expect((await c.setModelTransform(0, 1, 1, instance, volume)).ok).toBe(true);
    const transformed = await c.getModelMesh();
    expect(transformed.objects.filter((o) => o.volumeIdx === 1).map((o) => o.volumeTransform)).toEqual([volume, volume]);
    expect(transformed.objects.find((o) => o.instanceIdx === 0 && o.volumeIdx === 0)?.instanceTransform.offset).toEqual([0, 0, 0]);
    expect(transformed.objects.find((o) => o.instanceIdx === 1 && o.volumeIdx === 1)?.instanceTransform).toEqual(instance);
  });

  it('allows transforming an instance added after model load and keeps it in the mesh', async () => {
    const c = createClient(async () => createMockModule());
    await c.addModel(new Uint8Array(4), 'stl');
    const { objects } = await c.getModelStructure();
    const add = await c.addInstance(objects[0].id);
    expect(add.ok).toBe(true);
    const addedInstance = { offset: [123, 4, 5] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    const addedVolume = { offset: [7, 8, 9] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] };
    expect((await c.setModelTransform(0, 0, 1, addedInstance, addedVolume)).ok).toBe(true);
    const mesh = await c.getModelMesh();
    expect(mesh.objects).toHaveLength(2);
    expect(mesh.objects.find((o) => o.instanceIdx === 1)).toMatchObject({
      offset: [123, 4, 5], instanceTransform: addedInstance, volumeTransform: addedVolume,
    });
  });

  describe('getModelStructure bridge contract', () => {
    it('returns the object/part/instance tree with stable IDs', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2, volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const r = await c.getModelStructure();
      expect(r.ok).toBe(true);
      expect(r.objects).toHaveLength(1);
      const obj = r.objects[0];
      expect(obj).toMatchObject({
        index: 0, name: 'Object 1', printable: true, instanceCount: 2,
      });
      expect(obj.id).toBeGreaterThan(0);
      expect(obj.volumes).toHaveLength(2);
      expect(obj.instances).toHaveLength(2);
      expect(obj.volumes[0]).toMatchObject({
        index: 0, name: 'Part 1', type: 'model_part', isSplittable: true,
      });
      expect(obj.volumes[0].id).toBeGreaterThan(0);
      expect(obj.instances[0]).toMatchObject({ index: 0, printable: true });
      expect(obj.instances[0].id).toBeGreaterThan(0);
    });

    it('returns an empty tree before any model is loaded', async () => {
      const c = makeClient();
      const r = await c.getModelStructure();
      expect(r.ok).toBe(true);
      expect(r.objects).toEqual([]);
    });

    it('keeps stable IDs after deleting an earlier object', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const keptId = before.objects[1].id;
      await c.deleteObjects([before.objects[0].id]);
      const after = await c.getModelStructure();
      expect(after.objects).toHaveLength(1);
      expect(after.objects[0].id).toBe(keptId);
      expect(after.objects[0].index).toBe(0);
    });
  });

  describe('Step 2 metadata mutations (stable ObjectID)', () => {
    it('renameObject renames an object by stable ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const id = objects[0].id;
      expect((await c.renameObject(id, 'Renamed')).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0]).toMatchObject({ id, name: 'Renamed' });
    });

    it('renameVolume renames a specific part by stable ID', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const volume = objects[0].volumes[1];
      expect((await c.renameVolume(volume.id, 'Left wall')).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes[1]).toMatchObject({ id: volume.id, name: 'Left wall' });
    });

    it('setVolumeType changes a non-last-model-part type', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const volume = objects[0].volumes[0];
      expect((await c.setVolumeType(volume.id, 'negative_volume')).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes[0]).toMatchObject({ id: volume.id, type: 'negative_volume' });
      // The other part is untouched.
      expect(after.objects[0].volumes[1].type).toBe('model_part');
    });

    it('setVolumeType rejects changing the last solid part', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const volume = objects[0].volumes[0];
      const res = await c.setVolumeType(volume.id, 'negative_volume');
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('last solid part');
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes[0].type).toBe('model_part');
    });

    it('setVolumeType rejects an unknown type string', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.setVolumeType(objects[0].volumes[0].id, 'not_a_type' as VolumeType);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('invalid volume type');
    });

    it('setObjectPrintable toggles the object gate and every instance', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      expect(objects[0].printable).toBe(true);
      expect((await c.setObjectPrintable(objects[0].id, false)).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].printable).toBe(false);
      expect(after.objects[0].instances.every((i) => i.printable === false)).toBe(true);
    });

    it('setInstancePrintable toggles a single instance only', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [first, second] = objects[0].instances;
      expect((await c.setInstancePrintable(second.id, false)).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].instances[0]).toMatchObject({ id: first.id, printable: true });
      expect(after.objects[0].instances[1]).toMatchObject({ id: second.id, printable: false });
    });

    it('reports not-found for unknown IDs and guards blank names', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const missing = 99999;
      expect((await c.renameObject(missing, 'x')).error).toContain('object not found');
      expect((await c.renameVolume(missing, 'x')).error).toContain('volume not found');
      expect((await c.setInstancePrintable(missing, true)).error).toContain('instance not found');
      expect((await c.renameObject((await c.getModelStructure()).objects[0].id, '')).error).toContain('name is required');
    });

    it('invalidates the slice result after a non-destructive mutation', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const slice = await c.slice({});
      expect((await c.getSliceResult(slice.receipt!)).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.renameObject(objects[0].id, 'Renamed');
      const after = await c.getSliceResult(slice.receipt!);
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('stale or unavailable');
    });
  });

  describe('Step 3 delete, clone, and reorder (stable ObjectID)', () => {
    it('deleteVolumes removes specific parts by ID and leaves the rest', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [v0, v1] = objects[0].volumes;
      const r = await c.deleteVolumes([v1.id]);
      expect(r).toMatchObject({ ok: true, deleted: 1, objects: 1 });
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes).toHaveLength(1);
      expect(after.objects[0].volumes[0].id).toBe(v0.id);
    });

    it('deleteVolumes rejects removing the last solid part', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.deleteVolumes([objects[0].volumes[0].id]);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('last solid part');
      expect((await c.getModelStructure()).objects[0].volumes).toHaveLength(1);
    });

    it('deleteVolumes rejects an unknown volume ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.deleteVolumes([999999]);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('volume not found');
    });

    it('cloneObjects mints fresh stable IDs for the clones', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2, instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const source = before.objects[0];
      const r = await c.cloneObjects([source.id]);
      expect(r.ok).toBe(true);
      expect(r.newObjectIds).toHaveLength(1);
      expect(r.objects).toBe(2);
      expect(r.newObjectIds[0]).not.toBe(source.id);
      const after = await c.getModelStructure();
      expect(after.objects).toHaveLength(2);
      const clone = after.objects[1];
      expect(clone.id).toBe(r.newObjectIds[0]);
      expect(clone.name).toBe(source.name);
      // Clone volumes/instances get fresh IDs too.
      expect(clone.volumes.map((v) => v.id)).not.toContain(source.volumes[0].id);
      expect(clone.instances.map((i) => i.id)).not.toContain(source.instances[0].id);
    });

    it('normalizes native plate-session receipts for structural mutations', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2, instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getPlateSessionSnapshot();
      if (!before.ok) throw new Error(before.error);
      const source = (await c.getModelStructure()).objects[0];
      const cloned = await c.cloneObjects([source.id]);
      expect(cloned).toMatchObject({ ok: true, plateSession: {
        affectedPlateIds: [before.currentPlateId],
        dirtyReasons: ['model-structure'],
      } });
      const afterClone = await c.getPlateSessionSnapshot();
      if (!afterClone.ok) throw new Error(afterClone.error);
      expect(afterClone.inputRevisions?.[before.currentPlateId]).toBeGreaterThan(
        before.inputRevisions?.[before.currentPlateId] ?? -1,
      );
      const reordered = await c.reorderVolumes(source.id, source.volumes[1].id, 0);
      expect(reordered).toMatchObject({ ok: true, plateSession: { dirtyReasons: ['model-structure'] } });
    });

    it('keeps native object and part overrides on cloned stable IDs', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const source = (await c.getModelStructure()).objects[0];
      await c.setNativeScopedConfig({ scope: 'object', id: source.id }, 'wall_loops', '3');
      await c.setNativeScopedConfig({ scope: 'part', id: source.volumes[0].id }, 'enable_support', '1');
      const cloned = await c.cloneObjects([source.id]);
      const cloneId = cloned.newObjectIds[0];
      const snapshot = await c.getNativeScopedConfig();
      expect(snapshot).toMatchObject({ ok: true, nativeScopedConfig: { kind: 'full', snapshot: {
        objects: { [String(cloneId)]: { wall_loops: '3' } },
      } } });
      const after = await c.getModelStructure();
      const clonedPartId = after.objects.find((object) => object.id === cloneId)?.volumes[0]?.id;
      expect(clonedPartId).toBeDefined();
      expect(snapshot).toMatchObject({ nativeScopedConfig: { snapshot: {
        parts: { [String(clonedPartId)]: { enable_support: '1' } },
      } } });
    });

    it('mirrors native split-object config ownership on derived stable IDs', async () => {
      const c = createClient(async () => createMockModule({ splitParts: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const source = (await c.getModelStructure()).objects[0];
      await c.setNativeScopedConfig({ scope: 'object', id: source.id }, 'wall_loops', '3');
      await c.setNativeScopedConfig({ scope: 'part', id: source.volumes[0].id }, 'enable_support', '1');
      const split = await c.splitObjectToObjects(source.id);
      expect(split.ok).toBe(true);
      if (!split.ok) throw new Error(split.error);
      const snapshot = await c.getNativeScopedConfig();
      expect(snapshot).toMatchObject({ ok: true, nativeScopedConfig: { kind: 'full', snapshot: {
        objects: {
          [String(split.newObjectIds[0])]: { wall_loops: '3', enable_support: '1' },
          [String(split.newObjectIds[1])]: { wall_loops: '3', enable_support: '1' },
        },
        parts: {},
      } } });
    });

    it('keeps part config on separated volumes without copying object config', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const source = (await c.getModelStructure()).objects[0];
      await c.setNativeScopedConfig({ scope: 'object', id: source.id }, 'wall_loops', '3');
      await c.setNativeScopedConfig({ scope: 'part', id: source.volumes[0].id }, 'enable_support', '1');
      const separated = await c.separateInstances(source.id, [source.instances[1].id]);
      expect(separated.ok).toBe(true);
      if (!separated.ok) throw new Error(separated.error);
      const structure = await c.getModelStructure();
      const separatedObject = structure.objects.find((object) => object.id === separated.newObjectIds[0]);
      expect(separatedObject).toBeDefined();
      const separatedPartId = separatedObject?.volumes[0]?.id;
      expect(separatedPartId).toBeDefined();
      const snapshot = await c.getNativeScopedConfig();
      expect(snapshot).toMatchObject({ ok: true, nativeScopedConfig: { kind: 'full', snapshot: {
        objects: { [String(source.id)]: { wall_loops: '3' } },
        parts: {
          [String(source.volumes[0].id)]: { enable_support: '1' },
          [String(separatedPartId)]: { enable_support: '1' },
        },
      } } });
      expect(snapshot).not.toMatchObject({ nativeScopedConfig: { snapshot: {
        objects: { [String(separated.newObjectIds[0])]: expect.anything() },
      } } });
    });

    it('reorderObjects moves an object to a destination index', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const [a, b, d] = before.objects;
      const r = await c.reorderObjects(d.id, a.index);
      expect(r.ok).toBe(true);
      expect(r.objects.map((o) => o.index)).toEqual([0, 1, 2]);
      expect(r.objects.map((o) => o.id)).toEqual([d.id, a.id, b.id]);
    });

    it('reorderObjects appends an object when toIndex == object count', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const [a, b, d] = before.objects;
      const r = await c.reorderObjects(a.id, before.objects.length);
      expect(r.ok).toBe(true);
      expect(r.objects.map((o) => o.id)).toEqual([b.id, d.id, a.id]);
    });

    it('reorderVolumes moves a part to a destination index within its object', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [v0, v1, v2] = objects[0].volumes;
      const r = await c.reorderVolumes(objects[0].id, v2.id, v0.index);
      expect(r.ok).toBe(true);
      expect(r.objects[0].volumes.map((v) => v.id)).toEqual([v2.id, v0.id, v1.id]);
    });

    it('reorderVolumes appends a part when toIndex == volume count', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [v0, v1, v2] = objects[0].volumes;
      const r = await c.reorderVolumes(objects[0].id, v0.id, objects[0].volumes.length);
      expect(r.ok).toBe(true);
      expect(r.objects[0].volumes.map((v) => v.id)).toEqual([v1.id, v2.id, v0.id]);
    });

    it('reorder rejects unknown object/volume IDs', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      expect((await c.reorderObjects(999999, 0)).error).toContain('object not found');
      expect((await c.reorderVolumes(objects[0].id, 999999, 0)).error).toContain('volume not found');
    });

    it('deleteObjects invalidates the slice result', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const slice = await c.slice({});
      expect((await c.getSliceResult(slice.receipt!)).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.deleteObjects([objects[0].id]);
      const after = await c.getSliceResult(slice.receipt!);
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('stale or unavailable');
    });
  });

  describe('Step 4a split volume to parts (stable ObjectID)', () => {
    it('splits a splittable volume into fresh-ID parts and clears the old ID', async () => {
      const c = createClient(async () => createMockModule({ splitParts: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const originalId = objects[0].volumes[0].id;
      const r = await c.splitVolumeToParts(originalId);
      expect(r.ok).toBe(true);
      expect(r.parts).toBe(3);
      expect(r.newVolumeIds).toHaveLength(3);
      // The original volume ID is now stale (re-IDed by the split).
      const after = await c.getModelStructure();
      expect(after.objects[0].volumes).toHaveLength(3);
      expect(after.objects[0].volumes.map((v) => v.id)).toEqual(r.newVolumeIds);
      expect(after.objects[0].volumes.map((v) => v.id)).not.toContain(originalId);
      // The returned structure matches the re-read.
      expect(r.objects?.[0].volumes.map((v) => v.id)).toEqual(after.objects[0].volumes.map((v) => v.id));
    });

    it('rejects a non-splittable volume', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      // In the mock only volume index 0 is splittable.
      const volume = objects[0].volumes[1];
      const res = await c.splitVolumeToParts(volume.id);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('not splittable');
    });

    it('rejects an unknown volume ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.splitVolumeToParts(999999);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('volume not found');
    });

    it('invalidates the slice result after a split', async () => {
      const c = createClient(async () => createMockModule());
      await c.addModel(new Uint8Array(4), 'stl');
      const slice = await c.slice({});
      expect((await c.getSliceResult(slice.receipt!)).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.splitVolumeToParts(objects[0].volumes[0].id);
      const after = await c.getSliceResult(slice.receipt!);
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('stale or unavailable');
    });
  });

  describe('Step 4b split object to objects (stable ObjectID)', () => {
    it('mints fresh object IDs for the split objects', async () => {
      const c = createClient(async () => createMockModule({ splitParts: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const originalId = objects[0].id;
      const r = await c.splitObjectToObjects(originalId);
      expect(r.ok).toBe(true);
      expect(r.newObjectIds).toHaveLength(2);
      expect(r.objects).toBe(2);
      const after = await c.getModelStructure();
      expect(after.objects.map((o) => o.id)).toEqual(r.newObjectIds);
      expect(after.objects.map((o) => o.id)).not.toContain(originalId);
    });

    it('rejects an unknown object ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.splitObjectToObjects(999999);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('object not found');
    });

    it('invalidates the slice result after a split', async () => {
      const c = createClient(async () => createMockModule({ splitParts: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const slice = await c.slice({});
      expect((await c.getSliceResult(slice.receipt!)).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.splitObjectToObjects(objects[0].id);
      const after = await c.getSliceResult(slice.receipt!);
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('stale or unavailable');
    });
  });

  describe('Step 4c merge objects to multipart (stable ObjectID)', () => {
    it('assembles objects into one multipart object and removes the sources', async () => {
      const c = createClient(async () => createMockModule({ volumeCount: 2, instanceCount: 1 }));
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const before = await c.getModelStructure();
      const [a, b] = before.objects;
      const r = await c.mergeObjectsToMultipart([a.id, b.id], 'Assembly');
      expect(r.ok).toBe(true);
      expect(r.objectId).toBeGreaterThan(0);
      expect(r.objects).toBe(1);
      const after = await c.getModelStructure();
      expect(after.objects).toHaveLength(1);
      expect(after.objects[0].id).toBe(r.objectId);
      expect(after.objects[0].name).toBe('Assembly');
      // One object per source source volume: 2 + 2.
      expect(after.objects[0].volumes).toHaveLength(4);
      expect(after.objects.map((o) => o.id)).not.toContain(a.id);
      expect(after.objects.map((o) => o.id)).not.toContain(b.id);
    });

    it('rejects an unknown object ID', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const res = await c.mergeObjectsToMultipart([999999], 'X');
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('object not found');
    });

    it('invalidates the slice result after assembly', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      await c.addModel(new Uint8Array(4), 'stl');
      const slice = await c.slice({});
      expect((await c.getSliceResult(slice.receipt!)).ok).toBe(true);
      const { objects } = await c.getModelStructure();
      await c.mergeObjectsToMultipart([objects[0].id, objects[1].id], 'Asm');
      const after = await c.getSliceResult(slice.receipt!);
      expect(after.ok).toBeFalsy();
      expect(after.error).toContain('stale or unavailable');
    });
  });

  describe('Step 4d separate instances into objects (stable ObjectID)', () => {
    it('creates one object per selected instance and drops them from the source', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 3 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const source = objects[0];
      const [i0, i1, i2] = source.instances;
      const r = await c.separateInstances(source.id, [i1.id, i2.id]);
      expect(r.ok).toBe(true);
      expect(r.newObjectIds).toHaveLength(2);
      expect(r.objects).toBe(3); // source (1 instance left) + 2 new
      const after = await c.getModelStructure();
      expect(after.objects.map((o) => o.id)).toEqual(
        expect.arrayContaining([source.id, ...r.newObjectIds]),
      );
      // The source kept only instance 0.
      const kept = after.objects.find((o) => o.id === source.id);
      expect(kept?.instances.map((i) => i.id)).toEqual([i0.id]);
      // Each new object has exactly one instance.
      for (const id of r.newObjectIds) {
        const o = after.objects.find((x) => x.id === id);
        expect(o?.instances).toHaveLength(1);
      }
    });

    it('rejects an unknown instance ID', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.separateInstances(objects[0].id, [999999]);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('instance not found');
    });

    it('rejects an empty instance list', async () => {
      const c = makeClient();
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.separateInstances(objects[0].id, []);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('no instance ids');
    });
  });

  describe('add / remove instance (stable ObjectID)', () => {
    it('addInstance mints a new instance and grows the instance count', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const beforeIds = objects[0].instances.map((i) => i.id);
      const r = await c.addInstance(objects[0].id);
      expect(r.ok).toBe(true);
      expect(r.instanceId).toBeGreaterThan(0);
      const after = await c.getModelStructure();
      expect(after.objects[0].instanceCount).toBe(3);
      expect(after.objects[0].instances.map((i) => i.id)).toEqual([...beforeIds, r.instanceId]);
    });

    it('removeInstance removes a specific instance', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const [first, second] = objects[0].instances;
      expect((await c.removeInstance(objects[0].id, second.id)).ok).toBe(true);
      const after = await c.getModelStructure();
      expect(after.objects[0].instanceCount).toBe(1);
      expect(after.objects[0].instances.map((i) => i.id)).toEqual([first.id]);
    });

    it('removeInstance rejects removing the last instance', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 1 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.removeInstance(objects[0].id, objects[0].instances[0].id);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('last instance');
    });

    it('removeInstance rejects an unknown instance ID', async () => {
      const c = createClient(async () => createMockModule({ instanceCount: 2 }));
      await c.addModel(new Uint8Array(4), 'stl');
      const { objects } = await c.getModelStructure();
      const res = await c.removeInstance(objects[0].id, 999999);
      expect(res.ok).toBeFalsy();
      expect(res.error).toContain('instance not found');
    });
  });

  it('slice fires progress and returns unrecognized_keys', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    const r = await c.slice({ layer_height: '0.2' }, (pct) => events.push(pct));
    expect(r.ok).toBe(true);
    expect(r.unrecognized_keys).toEqual([]);
    expect(events).toContain(0);
    expect(events).toContain(100);
  });

  it('binds local slice and export to the current plate identity and revision', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const session = await c.getPlateSessionSnapshot();
    if (!session.ok) throw new Error(session.error);
    const target = { plateId: session.currentPlateId, inputRevision: session.inputRevisions?.[session.currentPlateId] ?? 0 };
    const sliced = await c.slicePlate(target, {});
    expect(sliced.ok).toBe(true);
    await expect(c.exportGcodePlate(sliced.receipt!)).resolves.toMatchObject({ ok: true });
    const changed = await c.addPlate();
    if (!changed.ok) throw new Error(changed.error);
    await expect(c.exportGcodePlate(sliced.receipt!)).resolves.toMatchObject({ error: 'plate operation target is not the current plate' });
  });

  it('rejects stale current-plate targets before slicing', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const session = await c.getPlateSessionSnapshot();
    if (!session.ok) throw new Error(session.error);
    const target = { plateId: session.currentPlateId, inputRevision: session.inputRevisions?.[session.currentPlateId] ?? 0 };
    const changed = await c.addModel(new Uint8Array(4), 'stl');
    if (!changed.ok) throw new Error(changed.error);
    await expect(c.slicePlate(target, {})).resolves.toMatchObject({ error: 'plate operation target is stale' });
  });

  it('reorders by stable plate identity and advances only origin-changing stamps', async () => {
    const c = makeClient();
    await c.addPlate();
    await c.addPlate();
    const before = await c.getPlateSessionSnapshot();
    if (!before.ok) throw new Error(before.error);
    const [plateA, plateB, plateC] = before.plates.map((plate) => plate.plateId);
    const reordered = await c.reorderPlates([plateC, plateB, plateA]);
    if (!reordered.ok) throw new Error(reordered.error);
    expect(reordered.plates.map((plate) => plate.plateId)).toEqual([plateC, plateB, plateA]);
    expect(reordered.inputRevisions?.[plateA]).toBeGreaterThan(before.inputRevisions?.[plateA] ?? 0);
    expect(reordered.inputRevisions?.[plateC]).toBeGreaterThan(before.inputRevisions?.[plateC] ?? 0);
    expect(reordered.inputRevisions?.[plateB]).toBe(before.inputRevisions?.[plateB]);
  });

  it('threaded client registers the generic notifier while pthread progress retains shared wake', async () => {
    const module = createMockModule({ threaded: true });
    const c = createClient(async () => module);
    await c.init();
    await c.addModel(new Uint8Array(4), 'stl');
    await c.slice({});
    const words = new Int32Array(module.HEAPU8.buffer, 128, 4);
    expect(Atomics.load(words, 0)).toBeGreaterThan(0);
    expect(Atomics.load(words, 0) % 2).toBe(0);
    expect(Atomics.load(words, 1)).toBeGreaterThan(0);
    expect(module._functionRegistrations).toBe(1);
  });

  it('allocates non-reused monotonically increasing slice task ids', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const first = await c.slice({ layer_height: '0.2' });
    const second = await c.slice({ layer_height: '0.3' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(BigInt(second.receipt!.sliceTaskId)).toBeGreaterThan(BigInt(first.receipt!.sliceTaskId));
  });

  it('discards late progress from an earlier threaded slice task', async () => {
    const module = createMockModule({ threaded: true });
    const texts: string[] = [];
    const c = createClient(async () => module, (_percent, text) => texts.push(text));
    await c.init();
    await c.addModel(new Uint8Array(4), 'stl');
    const first = await c.slice({ layer_height: '0.2' });
    texts.length = 0;
    module._publishTaskMessage(first.receipt!.sliceTaskId, {
      type: 'progress', kind: 'slice', plate_id: first.receipt!.plateId,
      entry_incarnation: '1', percent: 99, text: 'late old progress',
    });
    const second = await c.slice({ layer_height: '0.3' });
    expect(second.ok).toBe(true);
    expect(texts).not.toContain('late old progress');
    expect(texts).toContain('slice 100%');
  });

  it('reports only admitted pending slice tasks and clears them after terminal delivery', async () => {
    const module = createMockModule({ threaded: true });
    const originalCall = module.ccall.bind(module);
    let holdMailbox = true;
    module.ccall = ((name, ret, argTypes, args) => {
      if (name === 'orc_history_restore_diagnostics' || (name === 'orc_drain_async_task_mailbox' && holdMailbox)) {
        const bytes = new TextEncoder().encode(name === 'orc_history_restore_diagnostics' ? '{}' : '{"messages":[]}');
        const pointer = Number(module._malloc(bytes.length + 1));
        module.HEAPU8.set(bytes, pointer);
        module.HEAPU8[pointer + bytes.length] = 0;
        return pointer;
      }
      return originalCall(name, ret, argTypes, args);
    }) as typeof module.ccall;
    const c = createClient(async () => module);
    await c.init();
    await c.addModel(new Uint8Array(4), 'stl');
    expect(await c.getNativeHistoryDiagnostics!()).toMatchObject({ pendingSliceTaskCount: 0 });
    const slicing = c.slice({});
    await expect.poll(async () => (await c.getNativeHistoryDiagnostics!()).pendingSliceTaskCount).toBe(1);
    holdMailbox = false;
    expect((await slicing).ok).toBe(true);
    expect(await c.getNativeHistoryDiagnostics!()).toMatchObject({ pendingSliceTaskCount: 0 });
  });

  it('beforeInit runs once across repeated init calls (StrictMode double-mount)', async () => {
    // App.tsx boots from a StrictMode effect in dev, so init() is sent twice.
    // Profile installation must not re-fetch/re-mount on the second call.
    let installRuns = 0;
    const c = createClient(async () => createMockModule(), undefined, async () => { installRuns += 1; });
    await c.init();
    await c.init();
    expect(installRuns).toBe(1);
  });

  it('beforeInit retries a rejected install on the next init', async () => {
    let installRuns = 0;
    const c = createClient(async () => createMockModule(), undefined, async () => {
      installRuns += 1;
      if (installRuns === 1) throw new Error('first install failed');
    });
    await expect(c.init()).rejects.toThrow('first install failed');
    await expect(c.init()).resolves.toMatchObject({ ok: true });
    expect(installRuns).toBe(2);
  });

  it('getSliceResult extracts toolpath buffers with layer ranges', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({}, () => {});
    const r = await c.getSliceResult(slice.receipt!);
    expect(r.layers).toBe(40);
    expect(r.toolpath.segmentCount).toBe(2400);
    expect(r.toolpath.ends.byteLength).toBe(2400 * 3 * 4);
    expect(r.toolpath.features.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a projection payload whose slice task receipt was superseded', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({});
    const stale = await c.getSliceResult({ ...slice.receipt!, sliceTaskId: '999' });
    expect(stale).toMatchObject({ ok: false, status: 'stale' });
    expect(stale.receipt).toEqual(slice.receipt);
  });

  it('decodes continuous v2 segments, indexes, palettes and metadata', async () => {
    const c = createClient(async () => createMockModule({
      sliceFixture: {
        layers: 2, toolpathVertices: 4,
        features: [{ id: 0, role: 0, name: 'Perimeter', color: [255, 0, 0] }, { id: 1, role: 1, name: 'Infill', color: [0, 0, 255] }],
        extruderPalette: [
          { id: 0, name: 'Red PLA', color: [255, 0, 0], tool: 0 },
          { id: 1, name: 'Blue PETG', color: [0, 0, 255], tool: 1 },
        ],
        resultId: 42,
        optionalMetrics: { feedrate: [10, 20, 30, 40], volumetric_flow: [1, 2, 3, 4] },
        analysis: {
          summary: { estimatedTimeSeconds: 12.5, filamentLengthMeters: 1.25, filamentWeightGrams: 3.5, filamentCost: 0.07 },
          featureStatistics: [{ featureId: 0, timeSeconds: 8, filamentLengthMeters: 0.75 }, { featureId: 1, timeSeconds: 4.5, filamentWeightGrams: 1.2 }],
        },
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({});
    const r = await c.getSliceResult(slice.receipt!);
    const t = r.toolpath;
    expect(t.segmentCount).toBe(4);
    expect(t.starts.length).toBe(12);
    expect(t.ends.length).toBe(12);
    for (let i = 1; i < t.segmentCount; i++)
      expect(Array.from(t.starts.slice(i * 3, i * 3 + 3))).toEqual(Array.from(t.ends.slice((i - 1) * 3, i * 3)));
    expect(t.layerIds.length).toBe(4);
    expect(t.moveOrders).toEqual(new Uint32Array([0, 1, 0, 1]));
    expect(t.gcodeIds).toEqual(new Uint32Array([1, 2, 3, 4]));
    expect(t.widths[1]).toBeCloseTo(0.45);
    expect(t.metrics.feedrate).toEqual(new Float32Array([10, 20, 30, 40]));
    expect(t.metrics.actualFeedrate).toBeUndefined();
    expect(r.metadata.resultId).toBe(42);
    expect(r.metadata.sourceText).toEqual({ available: true });
    expect(r.metadata.layerRanges).toHaveLength(2);
    expect(r.metadata.extruderPalette?.[0].tool).toBe(0);
    expect(r.metadata.extruderPalette).toEqual([
      { id: 0, name: 'Red PLA', color: [255, 0, 0], tool: 0 },
      { id: 1, name: 'Blue PETG', color: [0, 0, 255], tool: 1 },
    ]);
    expect(r.metadata.analysis?.summary).toEqual({
      estimatedTimeSeconds: 12.5, filamentLengthMeters: 1.25, filamentWeightGrams: 3.5, filamentCost: 0.07,
    });
    expect(r.metadata.analysis?.featureStatistics).toEqual([
      { featureId: 0, timeSeconds: 8, filamentLengthMeters: 0.75 },
      { featureId: 1, timeSeconds: 4.5, filamentWeightGrams: 1.2 },
    ]);
    expect(r.metadata.analysis?.metricRanges).toEqual({
      feedrate: { min: 10, max: 40 }, volumetricFlow: { min: 1, max: 4 },
    });
  });

  it('preserves every Orca extrusion-role label and color in the client palette', async () => {
    const orcaPalette: MockFeature[] = [
      { id: 0, role: 0, name: 'Undefined', color: [230, 179, 179] },
      { id: 1, role: 1, name: 'Inner wall', color: [255, 230, 77] },
      { id: 2, role: 2, name: 'Outer wall', color: [255, 125, 56] },
      { id: 3, role: 3, name: 'Overhang wall', color: [31, 31, 255] },
      { id: 4, role: 4, name: 'Sparse infill', color: [176, 48, 41] },
      { id: 5, role: 5, name: 'Internal solid infill', color: [150, 84, 204] },
      { id: 6, role: 6, name: 'Top surface', color: [240, 64, 64] },
      { id: 7, role: 7, name: 'Bottom surface', color: [102, 92, 199] },
      { id: 8, role: 8, name: 'Ironing', color: [255, 140, 105] },
      { id: 9, role: 9, name: 'Bridge', color: [77, 128, 186] },
      { id: 10, role: 10, name: 'Internal Bridge', color: [77, 128, 186] },
      { id: 11, role: 11, name: 'Gap infill', color: [255, 255, 255] },
      { id: 12, role: 12, name: 'Skirt', color: [0, 135, 110] },
      { id: 13, role: 13, name: 'Brim', color: [0, 59, 110] },
      { id: 14, role: 14, name: 'Support', color: [0, 255, 0] },
      { id: 15, role: 15, name: 'Support interface', color: [0, 128, 0] },
      { id: 16, role: 16, name: 'Support transition', color: [0, 64, 0] },
      { id: 17, role: 17, name: 'Prime tower', color: [179, 227, 171] },
      { id: 18, role: 18, name: 'Custom', color: [94, 209, 148] },
      { id: 19, role: 19, name: 'Multiple', color: [128, 128, 128] },
    ];
    const c = createClient(async () => createMockModule({
      sliceFixture: { layers: 1, toolpathVertices: 2, features: orcaPalette },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({});
    const r = await c.getSliceResult(slice.receipt!);
    expect(r.metadata.featurePalette).toEqual(orcaPalette);
    expect(r.toolpath.palette).toEqual(orcaPalette);
  });

  it('omits unavailable optional metrics while preserving required arrays', async () => {
    const c = createClient(async () => createMockModule({
      sliceFixture: { layers: 1, toolpathVertices: 2, features: [{ id: 0, role: 0, name: 'Travel', color: [1, 2, 3] }] },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({});
    const r = await c.getSliceResult(slice.receipt!);
    expect(r.toolpath.segmentCount).toBe(2);
    expect(r.toolpath.metrics).toEqual({});
    expect(r.metadata.sourceLineMapping?.available).toBe(true);
  });

  it('exports the addressed completed generation from MEMFS', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const sliced = await c.slice({});
    const first = await c.exportGcodePlate(sliced.receipt!);
    expect(first.ok).toBe(true);
    expect(new TextDecoder().decode(first.bytes.slice(0, 6))).toBe('; mock');
    first.bytes.fill(0);
    const second = await c.exportGcodePlate(sliced.receipt!);
    expect(second.ok).toBe(true);
    expect(new TextDecoder().decode(second.bytes.slice(0, 6))).toBe('; mock');
  });

  it('loads BBS projects with typed compatibility and warning metadata', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const closed: string[] = [];
    const r = await c.loadProject(new Uint8Array([0x50, 0x4b]), 'project', 'saved.3mf', undefined,
      (plateSession) => closed.push(plateSession.currentPlateId));
    expect(r).toMatchObject({
      ok: true, mode: 'project', compatibility: 'bambu',
      projectSettingsAvailable: true, multiPlate: false, plateCount: 1,
    });
    expect(r.embeddedPresetWarnings?.requiresConfirmation).toBe(false);
    expect(closed).toHaveLength(1);
    expect(closed[0]).not.toBe(r.plateSession?.currentPlateId);
  });

  it('preserves independent embedded preset warning evidence', async () => {
    const c = createClient(async () => createMockModule({
      embeddedPresetWarnings: {
        modifiedPrinterGcode: true,
        modifiedFilamentGcode: true,
        missingSystemPreset: true,
        modifiedGcodeKeys: ['machine_start_gcode', 'filament_start_gcode'],
        missingSystemPresetTypes: ['printer', 'filament'],
        presetEvidence: [
          { type: 'printer', name: 'Custom printer', inherits: 'Missing printer', hasMatchingSystemPreset: false, modifiedGcodeKeys: [] },
          { type: 'filament', name: 'Custom filament', inherits: 'System filament', hasMatchingSystemPreset: true, modifiedGcodeKeys: ['filament_start_gcode'] },
        ],
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    const r = await c.loadProject(new Uint8Array([0x50, 0x4b]), 'project');
    expect(r.embeddedPresetWarnings).toMatchObject({
      modifiedPrinterGcode: true, modifiedFilamentGcode: true,
      missingSystemPreset: true,
      modifiedGcodeKeys: ['machine_start_gcode', 'filament_start_gcode'],
      missingSystemPresetTypes: ['printer', 'filament'],
    });
    expect(r.embeddedPresetWarnings?.presetEvidence?.[0]).toMatchObject({
      type: 'printer', hasMatchingSystemPreset: false,
    });
  });

  it('appends geometry-only project imports and exposes an explicit alias', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const imported = await c.importProjectGeometry(new Uint8Array([0x50, 0x4b]), 'part.3mf');
    expect(imported).toMatchObject({ ok: true, mode: 'geometry-only', compatibility: 'bambu' });
    expect(imported.objects).toBe(2);
    const replaced = await c.loadProject(new Uint8Array([0x50, 0x4b]), 'project');
    expect(replaced.objects).toBe(1);
  });

  it('exportProject returns a transferable BBS archive byte buffer', async () => {
    const c = makeClient();
    await c.addModel(new Uint8Array(4), 'stl');
    const r = await c.exportProject();
    expect(r.ok).toBe(true);
    expect(r.bytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(r.bytes)).toContain('bbs-3mf');
  });

  it('exportProject frees the native archive buffer when reading fails', async () => {
    let module: ReturnType<typeof createMockModule> | undefined;
    let archivePtr = 0;
    const c = createClient(async () => {
      module = createMockModule();
      const originalCcall = module.ccall;
      module.ccall = (name, ret, argTypes, args) => {
        const result = originalCcall(name, ret, argTypes, args);
        if (name === 'orc_export_project') {
          archivePtr = Number(JSON.parse(module!.UTF8ToString(Number(result))).bytes_ptr);
        }
        return result;
      };
      return module;
    });
    await c.addModel(new Uint8Array(4), 'stl');
    const heap = module!.HEAPU8;
    const originalSlice = heap.slice;
    Object.defineProperty(heap, 'slice', {
      configurable: true,
      value: () => { throw new Error('simulated archive read failure'); },
    });
    await expect(c.exportProject()).rejects.toThrow('simulated archive read failure');
    Object.defineProperty(heap, 'slice', { configurable: true, value: originalSlice });
    expect(module!._freedPointers).toContain(archivePtr);
  });

  it('reads bounded UTF-8 source chunks by completed result id', async () => {
    const sourceText = '; 注释\nG1 X1\nG1 X2\n';
    const c = createClient(async () => createMockModule({
      sliceFixture: {
        layers: 1, toolpathVertices: 2,
        features: [{ id: 0, role: 0, name: 'Perimeter', color: [255, 0, 0] }],
        resultId: 17, sourceText,
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({});
    const result = await c.getSliceResult(slice.receipt!);
    const encoded = new TextEncoder().encode(sourceText);
    const middle = await c.readTextChunk({ receipt: slice.receipt!, resultId: result.metadata.resultId, offset: 3, length: 5 });
    expect(middle.offset).toBe(2);
    expect(middle.text).toBe('注释');
    expect(middle.eof).toBe(false);
    const tail = await c.readTextChunk({ receipt: slice.receipt!, resultId: result.metadata.resultId, offset: encoded.length - 1, length: 1 });
    expect(tail.text).toBe('\n');
    await expect(c.readTextChunk({ receipt: slice.receipt!, resultId: 16, offset: 0, length: 1 }))
      .resolves.toMatchObject({ ok: false, text: '', eof: true });
    await expect(c.readTextChunk({ receipt: slice.receipt!, resultId: 17, offset: 0, length: 64 * 1024 + 1 })).rejects.toThrow('at most');
  });

  it('bounds both UTF-8 alignment edges for a maximum-size request', async () => {
    const sourceText = `😀${'a'.repeat(65534)}😀tail`;
    const c = createClient(async () => createMockModule({
      sliceFixture: {
        layers: 1, toolpathVertices: 2,
        features: [{ id: 0, role: 0, name: 'Perimeter', color: [255, 0, 0] }],
        resultId: 18, sourceText,
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({});
    const result = await c.getSliceResult(slice.receipt!);
    const chunk = await c.readTextChunk({
      receipt: slice.receipt!,
      resultId: result.metadata.resultId,
      offset: 3,
      length: PREVIEW_TEXT_CHUNK_MAX_BYTES,
    });
    expect(chunk.offset).toBe(0);
    expect(new TextEncoder().encode(chunk.text).byteLength).toBe(PREVIEW_TEXT_CHUNK_MAX_RESPONSE_BYTES);
    expect(chunk.eof).toBe(false);
  });

  it('reads a seekable bounded source-line page without a prefix request', async () => {
    const c = createClient(async () => createMockModule({
      sliceFixture: {
        layers: 1, toolpathVertices: 2,
        features: [{ id: 0, role: 0, name: 'Perimeter', color: [255, 0, 0] }],
        resultId: 19, sourceText: '; header\nG1 X1\nG1 X2\n',
      },
    }));
    await c.addModel(new Uint8Array(4), 'stl');
    const slice = await c.slice({});
    const result = await c.getSliceResult(slice.receipt!);
    const page = await c.readTextLines({ receipt: slice.receipt!, resultId: result.metadata.resultId, startLine: 3, lineCount: 1 });
    expect(page).toMatchObject({ startLine: 3, lineCount: 1, eof: true, text: 'G1 X2\n' });
    await expect(c.readTextLines({ receipt: slice.receipt!, resultId: 19, startLine: 1, lineCount: 129 })).rejects.toThrow('1-128');
  });

  it('cancel is safe', async () => {
    const c = makeClient();
    const r = await c.cancel();
    expect(r.ok).toBe(true);
  });

  it('init forwards globalThis.ORCA_LOG_LEVEL in the options JSON', async () => {
    let initJson = '';
    const c = createClient(async () => {
      const m = await createMockModule();
      const orig = m.ccall.bind(m);
      m.ccall = ((name: string, ret: string, argTypes: string[], args: unknown[]) => {
        if (name === 'orc_init') initJson = String(args[0]);
        return orig(name, ret, argTypes, args);
      }) as typeof m.ccall;
      return m;
    });
    const global = globalThis as { ORCA_LOG_LEVEL?: unknown };
    global.ORCA_LOG_LEVEL = 'debug';
    try {
      const r = await c.init();
      expect(r.ok).toBe(true);
      expect(JSON.parse(initJson)).toEqual({ log_level: 'debug' });
    } finally {
      delete global.ORCA_LOG_LEVEL;
    }
  });

  it('init omits log_level when the global is unset', async () => {
    let initJson = '';
    const c = createClient(async () => {
      const m = await createMockModule();
      const orig = m.ccall.bind(m);
      m.ccall = ((name: string, ret: string, argTypes: string[], args: unknown[]) => {
        if (name === 'orc_init') initJson = String(args[0]);
        return orig(name, ret, argTypes, args);
      }) as typeof m.ccall;
      return m;
    });
    const global = globalThis as { ORCA_LOG_LEVEL?: unknown };
    delete global.ORCA_LOG_LEVEL;
    await c.init();
    // The C++ bridge defaults to info when the key is absent.
    expect(JSON.parse(initJson)).toEqual({});
  });

  it('readLog returns the MEMFS log file', async () => {
    const c = createClient(async () => {
      const m = await createMockModule();
      m.FS.writeFile('/tmp/orca.log', new TextEncoder().encode('[2026-08-21 10:00:00.000000] [info] orc_init: bridge ready\n'));
      return m;
    });
    const r = await c.readLog();
    expect(r.ok).toBe(true);
    expect(r.path).toBe('/tmp/orca.log');
    expect(new TextDecoder().decode(r.bytes)).toContain('[info] orc_init: bridge ready');
  });

  it('readLog reports (not throws) when no log file exists', async () => {
    const c = makeClient();
    const r = await c.readLog();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ENOENT');
    expect(r.bytes.length).toBe(0);
  });
});
