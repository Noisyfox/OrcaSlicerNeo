import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformCapabilities, ProjectInput } from '@orca/platform-contract';
import type { PresetSnapshot } from '@slicer/client';
import { useProjectStore } from './stores/useProjectStore';
import { useSettingsStore } from './stores/useSettingsStore';
import { useSlicerStore } from './stores/useSlicerStore';
import { importProjectGeometry, newProject, openProject, saveProject } from './projectActions';

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
    loadProject: vi.fn(async () => ({ ok: true, objects: 1, instances: 1, mode: 'project' as const, compatibility: 'bambu' as const, projectSettingsAvailable: true, ...load })),
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
});
