import { describe, expect, it, vi } from 'vitest';
import type { PrimeTowerMoveResultOrError, PrimeTowerProjection } from '@slicer/client';
import { PrimeTowerInteractionController } from './PrimeTowerInteractionController';

const projection: PrimeTowerProjection = {
  ok: true, version: 1, currentPlateId: 'plate-1',
  buildArea: { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: 100 },
  plates: [{
    plateId: 'plate-1', displayIndex: 0, eligible: true, empty: false, forced: false,
    usedSlots: [1, 2], width: 20, depth: 20, height: 10, position: { x: 20, y: 20 },
    rotation: 0, brimMargin: 0, footprint: { minX: 20, maxX: 40, minY: 20, maxY: 40 },
    bands: [{ slot: 1, startDepth: 0, endDepth: 10, colour: '#333333', opacity: 0.66 },
      { slot: 2, startDepth: 10, endDepth: 20, colour: '#ffd700', opacity: 0.66 }],
    buildArea: { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: 100 },
  }, {
    plateId: 'plate-2', displayIndex: 1, eligible: true, empty: false, forced: false,
    usedSlots: [1, 2], width: 20, depth: 20, height: 10, position: { x: 20, y: 20 },
    rotation: 0, brimMargin: 0, footprint: { minX: 20, maxX: 40, minY: 20, maxY: 40 }, bands: [],
    buildArea: { minX: 0, maxX: 100, minY: 0, maxY: 100, maxZ: 100 },
  }],
};

function port(result: PrimeTowerMoveResultOrError = { ok: true, version: 1, result: {
  projection, plateSession: {} as never,
  mutation: { kind: 'move', plateId: 'plate-1', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 2, dirty: true, affectedPlateIds: ['plate-1'] },
} }) {
  return { move: vi.fn(async (_request: unknown) => result), reconcile: vi.fn(async () => undefined), revision: vi.fn((_plateId: string) => 1) };
}

describe('PrimeTowerInteractionController', () => {
  it('keeps movement transient and commits exactly once on pointer-up', async () => {
    const runtime = port();
    const controller = new PrimeTowerInteractionController(runtime);
    controller.setProjection(projection);
    expect(controller.select('plate-2')).toBe(false);
    expect(controller.select('plate-1')).toBe(true);
    expect(controller.beginBody('plate-1', { x: 0, y: 0 })).toBe(true);
    controller.updateBody({ x: 4, y: 3 });
    controller.updateBody({ x: 7, y: 8 });
    expect(runtime.move).not.toHaveBeenCalled();
    controller.endGesture();
    await Promise.resolve();
    expect(runtime.move).toHaveBeenCalledTimes(1);
    expect(runtime.move.mock.calls[0][0]).toMatchObject({ plateId: 'plate-1', x: 27, y: 28 });
  });

  it('cancels without writing and clears selection when the target disappears', () => {
    const runtime = port();
    const controller = new PrimeTowerInteractionController(runtime);
    controller.setProjection(projection);
    controller.select('plate-1');
    controller.beginBody('plate-1', { x: 0, y: 0 });
    controller.updateBody({ x: 6, y: 2 });
    controller.cancelGesture();
    expect(runtime.move).not.toHaveBeenCalled();
    expect(controller.transientPosition).toEqual({ x: 20, y: 20 });
    controller.setProjection({ ...projection, currentPlateId: 'plate-2' });
    expect(controller.selectedPlateId).toBeNull();
  });

  it('reconciles a failed or stale native command', async () => {
    const runtime = port({ ok: false, version: 1, error: 'stale', errorCode: 'stale_revision' });
    const controller = new PrimeTowerInteractionController(runtime);
    controller.setProjection(projection);
    controller.select('plate-1');
    controller.beginBody('plate-1', { x: 0, y: 0 });
    controller.updateBody({ x: 2, y: 0 });
    controller.endGesture();
    await Promise.resolve();
    expect(runtime.move).toHaveBeenCalledTimes(1);
    expect(runtime.reconcile).toHaveBeenCalledTimes(1);
  });

  it('rejects a second gesture while the native move is still settling', async () => {
    let release!: (value: PrimeTowerMoveResultOrError) => void;
    const runtime = port();
    runtime.move.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const controller = new PrimeTowerInteractionController(runtime);
    controller.setProjection(projection);
    controller.beginBody('plate-1', { x: 0, y: 0 });
    controller.updateBody({ x: 1, y: 0 });
    controller.endGesture();
    await Promise.resolve();
    const transientBeforeRejectedGizmo = controller.transientPosition;
    expect(controller.beginGizmo('plate-1')).toBe(false);
    expect(controller.transientPosition).toEqual(transientBeforeRejectedGizmo);
    expect(controller.owner).toBe('none');
    release({ ok: true, version: 1, result: {
      projection, plateSession: {} as never,
      mutation: { kind: 'move', plateId: 'plate-1', historyEntryDelta: 1, revisionBefore: 1, revisionAfter: 2, dirty: true, affectedPlateIds: ['plate-1'] },
    } });
    await Promise.resolve();
    expect(runtime.move).toHaveBeenCalledTimes(1);
  });
});
