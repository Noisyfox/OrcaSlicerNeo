import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, createMockModule } from '@slicer/client';
import { PaintingController } from './PaintingController';
import { registerPaintingCommands, paintingCommandAllowed, beforePaintingTopologyChange } from './projectCommands';
import { coordinatePaintingRpc, runProjectHistoryMutation, runProjectMutationOperation } from '@/components/workspace/actions/historyMutation';
import { saveProject, saveProjectAs, newProject, openProject } from '@/projectActions';
import { addModel } from '@/components/workspace/actions/sceneActions';
import { sliceModel, exportGcode } from '@/components/workspace/actions/sliceActions';
import { commitScopedConfigurationMutation } from '@/components/workspace/settings/configurationActions';
import { createHistoryRestoreCoordinator } from '@/history/restoreCoordinator';
import { useProjectStore } from '@/stores/useProjectStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import type { FilamentMutationSummary, FilamentSessionSnapshot } from '@slicer/client';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { projectHistoryStatus } from '@/history/projectHistoryStatus';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';
import { useObjectListStore } from '@/components/workspace/objectList/useObjectListStore';
import { glVolumeCollection } from '@/components/workspace/viewport/GLVolume';
import { mmuPaintingColor } from './MmuPaintingGizmo';
import type { PlatformCapabilities } from '@orca/platform-contract';
import type { SceneInteractionController } from '@/components/workspace/viewport/SceneInteractionController';

const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const event = { pointer: [1,2] as const, viewport: [0,0,100,100] as const, projection: identity, view: identity };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
let unregister = () => {};
afterEach(() => { unregister(); glVolumeCollection.clear(0); useObjectListStore.getState().clear(); useFilamentSessionStore.getState().reset(); useHistoryNavigationStore.getState().reset(); useProjectStore.getState().reset(); vi.restoreAllMocks(); });
async function setup(preloadFilament = false) {
  const runtime = createClient(async () => createMockModule());
  await runtime.init();
  await runProjectHistoryMutation(runtime, 'Add cube', () => runtime.addShape('Cube'));
  const structure = await runtime.getModelStructure();
  if (!structure.ok || !structure.objects?.length) throw new Error('missing fixture');
  const object = structure.objects[0];
  if (preloadFilament) {
    const initial = await runtime.getFilamentSessionSnapshot();
    if (!initial.ok) throw new Error(initial.error);
    const added = await runtime.addFilamentSlot({ version: 1, revision: initial.revisions.session });
    if (!added.ok) throw new Error(added.error);
    const rack = await useFilamentSessionStore.getState().load(runtime);
    if (!rack.ok) throw new Error(rack.error);
  }
  const filamentReads = vi.spyOn(runtime, 'getFilamentSessionSnapshot');
  const frames: Array<() => void> = [];
  const controller = new PaintingController({ api: runtime, coordinate: coordinatePaintingRpc,
    history: projectHistoryStatus, committed: vi.fn(), prepareClosed: vi.fn(async () => {}),
    schedule: (callback) => { frames.push(callback); return () => { const i = frames.indexOf(callback); if (i >= 0) frames.splice(i, 1); }; }, palette: () => useFilamentSessionStore.getState().snapshot,
    targetAvailable: (objectId, instanceId) => useObjectListStore.getState().structure
      .some((entry) => entry.id === objectId && entry.instances.some((instance) => instance.id === instanceId)) });
  unregister = registerPaintingCommands(controller);
  expect(await controller.open(object.id, object.instances[0].id, 'mmu')).toBe(true);
  frames.shift()?.(); await vi.waitFor(() => expect(controller.getSnapshot().display).not.toBeNull());
  useProjectStore.getState().setProject({ hasContent: true });
  const platform = { runtime,
    projects: { save: vi.fn(async () => ({ status: 'ok', displayName: 'Untitled.3mf' })), saveAs: vi.fn(async () => ({ status: 'ok', displayName: 'Untitled.3mf' })), open: vi.fn(async () => ({ status: 'cancelled' })) },
    models: { pick: vi.fn(async () => null) }, exports: { save: vi.fn() }, preferences: { load: vi.fn(async () => ({})) },
  } as unknown as PlatformCapabilities;
  return { runtime, controller, object, platform, filamentReads };
}

