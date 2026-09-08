import { describe, expect, it, vi } from 'vitest';
import { useFilamentSessionStore } from './useFilamentSessionStore';
import type { FilamentSessionSnapshot, SlicerClient } from '@slicer/client';

function snapshot(revision: number): FilamentSessionSnapshot {
  return {
    ok: true, version: 1, slots: [{ slot: 1, preset: { id: 'a', name: `PLA ${revision}` }, colour: { effective: '#112233', provenance: 'preset' } }],
    mappings: { filament: [1], volume: [0], nozzle: [1], filament2: [1], physicalExtruder: [0] },
    flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
    capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
    assignments: { objects: [], parts: [], modifiers: [] },
    revisions: { session: revision, project: revision, result: 0, plates: {} }, status: { state: 'ready', error: null },
  };
}

describe('filament session store lifecycle', () => {
  it('publishes only a current complete Worker snapshot', async () => {
    const initial = snapshot(1); const newer = snapshot(2);
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => newer) } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    await useFilamentSessionStore.getState().refresh(runtime, () => false);
    expect(useFilamentSessionStore.getState().snapshot).toBe(initial);
    await useFilamentSessionStore.getState().refresh(runtime, () => true);
    expect(useFilamentSessionStore.getState().snapshot).toBe(newer);
  });

  it('replaces the mirror only from a successful returned mutation', async () => {
    const initial = snapshot(1); const newer = snapshot(3);
    const runtime = {} as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });
    await useFilamentSessionStore.getState().run(runtime, async () => ({ ok: false, version: 1, error: 'rejected', errorCode: 'native_validation_failure' }));
    expect(useFilamentSessionStore.getState().snapshot).toBe(initial);
    await useFilamentSessionStore.getState().run(runtime, async () => ({ ok: true, version: 1, result: {
      snapshot: newer,
      mutation: { kind: 'add', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 3, dirty: true, allPlateResultsInvalidated: true },
    } }));
    expect(useFilamentSessionStore.getState().snapshot).toBe(newer);
  });

  it('clears an external snapshot and records thrown refresh failures without rejecting', async () => {
    const initial = snapshot(7);
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => { throw new Error('worker unavailable'); }) } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });

    const result = await useFilamentSessionStore.getState().refresh(runtime);

    expect(result).toMatchObject({ ok: false, error: 'worker unavailable', errorCode: 'runtime_failure' });
    expect(useFilamentSessionStore.getState().snapshot).toBeNull();
    expect(useFilamentSessionStore.getState().rejected).toBe('worker unavailable');
  });

  it('clears an external snapshot when the Worker returns a rejected refresh envelope', async () => {
    const initial = snapshot(8);
    const runtime = { getFilamentSessionSnapshot: vi.fn(async () => ({ ok: false, version: 1, error: 'replacement unavailable', errorCode: 'runtime_unavailable' })) } as unknown as SlicerClient;
    useFilamentSessionStore.setState({ snapshot: initial, rejected: null });

    const result = await useFilamentSessionStore.getState().refresh(runtime);

    expect(result.ok).toBe(false);
    expect(useFilamentSessionStore.getState().snapshot).toBeNull();
    expect(useFilamentSessionStore.getState().rejected).toBe('replacement unavailable');
  });
});
