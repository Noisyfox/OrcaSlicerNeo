// @vitest-environment jsdom
import { act, StrictMode } from 'react';
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
import { useNotificationStore } from '@/stores/useNotificationStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
if (!window.PointerEvent) Object.defineProperty(window, 'PointerEvent', { value: MouseEvent });
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
  useNotificationStore.getState().reset();
});
async function fixture({ connected = true, model = 'X1 Carbon', stream = false, models = false, reviewModel = false, dirty = false, materialOnly = false, secondary = false, strict = false, unidentified = false, noIdentities = false, translucent = false } = {}) {
  let preferences: UserPreferences = structuredClone(DEFAULT_USER_PREFERENCES);
  const runtime = createClient(async () => createMockModule());
  if (models || reviewModel) await runtime.addShape('Cube', 'Other Plate model');
  if (models) {
    const initial = await runtime.getFilamentSessionSnapshot(); if (!initial.ok) throw new Error(initial.error);
    await runtime.addFilamentSlot({ version: 1, revision: initial.revisions.session });
  }
  if (dirty) {
    const rack = await runtime.getFilamentSessionSnapshot(), plates = await runtime.getPlateSessionSnapshot();
    if (!rack.ok || !plates.ok) throw new Error('fixture');
    const edited = await runtime.mutatePresetDraft({ action: 'set', kind: 'filament', canonicalName: rack.slots[0].preset.name,
      expectedRevision: rack.revisions.session, key: 'enable_pressure_advance', value: '1' }, {
      activePlateId: plates.currentPlateId, selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, gizmo: null, nativeScopedConfig: {},
    });
    if (!edited.ok) throw new Error(edited.error);
  }
  const profile = await runtime.getProfileSnapshot(); if (!profile.ok) throw new Error(profile.error);
  useSettingsStore.getState().hydrateProfileSnapshot(profile);
  await useFilamentSessionStore.getState().load(runtime);
  let stale = !connected;
  const base = createMoonrakerService({ configuration: { load: async () => ({ version: 1, printers: [{ id: 'device', displayName: 'Generic fixture', driverId: 'moonraker', apiBaseUrl: 'http://fixture.local/', consoleUrl: '', apiKey: '' }] }), save: async () => {} },
    host: { id: id('host'), name: 'Fixture', execution: 'browser' }, transport: { request: vi.fn(async () => { throw new Error('No hardware access'); }) } });
  const saved = await base.listSaved(); if (!saved.ok) throw new Error('fixture');
  const route: D.PrinterRoute = { ...saved.value[0].routes[0], id: target.routeId, printerId: target.printerId, configurationRevision: 'config' };
  route.capabilities.observations.descriptor = materialOnly ? { kind: 'unsupported', layer: 'adapter', reason: 'Material-only agent' }
    : { kind: 'supported', constraints: { delivery: stream ? ['push', 'on-demand'] : ['on-demand'] } };
  route.capabilities.observations.materials = { kind: 'supported', constraints: { delivery: stream ? ['push', 'on-demand'] : ['on-demand'] } };
  const printer: D.SavedPrinter = { identity: { id: target.printerId, displayName: 'Generic fixture', manufacturer: 'Bambu Lab', model, serialNumber: null, externalRefs: [] }, routes: secondary ? [route, { ...route, id: id('second-route') }] : [route] };
  const topology: D.MaterialTopology = { units: [{ id: id('feeder'), name: 'Feeder', kind: 'automatic-feeder', sensorIds: [] }],
    slots: [0, 1].map(i => ({ id: id(`source/${i}`), unitId: id('feeder'), name: `Tray ${i}` })),
    paths: [0, 1].map(i => ({ id: id(`path/${i}`), slotId: id(`source/${i}`), toolId: id('tool'), loading: 'automatic' })), dryers: [] };
  const snapshot = (): D.PrinterSnapshot<'materials' | 'descriptor'> => ({ target, configurationRevision: 'config', values: {
    materials: known({ topologyRevision: 'topology', topology, toolIds: [id('tool')], state: { inventoryRevision: 'inventory', tools: [], dryers: [], slots: topology.slots.map((s, i) => ({ slotId: s.id,
      presence: i ? unknown : known('empty' as const), material: known({ materialType: noIdentities || unidentified && i ? null : 'PLA', manufacturer: null, diameterMm: 1.75, catalogRefs: noIdentities || unidentified && i ? [] : [{ namespace: 'fixture', value: 'reported-PLA' }], color: { kind: 'solid', rgba: translucent ? '#00000000' : i ? '#445566' : '#123456' } }), remaining: unknown, spoolIdentity: unknown })) } }, stale),
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
  const app = <PlatformProvider value={platform}><PrepareSynchronization sceneInteraction={null} /></PlatformProvider>;
  await act(async () => root.render(strict ? <StrictMode>{app}</StrictMode> : app));
  return { container: document.body, runtime, read, watch, printer, preferences: () => preferences, disconnect: () => { stale = true; wake?.(); } };
}
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function start(kind: 'printer' | 'filament') { await act(async () => { requestPrepareSynchronization(kind); await flush(); }); }
async function click(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === text); expect(button).toBeTruthy();
  await act(async () => { button!.click(); await flush(); });
}
async function choose(trigger: HTMLElement, label: string) {
  await act(async () => { trigger.click(); await flush(); });
  const option = [...document.querySelectorAll<HTMLElement>('[data-slot="select-content"][data-open] [role="option"]')].find(o => o.textContent?.includes(label));
  expect(option).toBeTruthy();
  await act(async () => {
    option!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    option!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await flush();
  });
}
describe('Prepare synchronization workflow', () => {
  it('displays native append plans and discards an obsolete mapping response', async () => {
    const f = await fixture({ reviewModel: true });
    const prepare = f.runtime.prepareMaterialImport.bind(f.runtime);
    type Result = Awaited<ReturnType<typeof prepare>>;
    const pending: { mapping: readonly (string | null)[]; resolve(result: Result): void; result: Result }[] = [];
    vi.spyOn(f.runtime, 'prepareMaterialImport').mockImplementation(async request => {
      const result = await prepare(request);
      if (!request.mapping) return result;
      return new Promise(resolve => pending.push({ mapping: request.mapping!, resolve, result }));
    });
    await start('filament');
    const button = [...f.container.querySelectorAll('button')].find(b => b.textContent === 'Apply Filament sync')!;
    expect(button.disabled).toBe(true);
    const input = f.container.querySelector<HTMLElement>('[aria-label="Source for material 1"]')!;
    await choose(input, 'Keep unchanged');
    expect(pending).toHaveLength(2);
    await act(async () => {
      const latest = pending[1];
      if (!latest.result.ok) throw new Error(latest.result.error);
      latest.resolve({ ...latest.result, additions: ['source/1'] }); await flush();
    });
    // The native plan is authoritative even when it differs from a JS guess.
    expect(f.container.querySelector('[data-testid="sync-additions"]')?.textContent).toBe('Additions: Feeder · Tray 1');
    expect(button.disabled).toBe(false);
    await act(async () => {
      const obsolete = pending[0];
      if (!obsolete.result.ok) throw new Error(obsolete.result.error);
      obsolete.resolve({ ...obsolete.result, additions: [] }); await flush();
    });
    expect(f.container.querySelector('[data-testid="sync-additions"]')?.textContent).toBe('Additions: Feeder · Tray 1');
  });
  it('uses shared alpha swatches in source and result previews', async () => {
    const f = await fixture({ reviewModel: true, translucent: true }); await start('filament');
    for (const section of ['Device materials', 'Material synchronization mapping']) {
      const swatch = f.container.querySelector<HTMLElement>(`[aria-label="${section}"] [style*="--color-swatch-checkerboard"]`)!;
      expect(swatch).toBeTruthy();
      expect(swatch.style.backgroundColor).toBe('var(--color-swatch-background)');
      expect(swatch.style.backgroundImage).toContain('#00000000');
    }
  });
  it('directly imports into an empty clean project once under StrictMode without mounting details', async () => {
    const f = await fixture({ strict: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    const shown: Element[] = [];
    const observer = new MutationObserver(() => { const dialog = f.container.querySelector('[data-testid="prepare-synchronization-dialog"]'); if (dialog) shown.push(dialog); });
    observer.observe(f.container, { childList: true, subtree: true });
    await start('filament'); observer.disconnect();
    expect(shown).toHaveLength(0); expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ mode: 'rebuild', colourOnly: false }));
    expect((await f.runtime.getHistoryStatus()).undoEntries).toHaveLength(1);
    expect(useNotificationStore.getState().notifications.at(-1)).toMatchObject({ title: 'Filament synchronized', severity: 'warning' });
    await f.runtime.undoHistory(); expect((await f.runtime.getFilamentSessionSnapshot())).toMatchObject({ slots: [expect.anything()] });
  });
  it('retains details for a modified Filament draft even when every plate is empty', async () => {
    const f = await fixture({ dirty: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(f.container.textContent).toContain('Apply Filament sync'); expect(apply).not.toHaveBeenCalled();
  });
  it('keeps device selection necessary but bypasses material details after Connect and sync', async () => {
    const f = await fixture({ connected: false }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(f.container.querySelector('[aria-label="Synchronization device"]')).toBeTruthy();
    await click(f.container, 'Connect and sync');
    expect(apply).toHaveBeenCalledOnce(); expect(f.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('revalidates the direct source before committing without a confirmation dialog', async () => {
    const f = await fixture(); const prepare = f.runtime.prepareMaterialImport.bind(f.runtime);
    vi.spyOn(f.runtime, 'prepareMaterialImport').mockImplementation(async request => { const result = await prepare(request); f.disconnect(); return result; });
    const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(apply).not.toHaveBeenCalled();
    expect(f.container.textContent).toContain('Synchronization inventory changed');
    expect((await f.runtime.getHistoryStatus()).undoEntries).toHaveLength(0);
  });
  it('retains details when another plate has a model and the selected plate is empty', async () => {
    const f = await fixture({ reviewModel: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await f.runtime.addPlate();
    await start('filament'); expect(f.container.textContent).toContain('Apply Filament sync'); expect(apply).not.toHaveBeenCalled();
  });
  it('shows an error without importing when an empty project has no eligible device materials', async () => {
    const f = await fixture({ noIdentities: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(f.container.textContent).toContain('No eligible device materials');
    expect(apply).not.toHaveBeenCalled(); expect(f.container.textContent).not.toContain('Device materials');
  });
  it('disables both import modes when only unidentified metadata is available', async () => {
    const f = await fixture({ noIdentities: true, reviewModel: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament');
    await choose(f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Filament sync mode"]')!, 'Rebuild from device');
    const button = [...f.container.querySelectorAll('button')].find(b => b.textContent === 'Apply Filament sync')!;
    expect(button.disabled).toBe(true);
    await choose(f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Filament sync mode"]')!, 'Update project mapping');
    expect(button.disabled).toBe(true); expect(apply).not.toHaveBeenCalled();
  });
  it('does not require removal replacements when only colors are synchronized', async () => {
    const f = await fixture({ models: true, unidentified: true }); await start('filament');
    await choose(f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Filament sync mode"]')!, 'Rebuild from device');
    expect(f.container.querySelector('[aria-label="Replacement for material 2"]')).toBeTruthy();
    await act(async () => { f.container.querySelector<HTMLElement>('#filament-sync-colors')!.click(); await flush(); });
    expect(f.container.querySelector('[aria-label="Replacement for material 2"]')).toBeNull();
    const button = [...f.container.querySelectorAll('button')].find(b => b.textContent === 'Apply Filament sync')!;
    expect(button.disabled).toBe(false);
    await click(f.container, 'Apply Filament sync');
    const rack = await f.runtime.getFilamentSessionSnapshot(); if (!rack.ok) throw new Error(rack.error);
    expect(rack.slots).toHaveLength(2);
  });
  it('displays unidentified source metadata without importing it or offering it for mapping', async () => {
    const f = await fixture({ unidentified: true, reviewModel: true });
    await start('filament');
    expect(f.container.querySelector('[aria-label="Device materials"]')?.textContent).toContain('Tray 1');
    expect(f.container.querySelector('[aria-label="Device materials"]')?.textContent).toContain('Not eligible for synchronization');
    const review = f.container.querySelector('[aria-label="Material synchronization mapping"]')!;
    expect(review.textContent).toContain('Tray 0'); expect(review.textContent).not.toContain('Tray 1');
    await choose(f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Filament sync mode"]')!, 'Update project mapping');
    const input = f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Source for material 1"]')!;
    await act(async () => { input.click(); await flush(); });
    const options = [...document.querySelectorAll('[data-slot="select-content"][data-open] [role="option"]')].map(o => o.textContent);
    expect(options).toContain('Feeder · Tray 0'); expect(options).not.toContain('Feeder · Tray 1');
  });
  it('previews and commits colors only without growing a rebuild or enabling append', async () => {
    const f = await fixture({ reviewModel: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament');
    await choose(f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Filament sync mode"]')!, 'Rebuild from device');
    await act(async () => { f.container.querySelector<HTMLElement>('#filament-sync-colors')!.click(); await flush(); });
    const review = f.container.querySelector('[aria-label="Material synchronization mapping"]')!;
    expect(review.querySelectorAll('tbody tr')).toHaveLength(1);
    await choose(f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Filament sync mode"]')!, 'Update project mapping');
    expect(f.container.querySelector('#filament-sync-append')?.hasAttribute('disabled')).toBe(true);
    expect(f.container.querySelector('[data-testid="sync-additions"]')).toBeNull();
    await click(f.container, 'Apply Filament sync');
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ colourOnly: true, appendUnused: false }));
    const rack = await f.runtime.getFilamentSessionSnapshot();
    expect(rack).toMatchObject({ slots: [expect.anything()] });
  });
  it('commits Printer only once when development StrictMode replays effect setup', async () => {
    const f = await fixture({ strict: true }); const synchronize = vi.spyOn(f.runtime, 'synchronizePrinter');
    await start('printer');
    expect(f.container.textContent).toContain('Printer synchronized.');
    expect(f.container.textContent).not.toContain('Printer synchronization inputs changed');
    expect(synchronize).toHaveBeenCalledOnce();
    expect((await f.runtime.getHistoryStatus()).undoEntries).toHaveLength(1);
  });
  it('uses one live observation under StrictMode and only fetches on explicit Refresh', async () => {
    const f = await fixture({ strict: true, stream: true, reviewModel: true });
    await start('filament');
    expect(f.watch).toHaveBeenCalledOnce();
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device')).toHaveLength(0);
    expect(f.container.textContent).toContain('Apply Filament sync');
    await click(f.container, 'Refresh device');
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device')).toHaveLength(1);
    expect(f.watch).toHaveBeenCalledOnce();
    await click(f.container, 'Cancel');
    expect(f.watch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('shows model mismatch from the live cache and confirms Printer sync without a device round trip', async () => {
    const f = await fixture({ stream: true, model: 'P1S' });
    await start('printer');
    expect(f.container.textContent).toContain('Switch the project Printer to match this device?');
    expect((await f.runtime.getHistoryStatus()).undoEntries).toHaveLength(0);
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device')).toHaveLength(0);
    await click(f.container, 'Switch Printer and sync');
    expect(f.container.textContent).toContain('Printer synchronized.');
    expect((await f.runtime.getHistoryStatus()).undoEntries).toHaveLength(1);
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device')).toHaveLength(0);
  });
  it('rejects a live-cache Printer confirmation if the source disconnects before acceptance', async () => {
    const f = await fixture({ stream: true, model: 'P1S' });
    await start('printer');
    await act(async () => { f.disconnect(); await flush(); });
    await click(f.container, 'Switch Printer and sync');
    expect(f.container.textContent).toContain('Synchronization inventory changed');
    expect((await f.runtime.getHistoryStatus()).undoEntries).toHaveLength(0);
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device')).toHaveLength(0);
  });
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
    const f = await fixture({ connected: false, reviewModel: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(f.container.querySelector('[role="combobox"][aria-label="Synchronization device"]')).toBeTruthy();
    expect(f.read).not.toHaveBeenCalled();
    await click(f.container, 'Connect and sync');
    expect(f.container.querySelector('[role="combobox"][aria-label="Filament sync mode"]')?.textContent).toContain('Update project mapping');
    expect(f.container.textContent).toContain('empty'); expect(f.container.textContent).toContain('unknown');
    await click(f.container, 'Cancel');
    expect(apply).not.toHaveBeenCalled(); expect(useDeviceSelectionStore.getState().currentPrinterId).toBe('device');
    expect(useDeviceSelectionStore.getState().requestedPrinterId).toBe('device');
    expect(useDeviceSelectionStore.getState().navigationRequestVersion).toBe(0);
  });
  it('keeps whole-project mapping through disconnect, refreshes the same source and applies one native batch', async () => {
    const f = await fixture({ stream: true, models: true }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament');
    const mode = f.container.querySelector<HTMLElement>('[role="combobox"][aria-label="Filament sync mode"]')!; expect(mode.textContent).toContain('Update project mapping');
    const inputs = [...f.container.querySelectorAll<HTMLElement>('[role="combobox"][aria-label^="Source for material"]')]; expect(inputs).toHaveLength(2);
    for (const input of inputs) await choose(input, 'Feeder · Tray 1');
    await act(async () => { f.disconnect(); await flush(); });
    const button = [...f.container.querySelectorAll('button')].find(b => b.textContent === 'Apply Filament sync')!;
    expect(button.disabled).toBe(true); expect(inputs.map(i => i.querySelector('[data-slot="select-value"]')?.textContent)).toEqual(['Feeder · Tray 1', 'Feeder · Tray 1']);
    await click(f.container, 'Refresh device'); expect(button.disabled).toBe(false);
    expect(f.watch).toHaveBeenCalledOnce();
    expect(useProjectDialogStore.getState()).toMatchObject({ open: true, deviceObservationPaused: false });
    expect([...f.container.querySelectorAll<HTMLElement>('[role="combobox"][aria-label^="Source for material"]')].map(i => i.querySelector('[data-slot="select-value"]')?.textContent)).toEqual(['Feeder · Tray 1', 'Feeder · Tray 1']);
    await click(f.container, 'Apply Filament sync'); expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ mapping: ['source/1', 'source/1'] }));
    expect(f.container.querySelector('[role="dialog"]')).toBeNull();
  });
  it('supports an on-demand material-only agent without descriptor or background Monitor access', async () => {
    const f = await fixture({ materialOnly: true, reviewModel: true }); await start('filament');
    expect(f.container.textContent).toContain('Apply Filament sync'); expect(f.watch).not.toHaveBeenCalled();
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device').map(([r]) => r.topics)).toEqual([['materials']]);
  });
  it('offers Printer sync on a standalone material model mismatch without mutating the project', async () => {
    const f = await fixture({ model: 'P1S' }); const apply = vi.spyOn(f.runtime, 'applyMaterialImport');
    await start('filament'); expect(f.container.textContent).toContain('Sync Printer first'); expect(apply).not.toHaveBeenCalled();
    await click(f.container, 'Cancel'); expect((await f.runtime.getProfileSnapshot())).toMatchObject({ printer: { name: 'Bambu Lab X1 Carbon 0.4 nozzle' } });
  });
  it('automatically uses the connected route instead of choosing the first configured route', async () => {
    const f = await fixture({ secondary: true, reviewModel: true }); await start('filament');
    expect(f.container.querySelector('[role="combobox"][aria-label="Synchronization device"]')).toBeNull();
    expect(f.read.mock.calls.filter(([r]) => r.source === 'device').map(([r]) => r.target.routeId)).toEqual(['second-route']);
    expect(f.container.textContent).toContain('Apply Filament sync');
  });

});