describe('shared painting command admission', () => {
  it('accepts a filament colour edit after painter open with the native history revision', async () => {
    const { runtime, controller: c, filamentReads } = await setup(true);
    expect(filamentReads).not.toHaveBeenCalled();
    const before = useFilamentSessionStore.getState().snapshot!;
    const native = await runtime.getFilamentSessionSnapshot();
    expect(native.ok).toBe(true);
    if (!native.ok) return;
    expect(before.revisions.session).toBe(native.revisions.session);
    const result = await useFilamentSessionStore.getState().run(runtime, () => runtime.setFilamentSlotColour({
      version: 1, revision: useFilamentSessionStore.getState().snapshot!.revisions.session,
      slot: 2, colour: '#445566',
    }));
    expect(result.ok).toBe(true);
    expect(useFilamentSessionStore.getState().snapshot?.slots[1].colour.effective).toBe('#445566');
    expect(c.getSnapshot().phase).toBe('idle');
  });
  it('accepts an idle filament colour edit after an effective paint commit and keeps the palette and history coherent', async () => {
    const { runtime, controller: c, object, filamentReads } = await setup(true);
    c.setSettings({ state: 2 });
    expect(await c.apply('gap')).toBe(true);
    expect(filamentReads).not.toHaveBeenCalled();
    const native = await runtime.getFilamentSessionSnapshot();
    expect(native.ok).toBe(true);
    if (!native.ok) return;
    expect(useFilamentSessionStore.getState().snapshot?.revisions.session).toBe(native.revisions.session);
    const result = await useFilamentSessionStore.getState().run(runtime, () => runtime.setFilamentSlotColour({
      version: 1, revision: useFilamentSessionStore.getState().snapshot!.revisions.session,
      slot: 2, colour: '#445566',
    }));
    expect(result.ok).toBe(true);
    expect(c.getSnapshot().phase).toBe('idle');
    const rack = useFilamentSessionStore.getState().snapshot!;
    expect(mmuPaintingColor(rack, object.id, object.volumes[0].id, 2)).toBe('#445566');
    expect((await runtime.getHistoryStatus()).editingSession).not.toBeNull();
  });
  it('rejects shared actions before dialogs, config queues, history or runtime while a press is pending; never replays', async () => {
    const { runtime, controller: c, platform, object } = await setup();
    const gate = deferred<void>(); const begin = runtime.beginPaintingStroke.bind(runtime);
    vi.spyOn(runtime, 'beginPaintingStroke').mockImplementation(async (request) => { await gate.promise; return begin(request); });
    const press = c.press(event);
    const save = vi.spyOn(runtime, 'exportProject');
    const clear = vi.spyOn(runtime, 'clearModel');
    const slice = vi.spyOn(runtime, 'slicePlate');
    const exportNative = vi.spyOn(runtime, 'exportGcodePlate');
    const decideDirty = vi.fn(async () => 'dont-save' as const);
    expect(await saveProject(platform)).toEqual({ status: 'cancelled' });
    expect(await saveProjectAs(platform)).toEqual({ status: 'cancelled' });
    expect(await newProject(platform, { decideDirty })).toEqual({ status: 'cancelled' });
    expect(await openProject(platform)).toEqual({ status: 'cancelled' });
    expect(await addModel(platform, null)).toBe(false);
    await sliceModel(platform); await exportGcode(platform);
    expect(await commitScopedConfigurationMutation(platform, {} as never)).toBeNull();
    const mutation = vi.fn(async () => ({ ok: true }));
    await expect(runProjectHistoryMutation(runtime, 'Rename', mutation)).rejects.toThrow('busy');
    expect(await beforePaintingTopologyChange({ objects: [object.id] })).toBe(false);
    expect(await c.close()).toBe(false);
    expect(decideDirty).not.toHaveBeenCalled(); expect(platform.projects.open).not.toHaveBeenCalled();
    expect(platform.models.pick).not.toHaveBeenCalled(); expect(platform.projects.save).not.toHaveBeenCalled();
    c.cancel(); gate.resolve(); await press;
    expect(paintingCommandAllowed()).toBe(true);
    for (const call of [save, clear, slice, exportNative, mutation]) expect(call).not.toHaveBeenCalled();
  });
  it('coordinates actual project transactions and restore coordinator without nested FIFO deadlock', async () => {
    const { runtime, controller: c, object } = await setup();
    const before = c.getSnapshot().epoch;
    const renamed = await runProjectHistoryMutation(runtime, 'Rename', () => runtime.renameObject(object.id, 'changed'));
    expect(renamed.result.ok).toBe(true); expect(c.getSnapshot().phase).toBe('idle');
    expect(c.getSnapshot().epoch).toBeGreaterThan(before);
    const refreshModel = vi.fn(async () => {});
    const history = createHistoryRestoreCoordinator({ runtime, sceneInteraction: { activeDrag: null } as unknown as SceneInteractionController, refreshModel });
    expect(await history.restore('undo')).toBe(true);
    expect(refreshModel).toHaveBeenCalledTimes(1); expect(c.getSnapshot().phase).toBe('idle');
    expect((await runtime.getHistoryStatus()).editingSession).not.toBeNull();
  });
  it('holds Save reservation through the host write, retaining painter and expanded history', async () => {
    const { runtime, controller: c, platform } = await setup();
    const write = deferred<{ status: 'ok'; displayName: string }>(); vi.mocked(platform.projects.save).mockReturnValueOnce(write.promise);
    const close = vi.spyOn(runtime, 'closeHistorySession');
    const saved = saveProject(platform);
    await vi.waitFor(() => expect(platform.projects.save).toHaveBeenCalledTimes(1));
    expect(await c.press(event)).toBe('ignored');
    write.resolve({ status: 'ok', displayName: 'Untitled.3mf' }); expect((await saved).status).toBe('ok');
    expect(close).not.toHaveBeenCalled(); expect(c.getSnapshot().phase).toBe('idle');
    expect((await runtime.getHistoryStatus()).dirty).toBe(false);
  });
  it('orders unrelated ordinary commands through the same lane even when the preceding command fails', async () => {
    const { controller: c } = await setup();
    const first = deferred<void>(), second = deferred<void>();
    const calls: string[] = [];
    const one = runProjectMutationOperation(async () => { calls.push('first'); await first.promise; throw new Error('failed'); });
    const failed = expect(one).rejects.toThrow('failed');
    const two = runProjectMutationOperation(async () => { calls.push('second'); await second.promise; });
    await vi.waitFor(() => expect(calls).toEqual(['first']));
    expect(await c.press(event)).toBe('ignored');
    first.resolve(); await failed;
    await vi.waitFor(() => expect(calls).toEqual(['first', 'second']));
    expect(c.getSnapshot().phase).toBe('opening');
    expect(await c.press(event)).toBe('ignored');
    second.resolve(); await two;
    expect(c.getSnapshot().phase).toBe('idle');
  });
  it('retains the hidden owner on picker/dirty cancellation and requested save failure', async () => {
    const { runtime, controller: c, platform } = await setup();
    const close = vi.spyOn(runtime, 'closeHistorySession');
    expect((await openProject(platform)).status).toBe('cancelled');
    expect((await newProject(platform, { decideDirty: () => 'cancel' })).status).toBe('cancelled');
    vi.mocked(platform.projects.save).mockResolvedValueOnce({ status: 'failed', error: 'disk full' });
    expect((await newProject(platform, { decideDirty: () => 'save' })).status).toBe('failed');
    expect(close).not.toHaveBeenCalled(); expect(c.getSnapshot().phase).toBe('idle');
  });
  it('does not replace or slice after closure fails', async () => {
    const { runtime, controller: c, platform } = await setup();
    vi.spyOn(runtime, 'closeHistorySession').mockRejectedValue(new Error('close failed'));
    const clear = vi.spyOn(runtime, 'clearModel'), slice = vi.spyOn(runtime, 'slicePlate');
    expect((await newProject(platform, { decideDirty: () => 'dont-save' })).status).toBe('cancelled');
    await sliceModel(platform);
    expect(clear).not.toHaveBeenCalled(); expect(slice).not.toHaveBeenCalled(); expect(c.active).toBe(true);
  });
  it('tracks duplicate-looking slots by native identity through remap and history restoration', async () => {
    const { runtime, controller: c } = await setup();
    const base = await runtime.getFilamentSessionSnapshot();
    if (!base.ok) throw new Error('missing palette');
    const palette = (ids: string[]): FilamentSessionSnapshot => ({ ...base,
      slots: ids.map((logicalId, index) => ({ ...base.slots[0], slot: index + 1, logicalId })) });
    const publish = (value: FilamentSessionSnapshot, mutation?: FilamentMutationSummary) => {
      useFilamentSessionStore.setState({ snapshot: value }); c.reconcilePalette(value, mutation);
    };
    publish(palette(['a', 'b', 'c'])); c.setSettings({ state: 2, radius: 9 });
    publish(palette(['b', 'c'])); expect(c.getSnapshot().settings.state).toBe(1);
    publish(palette(['a', 'b', 'c'])); expect(c.getSnapshot().settings.state).toBe(2);
    publish(palette(['a', 'c']), { kind: 'merge', source: 2, destination: 2 } as FilamentMutationSummary);
    publish(palette(['a', 'b', 'c'])); expect(c.getSnapshot().settings.state).toBe(3);
    publish(palette(['a', 'b'])); expect(c.getSnapshot().settings.state).toBe(1);
    c.setSettings({ state: 2 });
    publish(palette(['a', ...Array.from({ length: 15 }, (_, i) => `new${i}`), 'b']));
    expect(c.getSnapshot().settings.state).toBe(1);
    c.resetProjectPalette(); expect(c.getSnapshot().settings).toMatchObject({ state: 1, radius: 9 });
  });
  it('exports only an existing valid G-code result after settling and keeps the painter open', async () => {
    const { runtime, controller: c, platform } = await setup();
    const session = await runtime.getPlateSessionSnapshot();
    if (!session.ok) throw new Error('missing plates');
    const plateId = session.currentPlateId, inputStamp = session.inputRevisions![plateId];
    const store = useSlicerStore.getState(); store.invalidateSliceResult();
    const receipt = { plateId, inputStamp, resultGeneration: '1', sliceTaskId: 'test' };
    store.setPlateResult(receipt, [], {}); store.activatePlateResult(plateId, inputStamp);
    const settle = vi.spyOn(runtime, 'settlePainting');
    const slice = vi.spyOn(runtime, 'slicePlate');
    const exported = vi.spyOn(runtime, 'exportGcodePlate').mockResolvedValue({ ok: true, fileName: 'output.gcode', bytes: new Uint8Array([1]) });
    await exportGcode(platform);
    expect(settle).toHaveBeenCalledTimes(1); expect(exported).toHaveBeenCalledWith({ receipt, filenameBase: '' });
    expect(platform.exports.save).toHaveBeenCalledTimes(1); expect(c.getSnapshot().phase).toBe('idle');
    store.invalidateSliceResult(); vi.spyOn(console, 'error').mockImplementation(() => {});
    await exportGcode(platform);
    expect(exported).toHaveBeenCalledTimes(1); expect(slice).not.toHaveBeenCalled();
    expect(useSlicerStore.getState().error).toContain('stale or unavailable');
  });
});
