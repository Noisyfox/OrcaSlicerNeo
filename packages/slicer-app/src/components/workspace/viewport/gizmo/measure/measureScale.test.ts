import { describe, expect, it, vi } from 'vitest';
import type { MeasureApi, MeasureStatus, ModelObjectBuffer } from '@slicer/client';
import { GLVolume } from '../../GLVolume';
import { SceneInteractionController } from '../../SceneInteractionController';
import { MeasureController } from './MeasureController';
import { applyMeasureScale } from './measureScale';

const target = { objectId: 1, instanceId: 2, volumeId: 3 };
const point = { type: 'point' as const, point: [0, 0, 0] as const };
const item = { target, kind: 'pointOnFeature' as const, source: point, value: point };
const original = 12.34567;
function status(id = 'ms-1'): MeasureStatus {
  return { ok: true, version: 1, sessionId: id, targetRevision: 1, selectionRevision: 1,
    first: item, second: item, sameTarget: true, result: {
      angle: null, infinite: null, strict: { value: original, from: [0, 0, 0], to: [original, 0, 0] },
      xyz: [original, 0, 0], showStrict: true, showXyz: true,
    } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function tick() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture() {
  const transform = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] } as const;
  const buffer: ModelObjectBuffer = { ...target, objectIdx: 0, instanceIdx: 0, volumeIdx: 0,
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]), indexCount: 3, offset: [0, 0, 0],
    instanceTransform: { offset: [...transform.offset], rotation: [...transform.rotation], scale: [...transform.scale], mirror: [...transform.mirror] },
    volumeTransform: { offset: [...transform.offset], rotation: [...transform.rotation], scale: [...transform.scale], mirror: [...transform.mirror] } };
  const volume = new GLVolume(buffer, { kind: 'exclusive' });
  const scene = new SceneInteractionController(() => [volume]); scene.selectVolumeIds([volume.id]); scene.toggleGizmo('measure');
  const api = {
    openMeasureSession: vi.fn<MeasureApi['openMeasureSession']>(async () => status()),
    rebaseMeasure: vi.fn<MeasureApi['rebaseMeasure']>(async request => ({ ...status(request.sessionId), targetRevision: 2 })),
    clickMeasure: vi.fn<MeasureApi['clickMeasure']>(async request => ({ ...status(request.sessionId), selectionRevision: 2, outcome: 'selected' })),
    getMeasureDisplay: vi.fn<MeasureApi['getMeasureDisplay']>(async request => ({ ...status(request.sessionId), selectionRevision: 2,
      displayId: 'md-1', hover: null, markers: [] })),
    closeMeasureSession: vi.fn<MeasureApi['closeMeasureSession']>(async request => ({ ok: true, version: 1, sessionId: request.sessionId })),
    releaseMeasureDisplay: vi.fn<MeasureApi['releaseMeasureDisplay']>(async () => {}),
  };
  const measure = new MeasureController({ api: api as unknown as MeasureApi, coordinate: async operation => operation(),
    canMeasure: () => true, admissionKey: () => 'threaded', invalidate: () => {} });
  const port = { begin: vi.fn(() => true), commit: vi.fn(async () => ({ outcome: 'committed' })),
    abort: vi.fn(async () => ({ outcome: 'cancelled' })) };
  scene.setTransformHistoryPort(port);
  const request = { sessionId: 'ms-1', targetRevision: 1, selectionRevision: 1, value: original };
  return { scene, measure, volume, api, port, request };
}

