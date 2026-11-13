import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClient, createMockModule, MOCK_PROFILE_ACTIVATION, type MeshBooleanRequest } from '@slicer/client';
import { normalizeUserPreferences, type SlicerRuntime } from '@orca/platform-contract';
import { executeMeshBoolean } from './meshBooleanCommand';
import { GLVolume, glVolumeCollection } from '../../GLVolume';
import { SceneInteractionController } from '../../SceneInteractionController';
import { useObjectListStore } from '../../../objectList/useObjectListStore';
import { useMeshBooleanStore } from '@/stores/useMeshBooleanStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { useNotificationStore } from '@/stores/useNotificationStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { enqueueProjectMutationOperation, enqueueProjectReadOperation } from '@/history/projectMutationGate';
import { historyContextForStructure } from '../../../actions/historyMutation';
import { registerMeasureCommands } from '../measure/projectCommands';
import type { MeasureController } from '../measure/MeasureController';

beforeEach(() => {
  useProjectStore.getState().reset(); useNotificationStore.getState().reset();
  useMeshBooleanStore.setState({ busy: false, ready: false, keepPainting: false });
  useSettingsStore.setState({ modelLoaded: true, modelRevision: 0 });
});
afterEach(() => glVolumeCollection.clear());
async function setup(empty = false) {
  const module = createMockModule({ volumeCount: 2, instanceCount: 2, meshBooleanResult: empty ? 'empty' : 'success' });
  const runtime = createClient(async () => module) as SlicerRuntime;
  await runtime.init(MOCK_PROFILE_ACTIVATION); await runtime.addModel(new Uint8Array(4), 'stl');
  const structure = await runtime.getModelStructure();
  useObjectListStore.getState().setStructure(structure.objects);
  const meshes = await runtime.getModelMesh();
  glVolumeCollection.replace(meshes.objects.map(buffer => new GLVolume(buffer, { kind: 'exclusive' })), 0);
  const plate = await runtime.getPlateSessionSnapshot(); if (!plate.ok) throw new Error('plate');
  usePlateSessionStore.getState().setSnapshot(plate);
  const scene = new SceneInteractionController(() => glVolumeCollection.volumes);
  scene.selectComposite(0, undefined, 0); scene.toggleGizmo('mesh-boolean');
  const selected = scene.selectedVolumes();
  scene.meshBoolean.assign(selected[0]); scene.meshBoolean.assign(selected[1]);
  const request: MeshBooleanRequest = { ...scene.meshBoolean.request(false)!, operation: 'difference' };
  const preferences = { load: async () => normalizeUserPreferences({ version: 1 }), save: vi.fn(async () => {}) };
  return { runtime, scene, request, platform: { runtime, preferences } };
}

it('publishes committed structure/selection before releasing the wait, rejecting edits instead of queuing them', async () => {
  const { runtime, scene, request, platform } = await setup();
  let release!: () => void;
  const publication = new Promise<void>(resolve => { release = resolve; });
  const patch = runtime.getModelScenePatch.bind(runtime);
  runtime.getModelScenePatch = vi.fn(async (...args: Parameters<typeof patch>) => { await publication; return patch(...args); });
  let resumedRead: Promise<unknown> = Promise.resolve();
  const unsubscribe = useMeshBooleanStore.subscribe((current, previous) => {
    if (previous.busy && !current.busy) resumedRead = enqueueProjectReadOperation(async () => 'editor resumed');
  });
  const task = executeMeshBoolean(platform, request, scene);
  await vi.waitFor(() => expect(runtime.getModelScenePatch).toHaveBeenCalled());
  expect(useMeshBooleanStore.getState().busy).toBe(true);
  const foreign = vi.fn(async () => {});
  await expect(enqueueProjectMutationOperation(foreign)).rejects.toThrow('mesh_boolean_busy');
  expect(await executeMeshBoolean(platform, request, scene)).toEqual({ ok: false, error: 'mesh_boolean_busy' });
  release(); const result = await task;
  unsubscribe(); await expect(resumedRead).resolves.toBe('editor resumed');
  expect(result.ok && result.changed).toBe(true);
  if (!result.ok || !result.changed) throw new Error(JSON.stringify(result));
  expect(useObjectListStore.getState().structure[0].volumes.map(volume => volume.id)).toContain(result.volumeId);
  expect(scene.selectedVolumes().map(volume => volume.buffer.volumeId)).toEqual([result.volumeId]);
  expect(scene.gizmo).toBe('mesh-boolean');
  expect(scene.meshBoolean.getSnapshot()).toMatchObject({ a: null, b: null, picking: 'a' });
  expect(useMeshBooleanStore.getState().busy).toBe(false);
  expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
  expect(foreign).not.toHaveBeenCalled();
});

