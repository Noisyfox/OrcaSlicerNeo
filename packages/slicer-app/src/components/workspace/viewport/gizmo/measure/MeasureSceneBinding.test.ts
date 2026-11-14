import { describe, expect, it, vi } from 'vitest';
import type { MeasureApi, MeasureStatus, ModelObjectBuffer } from '@slicer/client';
import { GLVolume } from '../../GLVolume';
import { SceneInteractionController } from '../../SceneInteractionController';
import { MeasureController } from './MeasureController';
import { MeasureSceneBinding } from './MeasureSceneBinding';

function volume(index: number): GLVolume {
  const transform = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] } as const;
  const buffer: ModelObjectBuffer = {
    objectId: 1 + index, volumeId: 10 + index, instanceId: 20 + index,
    objectIdx: index, volumeIdx: 0, instanceIdx: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]), indexCount: 3, offset: [0, 0, 0],
    instanceTransform: { offset: [...transform.offset], rotation: [...transform.rotation], scale: [...transform.scale], mirror: [...transform.mirror] },
    volumeTransform: { offset: [...transform.offset], rotation: [...transform.rotation], scale: [...transform.scale], mirror: [...transform.mirror] },
  };
  return new GLVolume(buffer, { kind: 'exclusive' });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function status(id: string): MeasureStatus {
  return { ok: true, version: 1, sessionId: id, targetRevision: 1, selectionRevision: 1,
    first: null, second: null, sameTarget: false, result: null };
}
async function tick() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

function fixture() {
  let count = 0, suspended = false, allowed = true;
  const volumes = [volume(0), volume(1)];
  const scene = new SceneInteractionController(() => volumes);
  const api = {
    openMeasureSession: vi.fn<MeasureApi['openMeasureSession']>(async () => status(`ms-${++count}`)),
    closeMeasureSession: vi.fn<MeasureApi['closeMeasureSession']>(async request => ({ ok: true, version: 1, sessionId: request.sessionId })),
    resetMeasure: vi.fn<MeasureApi['resetMeasure']>(async request => ({ ...status(request.sessionId), outcome: 'close' })),
    rebaseMeasure: vi.fn<MeasureApi['rebaseMeasure']>(async request => ({ ...status(request.sessionId), targetRevision: 2 })),
  };
  const measure = new MeasureController({ api: api as unknown as MeasureApi, coordinate: async operation => operation(),
    canMeasure: () => allowed, admissionKey: () => 'serial:0', invalidate: () => {} });
  const binding = new MeasureSceneBinding(scene, measure, () => suspended);
  return { scene, measure, binding, api, volumes, suspend: (value: boolean) => { suspended = value; },
    allow: (value: boolean) => { allowed = value; } };
}

