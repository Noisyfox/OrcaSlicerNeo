import { describe, expect, it, vi } from 'vitest';
import type { MeasureApi, MeasureStatus, ModelObjectBuffer } from '@slicer/client';
import { GLVolume } from '../../GLVolume';
import { SceneInteractionController } from '../../SceneInteractionController';
import { MeasureController } from './MeasureController';
import { MeasureSceneBinding } from './MeasureSceneBinding';

function volume(index: number, objectIndex = index): GLVolume {
  const transform = { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] } as const;
  const buffer: ModelObjectBuffer = {
    objectId: 1 + objectIndex, volumeId: 10 + index, instanceId: 20 + objectIndex,
    objectIdx: objectIndex, volumeIdx: index === objectIndex ? 0 : 1, instanceIdx: 0,
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

function fixture(beforeBinding?: (scene: SceneInteractionController, volumes: GLVolume[]) => void) {
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
  beforeBinding?.(scene, volumes);
  const binding = new MeasureSceneBinding(scene, measure, () => suspended);
  return { scene, measure, binding, api, volumes, suspend: (value: boolean) => { suspended = value; },
    allow: (value: boolean) => { allowed = value; } };
}

describe('Measure scene binding', () => {
  it('opens from selection, retargets without retaining features, and releases on tool switch', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure');
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 1, instanceId: 20, volumeId: 10 },
    ] });
    await measure.settled();
    expect(api.openMeasureSession).toHaveBeenCalledWith({ version: 1, targets: [
      { objectId: 1, instanceId: 20, volumeId: 10 },
    ] });
    scene.selectVolumeIds([volumes[1].id]);
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 2, instanceId: 21, volumeId: 11 },
    ] });
    expect(measure.getSnapshot().phase).toBe('opening');
    await measure.settled();
    expect(measure.getSnapshot()).toMatchObject({ phase: 'idle', targets: [{ objectId: 2, instanceId: 21, volumeId: 11 }],
      status: { sessionId: 'ms-2', first: null, second: null } });
    expect(api.closeMeasureSession).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1' });
    scene.toggleGizmo('move');
    expect(scene.instanceHider.getSnapshot()).toBeNull();
    await measure.settled();
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
    expect(scene.instanceHider.getSnapshot()).toBeNull();
    pending.resolve(status('ms-late')); await closed;
    expect(api.closeMeasureSession).toHaveBeenCalledExactlyOnceWith({ version: 1, sessionId: 'ms-late' });
    binding.dispose();
  });

  it('ignores intermediate history projections and reopens only after a successful restore', async () => {
    const { scene, measure, binding, api, volumes, suspend } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    suspend(true); scene.selectVolumeIds([volumes[1].id]);
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 2, instanceId: 21, volumeId: 11 },
    ] });
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
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 1, instanceId: 20, volumeId: 10 }, { objectId: 2, instanceId: 21, volumeId: 11 },
    ] });
    const removed = volumes.pop()!;
    scene.pruneSelection(); await measure.settled();
    expect(scene.gizmo).toBe('measure');
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 1, instanceId: 20, volumeId: 10 },
    ] });
    expect(measure.getSnapshot()).toMatchObject({ phase: 'idle', targets: [{ objectId: 1, instanceId: 20, volumeId: 10 }],
      status: { sessionId: 'ms-2', first: null, second: null } });
    expect(api.closeMeasureSession).toHaveBeenCalledWith({ version: 1, sessionId: 'ms-1' });
    const retained = volumes.pop()!; scene.pruneSelection(); await measure.settled();
    expect(scene.gizmo).toBeNull(); expect(measure.active).toBe(false);
    expect(scene.instanceHider.getSnapshot()).toBeNull();
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

  it('updates isolation before ordinary scene listeners even when they subscribed first', async () => {
    const observations: Array<{ gizmo: string | null; scope: unknown }> = [];
    const { scene, measure, binding, volumes } = fixture(current => current.subscribe(() => {
      observations.push({ gizmo: current.gizmo, scope: current.instanceHider.getSnapshot() });
    }));
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure');
    expect(observations.at(-1)).toEqual({ gizmo: 'measure', scope: { kind: 'volumes', volumes: [
      { objectId: 1, instanceId: 20, volumeId: 10 },
    ] } });
    scene.toggleGizmo('move');
    expect(observations.at(-1)).toEqual({ gizmo: 'move', scope: null });
    await measure.settled(); binding.dispose();
  });

  it('isolates an already active Measure selection when the binding is installed', async () => {
    const { scene, measure, binding, volumes } = fixture((current, selected) => {
      current.selectVolumeIds([selected[0].id]); current.toggleGizmo('measure');
    });
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 1, instanceId: 20, volumeId: 10 },
    ] });
    expect(scene.selectedVolumes()).toEqual([volumes[0]]);
    await measure.settled(); expect(measure.active).toBe(true);
    await binding.close(); binding.dispose();
  });

  it('updates isolation immediately but coalesces Measure session work during deferred scene notifications', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    const notify = vi.fn(); const unsubscribe = scene.subscribe(notify);
    const releaseOuter = scene.deferNotifications(), releaseInner = scene.deferNotifications();
    scene.selectVolumeIds([volumes[1].id]);
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 2, instanceId: 21, volumeId: 11 },
    ] });
    expect(measure.getSnapshot().targets).toEqual([{ objectId: 1, instanceId: 20, volumeId: 10 }]);
    expect(api.openMeasureSession).toHaveBeenCalledOnce(); expect(notify).not.toHaveBeenCalled();
    releaseInner(); expect(notify).not.toHaveBeenCalled();
    releaseOuter(); expect(notify).toHaveBeenCalledOnce();
    await measure.settled();
    expect(api.openMeasureSession).toHaveBeenCalledTimes(2);
    expect(measure.getSnapshot().targets).toEqual([{ objectId: 2, instanceId: 21, volumeId: 11 }]);
    unsubscribe(); await binding.close(); binding.dispose();
  });

  it('tracks tool switches during a deferred batch without reopening Measure for intermediate states', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    const notify = vi.fn(); const unsubscribe = scene.subscribe(notify);
    const release = scene.deferNotifications();
    scene.toggleGizmo('move');
    expect(scene.instanceHider.getSnapshot()).toBeNull();
    expect(measure.active).toBe(true); expect(api.closeMeasureSession).not.toHaveBeenCalled();
    scene.toggleGizmo('measure');
    expect(scene.instanceHider.getSnapshot()).toEqual({ kind: 'volumes', volumes: [
      { objectId: 1, instanceId: 20, volumeId: 10 },
    ] });
    expect(notify).not.toHaveBeenCalled();
    release(); await measure.settled();
    expect(notify).toHaveBeenCalledOnce();
    expect(api.openMeasureSession).toHaveBeenCalledOnce();
    expect(api.closeMeasureSession).not.toHaveBeenCalled();
    unsubscribe(); await binding.close(); binding.dispose();
  });

  it('keeps a successor Boolean isolation while Measure cleanup is pending', async () => {
    const { scene, measure, binding, api, volumes } = fixture();
    const previous = volumes[1]; volumes[1] = volume(1, 0); previous.dispose();
    scene.selectVolumeIds(volumes.map(item => item.id)); scene.toggleGizmo('measure'); await measure.settled();
    const close = deferred<{ ok: true; version: 1; sessionId: string }>();
    api.closeMeasureSession.mockReturnValueOnce(close.promise);
    const release = scene.deferNotifications();
    expect(scene.toggleGizmo('mesh-boolean')).toBe(true);
    expect(scene.instanceHider.getSnapshot()).toEqual({ objectId: 1, instanceId: 20 });
    expect(measure.active).toBe(true); expect(api.closeMeasureSession).not.toHaveBeenCalled();
    release();
    await tick();
    expect(api.closeMeasureSession).toHaveBeenCalledOnce();
    close.resolve({ ok: true, version: 1, sessionId: 'ms-1' }); await measure.settled();
    expect(scene.instanceHider.getSnapshot()).toEqual({ objectId: 1, instanceId: 20 });
    scene.closeGizmo(); expect(scene.instanceHider.getSnapshot()).toBeNull();
    binding.dispose();
  });

  it('does not release a successor painting scope on disposal', async () => {
    const { scene, measure, binding, volumes } = fixture();
    scene.selectVolumeIds([volumes[0].id]); scene.toggleGizmo('measure'); await measure.settled();
    const paint = scene.instanceHider.acquire(volumes[1].buffer);
    binding.dispose();
    expect(scene.instanceHider.getSnapshot()).toEqual({ objectId: 2, instanceId: 21 });
    scene.notifyTransformsChanged();
    await measure.settled();
    expect(scene.instanceHider.getSnapshot()).toEqual({ objectId: 2, instanceId: 21 });
    paint.release();
  });
});
