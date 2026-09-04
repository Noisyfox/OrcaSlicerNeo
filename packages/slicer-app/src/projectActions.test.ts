import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities, ProjectInput } from '@orca/platform-contract';
import type { PresetSnapshot } from '@slicer/client';
import { useProjectStore } from './stores/useProjectStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import { importProjectGeometry, newProject, openProject, openProjectInputs, saveProject, sortProjectInputs } from './projectActions';

const input: ProjectInput = { displayName: 'Robot.3mf', bytes: new Uint8Array([80, 75, 3, 4]) };
const snapshot: PresetSnapshot = {
  ok: true,
  printers: [{ name: 'Project printer', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
  prints: [{ name: 'Project process', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
  filaments: [{ name: 'Project filament', is_visible: true, is_default: false, vendor_id: '', model: '', variant: '', selected: true }],
  printer: { name: 'Project printer', idx: 0 }, print: { name: 'Project process', idx: 0 }, filament: { name: 'Project filament', idx: 0 },
};
function platformFor(load: Record<string, unknown> = {}) {
  const runtime = {
    loadProject: vi.fn(async () => ({ ok: true, objects: 1, instances: 1, mode: 'project' as const, compatibility: 'bambu' as const, projectSettingsAvailable: true, presetSnapshot: snapshot, ...load })),
    importProjectGeometry: vi.fn(async () => ({ ok: true, objects: 2, instances: 2, mode: 'geometry-only' as const, compatibility: 'generic' as const, projectSettingsAvailable: false })),
    clearModel: vi.fn(async () => ({ ok: true })),
    exportProject: vi.fn(async () => ({ ok: true, path: '/tmp/project.3mf', bytes: new Uint8Array([1, 2]) })),
    getPresetSnapshot: vi.fn(async () => snapshot),
    selectPreset: vi.fn(async () => snapshot),
    cancel: vi.fn(async () => ({ ok: true })),
  };
  const projects = {
    open: vi.fn(async () => ({ status: 'ok' as const, input })),
    save: vi.fn(async () => ({ status: 'ok' as const })),
    saveAs: vi.fn(async () => ({ status: 'ok' as const })),
  };
  return { runtime, projects, platform: { runtime, projects } as unknown as PlatformCapabilities };
}

describe('transactional project actions', () => {
  beforeEach(() => {
    useProjectStore.getState().reset();
    useSettingsStore.setState({ modelLoaded: false, selectedPrinter: 'System printer', selectedPrint: 'System process', selectedFilament: 'System filament', values: {} });
    useSlicerStore.getState().invalidateSliceResult();
  });

  it('applies every load behaviour and asks only when required', async () => {
    const all = platformFor();
    await openProject(all.platform, { loadBehaviour: 'load_all' });
    expect(all.runtime.loadProject).toHaveBeenCalled();

    useProjectStore.getState().reset(); useSettingsStore.setState({ modelLoaded: true });
    const relevant = platformFor(); const choose = vi.fn(() => 'geometry-only' as const);
    await openProject(relevant.platform, { loadBehaviour: 'ask_when_relevant', chooseLoad: choose });
    expect(choose).toHaveBeenCalled(); expect(relevant.runtime.importProjectGeometry).toHaveBeenCalled();

    useProjectStore.getState().reset(); const always = platformFor();
    const cancelled = await openProject(always.platform, { loadBehaviour: 'always_ask' });
    expect(cancelled.status).toBe('cancelled'); expect(always.runtime.loadProject).not.toHaveBeenCalled();

    const geometry = platformFor();
    await openProject(geometry.platform, { loadBehaviour: 'load_geometry_only' });
    expect(geometry.runtime.importProjectGeometry).toHaveBeenCalled();
  });

  it('replaces the project after explicit open even when settings fallback is needed', async () => {
    const { platform } = platformFor({ compatibility: 'generic', projectSettingsAvailable: false });
    useSettingsStore.setState({ modelLoaded: true });
    useProjectStore.getState().setProject({ dirty: true, hasContent: true });
    const result = await openProject(platform, { loadBehaviour: 'load_all', decideDirty: () => 'dont-save' });
    expect(result.status).toBe('ok');
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', dirty: false, scope: 'project', hasContent: true });
    expect(useProjectStore.getState().notices[0]?.kind).toBe('compatibility-fallback');
  });

  it('commits the native load response without a second snapshot read', async () => {
    const { platform, runtime } = platformFor();
    runtime.getPresetSnapshot.mockResolvedValue({ ok: false, error: 'late snapshot read failed' } as never);
    const result = await openProject(platform, { loadBehaviour: 'load_all' });
    expect(result.status).toBe('ok');
    expect(runtime.getPresetSnapshot).not.toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Robot', scope: 'project', dirty: false });
  });

  it('geometry import never replaces active settings and makes the session dirty', async () => {
    const { platform } = platformFor();
    useSettingsStore.setState({ modelLoaded: true, selectedPrinter: 'Current printer', selectedPrint: 'Current process', selectedFilament: 'Current filament', values: { layer_height: '0.2' } });
    await importProjectGeometry(platform, input);
    expect(useSettingsStore.getState()).toMatchObject({ selectedPrinter: 'Current printer', selectedPrint: 'Current process', values: { layer_height: '0.2' } });
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', dirty: true, hasContent: true });
  });

  it('cancelled/failed saves leave the clean baseline and dirty state untouched', async () => {
    const cancelled = platformFor(); cancelled.projects.save.mockResolvedValue({ status: 'cancelled' } as never);
    useProjectStore.getState().setProject({ hasContent: true, dirty: true, projectName: 'Robot' });
    expect((await saveProject(cancelled.platform)).status).toBe('cancelled');
    expect(useProjectStore.getState().dirty).toBe(true);

    const failed = platformFor(); failed.runtime.exportProject.mockResolvedValue({ ok: false, path: '', bytes: new Uint8Array(), error: 'export failed' } as never);
    expect((await saveProject(failed.platform)).status).toBe('failed');
    expect(useProjectStore.getState().dirty).toBe(true);
  });

  it('Save then New restores the saved global preset selection', async () => {
    const { platform, runtime } = platformFor();
    useProjectStore.getState().setProject({ hasContent: true, dirty: true, scope: 'project', systemPresets: { printer: 'System printer', print: 'System process', filament: 'System filament' } });
    const result = await newProject(platform, { decideDirty: () => 'save' });
    expect(result.status).toBe('ok'); expect(runtime.clearModel).toHaveBeenCalled();
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'Untitled', dirty: false, scope: 'system', hasContent: false });
    expect(runtime.selectPreset).toHaveBeenCalledWith('printer', 'System printer');
  });

  it('sorts a batch, asks only for the first 3MF, then appends every remainder', async () => {
    const { platform, runtime } = platformFor();
    const files = [
      { displayName: 'z-model.stl', bytes: new Uint8Array([3]) },
      { displayName: 'b-project.3mf', bytes: new Uint8Array([2]) },
      { displayName: 'a-project.3mf', bytes: new Uint8Array([1]), location: {} as ProjectInput['location'] },
    ];
    const choose = vi.fn(() => 'project' as const);
    const result = await openProjectInputs(platform, files, { loadBehaviour: 'always_ask', chooseLoad: choose });
    expect(result.status).toBe('ok');
    expect(choose).toHaveBeenCalledWith(files[2]);
    expect(runtime.loadProject).toHaveBeenCalledWith(files[2].bytes, 'project', 'a-project.3mf');
    expect(runtime.importProjectGeometry).toHaveBeenCalledTimes(2);
    expect(runtime.importProjectGeometry.mock.calls.map((call) => (call as unknown[])[1])).toEqual(['b-project.3mf', 'z-model.stl']);
    expect(useProjectStore.getState()).toMatchObject({ projectName: 'a-project', dirty: true, location: files[2].location });
    expect(sortProjectInputs(files).map((file) => file.displayName)).toEqual(['a-project.3mf', 'b-project.3mf', 'z-model.stl']);
  });

  it('cancelling the first project choice leaves a whole batch untouched', async () => {
    const { platform, runtime } = platformFor();
    const result = await openProjectInputs(platform, [
      { displayName: 'first.3mf', bytes: new Uint8Array([1]) },
      { displayName: 'later.stl', bytes: new Uint8Array([2]) },
    ], { loadBehaviour: 'always_ask', chooseLoad: () => 'cancel' });
    expect(result.status).toBe('cancelled');
    expect(runtime.loadProject).not.toHaveBeenCalled();
    expect(runtime.importProjectGeometry).not.toHaveBeenCalled();
  });

  it('rejects unsupported mixed input before any runtime mutation', async () => {
    const { platform, runtime } = platformFor();
    const result = await openProjectInputs(platform, [
      { displayName: 'project.3mf', bytes: new Uint8Array([1]) },
      { displayName: 'result.gcode', bytes: new Uint8Array([2]) },
    ], { loadBehaviour: 'load_all' });
    expect(result.status).toBe('failed');
    expect(runtime.loadProject).not.toHaveBeenCalled();
    expect(runtime.importProjectGeometry).not.toHaveBeenCalled();
  });

  it('rejects gcode.3mf and bgcode.3mf names before any batch mutation', async () => {
    const { platform, runtime } = platformFor();
    const result = await openProjectInputs(platform, [
      { displayName: 'a-project.3mf', bytes: new Uint8Array([1]) },
      { displayName: 'b.gcode.3mf', bytes: new Uint8Array([2]) },
      { displayName: 'c.bgcode.3mf', bytes: new Uint8Array([3]) },
    ], { loadBehaviour: 'load_all' });
    expect(result.status).toBe('failed');
    expect(runtime.loadProject).not.toHaveBeenCalled();
    expect(runtime.importProjectGeometry).not.toHaveBeenCalled();
  });

  it('retains a first project multi-plate notice while appending geometry', async () => {
    const { platform, runtime } = platformFor({ multiPlate: true, plateCount: 2 });
    const first = { displayName: 'project.3mf', bytes: new Uint8Array([1]), location: {} as ProjectInput['location'] };
    const result = await openProjectInputs(platform, [first, { displayName: 'part.stl', bytes: new Uint8Array([2]) }], { loadBehaviour: 'load_all' });
    expect(result.status).toBe('ok');
    expect(useProjectStore.getState().flattenedMultiPlate).toBe(true);
    expect(useProjectStore.getState().notices.some((notice) => notice.kind === 'multi-plate')).toBe(true);
  });
});
