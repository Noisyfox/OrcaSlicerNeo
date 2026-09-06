import { describe, expect, it, beforeEach } from 'vitest';
import type { ClientSliceResult, PlateSessionMutation } from '@slicer/client';
import { useSlicerStore } from './useSlicerStore';
import { applyPlateResultMutation } from './plateResultLifecycle';

function result(layers = 1): ClientSliceResult {
  return { ok: true, objects: 1, layers, metadata: { resultId: layers, layerRanges: [], featurePalette: [] }, toolpath: {
    vertexCount: 0, positions: new Float32Array(), layers: new Uint32Array(), features: new Uint32Array(), palette: [],
    segmentCount: 0, starts: new Float32Array(), ends: new Float32Array(), layerIds: new Uint32Array(),
    moveOrders: new Uint32Array(), gcodeIds: new Uint32Array(), moveTypes: new Uint8Array(),
    extrusionRoles: new Uint16Array(), extruderIds: new Uint8Array(), colorPrintIds: new Uint8Array(),
    widths: new Float32Array(), heights: new Float32Array(), metrics: {},
  } };
}

const plate = (plateId: string, revision: number) => ({ plateId, inputRevision: revision });

describe('per-plate result lifecycle', () => {
  beforeEach(() => useSlicerStore.getState().invalidateSliceResult());

  it('restores an unchanged result and rejects a stale revision', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(plate('a', 2), result(2));
    expect(store.activatePlateResult('a', 2)).toBe(true);
    expect(useSlicerStore.getState().status).toBe('done');
    expect(store.activatePlateResult('a', 3)).toBe(false);
    expect(useSlicerStore.getState().status).toBe('idle');
  });

  it('invalidates only affected results', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(plate('a', 1), result());
    store.setPlateResult(plate('b', 1), result());
    store.invalidatePlateResults(['a']);
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['b']);
    expect(store.activatePlateResult('b', 1)).toBe(true);
  });

  it('preserves surviving results across reflow and drops deleted identities', () => {
    const store = useSlicerStore.getState();
    store.setPlateResult(plate('a', 1), result());
    store.setPlateResult(plate('b', 1), result());
    const previous = { ok: true, version: 1, currentPlateId: 'a', plates: [{ plateId: 'a' }, { plateId: 'b' }] } as unknown as PlateSessionMutation;
    const mutation = { ok: true, version: 1, currentPlateId: 'b', plates: [{ plateId: 'b' }], dirtyReasons: ['plate-structure'], inputRevisions: { b: 1 }, instanceTransforms: [] } as unknown as PlateSessionMutation;
    applyPlateResultMutation(mutation, previous);
    expect(Object.keys(useSlicerStore.getState().plateResults)).toEqual(['b']);
    expect(useSlicerStore.getState().status).toBe('done');
  });
});