describe('Measure edit to scale', () => {
  it('uses the unrounded original ratio, freezes input, and rebases only after commit', async () => {
    const { scene, measure, volume, api, port, request } = fixture(); await measure.open([target]);
    const pending = deferred<{ outcome: string }>(); port.commit.mockReturnValueOnce(pending.promise);
    const edit = applyMeasureScale(scene, measure, request, 20, true); await tick();
    expect(measure.getSnapshot().phase).toBe('rebasing');
    expect(volume.instanceTransform.scale[0]).toBeCloseTo(20 / original, 12);
    expect(api.rebaseMeasure).not.toHaveBeenCalled();
    pending.resolve({ outcome: 'committed' });
    expect(await edit).toEqual({ outcome: 'committed' });
    expect(measure.getSnapshot()).toMatchObject({ phase: 'idle', status: { targetRevision: 2, first: item, second: item } });
    expect(api.rebaseMeasure).toHaveBeenCalledOnce(); expect(port.commit).toHaveBeenCalledOnce();
  });

  it('closes unchanged, zero and negative edits without a history transaction', async () => {
    const { scene, measure, port, request } = fixture(); await measure.open([target]);
    expect(await applyMeasureScale(scene, measure, request, 12.346, false)).toEqual({ outcome: 'unchanged' });
    expect(await applyMeasureScale(scene, measure, request, original, true)).toEqual({ outcome: 'unchanged' });
    expect(await applyMeasureScale(scene, measure, request, 0, true)).toEqual({ outcome: 'unchanged' });
    expect(await applyMeasureScale(scene, measure, request, -1, true)).toEqual({ outcome: 'unchanged' });
    expect(port.begin).not.toHaveBeenCalled();
  });

  it('uses the existing scale floor instead of rejecting a small positive request', async () => {
    const { scene, measure, volume, api, request } = fixture(); await measure.open([target]);
    const actual = original * .001;
    api.rebaseMeasure.mockResolvedValueOnce({ ...status(), targetRevision: 2,
      result: { ...status().result!, strict: { value: actual, from: [0, 0, 0], to: [actual, 0, 0] } } });
    expect(await applyMeasureScale(scene, measure, request, 1e-8, true)).toEqual({ outcome: 'committed' });
    expect(volume.instanceTransform.scale).toEqual([.001, .001, .001]);
    expect(measure.getSnapshot().status?.result?.strict?.value).toBe(actual);
  });

  it('rejects a cross-volume or obsolete result before starting a scale', async () => {
    const { scene, measure, api, port, request } = fixture();
    api.openMeasureSession.mockResolvedValueOnce({ ...status(), sameTarget: false }); await measure.open([target]);
    expect(await applyMeasureScale(scene, measure, request, 20, true)).toEqual({ outcome: 'stale' });
    expect(port.begin).not.toHaveBeenCalled();
  });

  it('waits for an admitted click and rejects a dimension it changed', async () => {
    const { scene, measure, api, port, request } = fixture(); await measure.open([target]);
    const pending = deferred<Awaited<ReturnType<MeasureApi['clickMeasure']>>>();
    api.clickMeasure.mockReturnValueOnce(pending.promise);
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(measure.click({ pointer: [20, 20], viewport: [0, 0, 100, 100], projection: matrix, view: matrix })).toBe(true);
    await tick(); const edit = applyMeasureScale(scene, measure, request, 20, true); await tick();
    expect(port.begin).not.toHaveBeenCalled();
    pending.resolve({ ...status(), selectionRevision: 2, outcome: 'selected' });
    expect(await edit).toEqual({ outcome: 'stale' }); expect(port.begin).not.toHaveBeenCalled();
    await measure.settled();
  });

  it('does not rebase a successor session after a target change during commit', async () => {
    const { scene, measure, api, port, request } = fixture(); await measure.open([target]);
    const pending = deferred<{ outcome: string }>(); port.commit.mockReturnValueOnce(pending.promise);
    const edit = applyMeasureScale(scene, measure, request, 20, true); await tick();
    api.openMeasureSession.mockResolvedValueOnce(status('ms-2'));
    await measure.open([{ objectId: 4, instanceId: 5, volumeId: 6 }]);
    pending.resolve({ outcome: 'committed' });
    expect(await edit).toEqual({ outcome: 'stale' });
    expect(api.rebaseMeasure).not.toHaveBeenCalled();
    expect(measure.getSnapshot().status?.sessionId).toBe('ms-2');
  });
});