it('rejects Boolean consumption of measured parts before project admission while allowing a retained tool', async () => {
  const { runtime, scene, request, platform } = await setup();
  let target = { objectId: request.objectId, instanceId: request.instanceId, volumeId: request.sourceVolumeId };
  const report = vi.fn();
  const unregister = registerMeasureCommands({ active: true, getSnapshot: () => ({ targets: [target] }),
    reportTargetProtected: report } as unknown as MeasureController);
  const call = vi.spyOn(runtime, 'meshBoolean');
  try {
    expect(await executeMeshBoolean(platform, request, scene)).toEqual({ ok: false, error: 'Close Measure before changing its target' });
    target = { ...target, volumeId: request.toolVolumeId };
    expect(await executeMeshBoolean(platform, { ...request, deleteInput: true }, scene)).toEqual({ ok: false, error: 'Close Measure before changing its target' });
    expect(await executeMeshBoolean(platform, { ...request, operation: 'union' }, scene)).toEqual({ ok: false, error: 'Close Measure before changing its target' });
    expect(call).not.toHaveBeenCalled();
    const retained = await executeMeshBoolean(platform, { ...request, deleteInput: false }, scene);
    expect(retained.ok && retained.changed).toBe(true); expect(call).toHaveBeenCalledOnce();
  } finally { unregister(); }
});

it('keeps inputs and picks for an empty result, warns, and releases both fences', async () => {
  const { scene, request, platform } = await setup(true);
  const before = [...scene.selection.ids], picks = scene.meshBoolean.getSnapshot();
  expect(await executeMeshBoolean(platform, request, scene)).toEqual({ ok: true, changed: false, warning: 'empty_result' });
  expect([...scene.selection.ids]).toEqual(before);
  expect(scene.meshBoolean.getSnapshot()).toEqual(picks);
  expect(useNotificationStore.getState().notifications.at(-1)?.message).toBe('Unable to perform boolean operation on selected parts');
  expect(useMeshBooleanStore.getState().busy).toBe(false);
  expect(useProjectStore.getState().projectMutationPendingCount).toBe(0);
});

it('keeps normal instance clicks after closing the result tool and after Undo/Redo', async () => {
  const { runtime, scene, request, platform } = await setup();
  const result = await executeMeshBoolean(platform, request, scene);
  if (!result.ok || !result.changed) throw new Error(JSON.stringify(result));
  expect(scene.selectedVolumes().map(volume => volume.buffer.volumeId)).toEqual([result.volumeId]);
  expect(scene.selectionMode).toBe('instance');
  expect(historyContextForStructure(scene).selection).toEqual({ mode: 'part', objectIds: [],
    partIds: [result.volumeId], instanceIds: [request.instanceId] });
  scene.closeGizmo(); scene.clearSelection();
  const hit = glVolumeCollection.volumes.find(volume => volume.buffer.volumeId === result.volumeId &&
    volume.buffer.instanceId === request.instanceId)!;
  scene.prepareBodyDragFromPointerDown(hit, false);
  expect(scene.selectedVolumes().map(volume => volume.buffer.volumeId).sort()).toEqual([result.volumeId, request.toolVolumeId].sort());
  expect((await runtime.undoHistory()).ok).toBe(true);
  const redone = await runtime.redoHistory();
  if (!redone.ok) throw new Error(JSON.stringify(redone));
  expect(redone.context.selection).toEqual({ mode: 'part', objectIds: [],
    partIds: [result.volumeId], instanceIds: [request.instanceId] });
  scene.restoreHistoryContext(redone.context, await runtime.getModelStructure());
  expect(scene.selectedVolumes().map(volume => volume.buffer.volumeId)).toEqual([result.volumeId]);
  expect(scene.selectionMode).toBe('instance');
  scene.clearSelection(); scene.prepareBodyDragFromPointerDown(hit, false);
  expect(scene.selectedVolumes()).toHaveLength(2);
});
