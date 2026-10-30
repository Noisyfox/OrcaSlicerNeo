// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, createMockModule } from '@slicer/client';
import { createMoonrakerService } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { DEFAULT_USER_PREFERENCES, PlatformProvider, type PlatformCapabilities, type UserPreferences } from '@orca/platform-contract';
import { PrepareSynchronization, requestPrepareSynchronization, usePrepareSynchronization } from './PrepareSynchronization';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
import { useProjectDialogStore } from '@/stores/useProjectDialogStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = <K extends string>(s: string) => s as D.Id<K>;
const target: D.PrinterTarget = { printerId: id('device'), routeId: id('route') };
const known = <T,>(value: T, stale = false): D.Reading<T> => ({ kind: 'known', value, freshness: stale ? 'stale' : 'fresh', sourceRouteId: target.routeId, receivedAtMs: 1, observedAtMs: null });
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
const roots: Root[] = [];
afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(r => r.unmount()); });
  usePrepareSynchronization.setState({ kind: null }); useProjectDialogStore.setState({ open: false });
  useDeviceSelectionStore.setState({ currentPrinterId: null, requestedPrinterId: null, selectionRequestVersion: 0, navigationRequestVersion: 0 });
  useFilamentSessionStore.getState().reset(); useHistoryNavigationStore.getState().reset(); document.body.innerHTML = '';
});
async function fixture({ connected = true, model = 'X1 Carbon', stream = false, models = false, materialOnly = false, secondary = false } = {}) {
  let preferences: UserPreferences = structuredClone(DEFAULT_USER_PREFERENCES);
  const runtime = createClient(async () => createMockModule());
  if (models) {
    await runtime.addShape('Cube', 'Other Plate model');
    const initial = await runtime.getFilamentSessionSnapshot(); if (!initial.ok) throw new Error(initial.error);
    await runtime.addFilamentSlot({ version: 1, revision: initial.revisions.session });
  }
  const profile = await runtime.getProfileSnapshot(); if (!profile.ok) throw new Error(profile.error);
  useSettingsStore.getState().hydrateProfileSnapshot(profile);
  await useFilamentSessionStore.getState().load(runtime);
  let stale = !connected;
  const base = createMoonrakerService({ configuration: { load: async () => ({ version: 1, printers: [{ id: 'device', displayName: 'Generic fixture', driverId: 'moonraker', apiBaseUrl: 'http://fixture.local/', consoleUrl: '', apiKey: '' }] }), save: async () => {} },
    host: { id: id('host'), name: 'Fixture', execution: 'browser' }, transport: { request: vi.fn(async () => { throw new Error('No hardware access'); }) } });
  const saved = await base.listSaved(); if (!saved.ok) throw new Error('fixture');
  const route: D.PrinterRoute = { ...saved.value[0].routes[0], id: target.routeId, printerId: target.printerId, configurationRevision: 'config' };
  route.capabilities.observations.descriptor = materialOnly ? { kind: 'unsupported', layer: 'adapter', reason: 'Material-only agent' } : { kind: 'supported', constraints: { delivery: ['on-demand'] } };
  route.capabilities.observations.materials = { kind: 'supported', constraints: { delivery: stream ? ['push', 'on-demand'] : ['on-demand'] } };
  const printer: D.SavedPrinter = { identity: { id: target.printerId, displayName: 'Generic fixture', manufacturer: 'Bambu Lab', model, serialNumber: null, externalRefs: [] }, routes: secondary ? [route, { ...route, id: id('second-route') }] : [route] };
  const topology: D.MaterialTopology = { units: [{ id: id('feeder'), name: 'Feeder', kind: 'automatic-feeder', sensorIds: [] }],
    slots: [0, 1].map(i => ({ id: id(`source/${i}`), unitId: id('feeder'), name: `Tray ${i}` })),
    paths: [0, 1].map(i => ({ id: id(`path/${i}`), slotId: id(`source/${i}`), toolId: id('tool'), loading: 'automatic' })), dryers: [] };
  const snapshot = (): D.PrinterSnapshot<'materials' | 'descriptor'> => ({ target, configurationRevision: 'config', values: {
    materials: known({ topologyRevision: 'topology', topology, toolIds: [id('tool')], state: { inventoryRevision: 'inventory', tools: [], dryers: [], slots: topology.slots.map((s, i) => ({ slotId: s.id,
      presence: i ? unknown : known('empty' as const), material: known({ materialType: 'PLA', manufacturer: null, diameterMm: 1.75, catalogRefs: [], color: { kind: 'solid', rgba: i ? '#445566' : '#123456' } }), remaining: unknown, spoolIdentity: unknown })) } }, stale),
    descriptor: known({ revision: 'descriptor', identity: printer.identity, technology: 'fdm', firmware: unknown, buildVolume: null,
      topology: { revision: 'topology', completeness: 'complete', materials: topology, tools: [{ id: id('tool'), name: 'Tool', extruderId: id('extruder'), nozzleId: id('nozzle'), motionGroupId: id('gantry') }],
        nozzles: [{ id: id('nozzle'), diameterMm: 0.4, flowType: 'standard flow', flowReporting: 'supported', constructionMaterial: null, type: null, heaterId: null }], extruders: [], motionGroups: [], heaters: [], fans: [], lights: [], sensors: [], cameras: [] } }),
  } });
  let wake: (() => void) | undefined;
  const watch = vi.fn(async function* (_request: D.ObservationRequest, options?: D.ReadOptions) {
    while (!options?.signal?.aborted) {
      yield { type: 'snapshot' as const, snapshot: snapshot() };
      await new Promise<void>(resolve => { wake = resolve; options?.signal?.addEventListener('abort', () => resolve(), { once: true }); });
    }
  });
  const read = vi.fn(async (request: D.ObservationRequest & { source: 'device' | 'cache' }) => {
    if (request.source === 'device') stale = false;
    const full = request.target.routeId === 'second-route' ? JSON.parse(JSON.stringify(snapshot()).replaceAll('"route"', '"second-route"')) as ReturnType<typeof snapshot> : snapshot();
    if (secondary && request.target.routeId === 'route' && full.values.materials?.kind === 'known') full.values.materials.freshness = 'stale';
    return { ok: true as const, value: { ...full, values: Object.fromEntries(request.topics.map(t => [t, full.values[t as 'materials' | 'descriptor']])) } };
  });
  const service: D.PrinterService = { ...base, listSaved: vi.fn(async () => ({ ok: true as const, value: [printer] })), observations: { read: read as D.PrinterObservations['read'], watch: watch as D.PrinterObservations['watch'] } };
  const platform = { runtime, preferences: { load: async () => preferences, save: async (next: UserPreferences) => { preferences = next; } }, printers: { service } } as unknown as PlatformCapabilities;
  useDeviceSelectionStore.getState().setCurrent(connected ? 'device' : null);
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container); roots.push(root);
  await act(async () => root.render(<PlatformProvider value={platform}><PrepareSynchronization sceneInteraction={null} /></PlatformProvider>));
  return { container, runtime, read, watch, printer, preferences: () => preferences, disconnect: () => { stale = true; wake?.(); } };
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function start(kind: 'printer' | 'filament') { await act(async () => { requestPrepareSynchronization(kind); await flush(); }); }
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === text); expect(button).toBeTruthy();
  await act(async () => { button!.click(); await flush(); });
}
describe('Prepare synchronization workflow', () => {
  it('uses the connected device, directly commits Printer once and leaves it when declining Filament', async () => {
    const f = await fixture(); const synchronize = vi.spyOn(f.runtime, 'synchronizePrinter');
    await start('printer');
    expect(synchronize).toHaveBeenCalledOnce();
    expect(f.container.textContent).toContain('Printer synchronized.');
    expect(f.container.textContent).not.toContain('Preview');
    expect(f.preferences().rememberedNozzleCapacities?.['Bambu Lab X1 Carbon 0.4 nozzle']).toEqual([2]);
    await click(f.container, 'Done'); expect(f.container.querySelector('[role="dialog"]')).toBeNull();
    expect((await f.runtime.getHistoryStatus()).undoEntries).toHaveLength(1);
  });
  it('opens a chooser when disconnected and keeps connection selection after cancelling material review', async () => {
    const f = await fixture({ connected: false }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(f.container.querySelector('select[aria-label="Synchronization device"]')).toBeTruthy();
    expect(f.read).not.toHaveBeenCalled();
    await click(f.container, 'Connect and sync');
    expect(f.container.querySelector('select[aria-label="Filament sync mode"]')?.getAttribute('value') ?? (f.container.querySelector('select[aria-label="Filament sync mode"]') as HTMLSelectElement).value).toBe('rebuild');
    expect(f.container.textContent).toContain('empty'); expect(f.container.textContent).toContain('unknown');
    await click(f.container, 'Cancel');
    expect(apply).not.toHaveBeenCalled(); expect(useDeviceSelectionStore.getState().currentPrinterId).toBe('device');
    expect(useDeviceSelectionStore.getState().requestedPrinterId).toBe('device');
    expect(useDeviceSelectionStore.getState().navigationRequestVersion).toBe(0);
  });
  it('keeps whole-project mapping through disconnect, refreshes the same source and applies one native batch', async () => {
    const f = await fixture({ stream: true, models: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament');
    const mode = f.container.querySelector<HTMLSelectElement>('select[aria-label="Filament sync mode"]')!; expect(mode.value).toBe('mapping');
    const inputs = [...f.container.querySelectorAll<HTMLSelectElement>('select[aria-label^="Source for material"]')]; expect(inputs).toHaveLength(2);
    await act(async () => { inputs.forEach(input => { input.value = 'source/0'; input.dispatchEvent(new Event('change', { bubbles: true })); }); f.disconnect(); await flush(); });
    const button = [...f.container.querySelectorAll('button')].find(b => b.textContent === 'Apply Filament sync')!;
    expect(button.disabled).toBe(true); expect(inputs.map(i => i.value)).toEqual(['source/0', 'source/0']);
    await click(f.container, 'Refresh device'); expect(button.disabled).toBe(false);
    expect(f.watch).toHaveBeenCalledOnce();
    expect(useProjectDialogStore.getState()).toMatchObject({ open: true, deviceObservationPaused: false });
    expect([...f.container.querySelectorAll<HTMLSelectElement>('select[aria-label^="Source for material"]')].map(i => i.value)).toEqual(['source/0', 'source/0']);
    await click(f.container, 'Apply Filament sync'); expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ mapping: ['source/0', 'source/0'] }));
    expect(f.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('supports an on-demand material-only agent without descriptor or background Monitor access', async () => {
    const f = await fixture({ materialOnly: true }); await start('filament');
    expect(f.container.textContent).toContain('Apply Filament sync'); expect(f.watch).not.toHaveBeenCalled();
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device').map(([r]) => r.topics)).toEqual([['materials']]);
  });
  it('offers Printer sync on a standalone material model mismatch without mutating the project', async () => {
    const f = await fixture({ model: 'P1S' }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(f.container.textContent).toContain('Sync Printer first'); expect(apply).not.toHaveBeenCalled();
    await click(f.container, 'Cancel'); expect((await f.runtime.getProfileSnapshot())).toMatchObject({ printer: { name: 'Bambu Lab X1 Carbon 0.4 nozzle' } });
  });
  it('automatically uses the connected route instead of choosing the first configured route', async () => {
    const f = await fixture({ secondary: true }); await start('filament');
    expect(f.container.querySelector('select[aria-label="Synchronization device"]')).toBeNull();
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device').map(([r]) => r.target.routeId)).toEqual(['second-route']);
    expect(f.container.textContent).toContain('Apply Filament sync');
  });

});