describe('Measure scene binding', () => {
  it('opens from selection, retargets without retaining features, and releases on tool switch', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure');
    await measure.settled();
    expect(api.openMeasureSession).toHaveBeenCalledWith({ version: 1, targets: [
      { objectId: 1, instanceId: 20, volumeId: 10 },
    ] });
    scene.selectVolumeIds([volumes[1].id]);
    expect(measure.getSnapshot().phase).toBe('opening');
    await measure.settled();
    expect(measure.getSnapshot()).toMatchObject({ phase: 'idle', targets: [{ objectId: 2, instanceId: 21, volumeId: 11 }],
      status: { sessionId: 'ms-2', first: null, second: null } });
    expect(api.closeMeasureSession).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1' });
    scene.toggleGizmo('move'); await measure.settled();
    expect(measure.active).toBe(false);
    expect(api.closeMeasureSession).toHaveBeenLastCalledWith({ version: 1, sessionId: 'ms-2' });
    binding.dispose();
  });

  it('closes immediately during a pending open and releases the late native session', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    const pending = deferred<MeasureStatus>(); api.openMeasureSession.mockReturnValueOnce(pending.promise);
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await tick();
    const closed = binding.close();
    expect(scene.gizmo).toBeNull(); expect(measure.active).toBe(false);
    pending.resolve(status('ms-late')); await closed;
    expect(api.closeMeasureSession).toHaveBeenCalledExactlyOnceWith({ version: 1, sessionId: 'ms-late' });
    binding.dispose();
  });

  it('ignores intermediate history projections and reopens only after a successful restore', async () => {
    const { scene, measure, binding, api, volumes, suspend } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    suspend(true); scene.selectVolumeIds([volumes[1].id]);
    expect(api.openMeasureSession).toHaveBeenCalledTimes(1);
    suspend(false); await binding.historyRestored();
    expect(api.openMeasureSession).toHaveBeenCalledTimes(2);
    expect(measure.getSnapshot()).toMatchObject({ phase: 'idle', targets: [{ objectId: 2, instanceId: 21, volumeId: 11 }],
      status: { first: null, second: null } });
    await binding.historyRestored();
    expect(api.openMeasureSession).toHaveBeenCalledTimes(3);
    await binding.close(); binding.dispose();
  });

  it('closes the scene when a native Escape ends the session or admission is rejected', async () => {
    const { scene, measure, binding, api, volumes, allow } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    expect(measure.reset('escape')).toBe(true); await measure.settled();
    expect(scene.gizmo).toBeNull();
    allow(false); scene.toggleGizmo('measure'); await tick();
    expect(scene.gizmo).toBeNull(); expect(api.openMeasureSession).toHaveBeenCalledTimes(1);
    binding.dispose();
  });

  it('does not leave an old session attached to a retarget rejected during serial slicing', async () => {
    const { scene, measure, binding, api, volumes, allow } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    allow(false); scene.selectVolumeIds([volumes[1].id]); await tick(); await measure.settled();
    expect(scene.gizmo).toBeNull(); expect(measure.active).toBe(false);
    expect(api.openMeasureSession).toHaveBeenCalledTimes(1);
    expect(api.closeMeasureSession).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1' });
    binding.dispose();
  });

  it('reopens only when a measured source geometry or transform changes', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    volumes[1].instanceTransform = { ...volumes[1].instanceTransform, offset: [9, 0, 0] };
    scene.notifyTransformsChanged(); await tick();
    expect(api.openMeasureSession).toHaveBeenCalledTimes(1);
    volumes[0].instanceTransform = { ...volumes[0].instanceTransform, offset: [3, 0, 0] };
    scene.notifyTransformsChanged(); await measure.settled();
    expect(api.openMeasureSession).toHaveBeenCalledTimes(2);
    expect(measure.getSnapshot().status).toMatchObject({ sessionId: 'ms-2', first: null, second: null });
    const previous = volumes[0]; volumes[0] = volume(0);
    scene.pruneSelection(); await measure.settled();
    expect(api.openMeasureSession).toHaveBeenCalledTimes(3);
    previous.dispose(); await binding.close(); binding.dispose();
  });

  it('follows the retained selection after a model change and closes when it becomes empty', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    scene.selectVolumeIds(volumes.map(volume => volume.id)); scene.toggleGizmo('measure'); await measure.settled();
    const removed = volumes.pop()!;
    scene.pruneSelection(); await measure.settled();
    expect(scene.gizmo).toBe('measure');
    expect(measure.getSnapshot()).toMatchObject({ phase: 'idle', targets: [{ objectId: 1, instanceId: 20, volumeId: 10 }],
      status: { sessionId: 'ms-2', first: null, second: null } });
    expect(api.closeMeasureSession).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1' });
    const retained = volumes.pop()!; scene.pruneSelection(); await measure.settled();
    expect(scene.gizmo).toBeNull(); expect(measure.active).toBe(false);
    expect(api.closeMeasureSession).toHaveBeenLastCalledWith({ version: 1, sessionId: 'ms-2' });
    removed.dispose(); retained.dispose(); binding.dispose();
  });

  it('retains the session during a scale rebase even when its target transform changes', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    const token = measure.beginScale(measure.getSnapshot().status!);
    expect(token).not.toBeNull();
    volumes[0].instanceTransform = { ...volumes[0].instanceTransform, scale: [2, 2, 2] };
    scene.notifyTransformsChanged();
    expect(await measure.finishScale(token!, true)).toBe(true);
    scene.notifyTransformsChanged(); await tick();
    expect(api.openMeasureSession).toHaveBeenCalledOnce();
    expect(api.rebaseMeasure).toHaveBeenCalledOnce();
    expect(measure.getSnapshot().status?.sessionId).toBe('ms-1');
    await binding.close(); binding.dispose();
  });
});
