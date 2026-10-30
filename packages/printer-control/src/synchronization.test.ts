import { describe, expect, it, vi } from 'vitest';
import type * as D from './domain';
import { createMoonrakerService } from './service';
import { readSynchronizationSource, synchronizationSource, validateSynchronizationSource } from './synchronization';
const id = <K extends string>(value: string) => value as D.Id<K>;
const target: D.PrinterTarget = { printerId: id('printer'), routeId: id('route') };
const identity: D.PrinterIdentity = { id: target.printerId, displayName: 'Fixture', manufacturer: 'Fixture vendor', model: 'Three tools', serialNumber: null, externalRefs: [] };
const known = <T>(value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'fresh', sourceRouteId: target.routeId, receivedAtMs: 10, observedAtMs: null });
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
function snapshot(): D.PrinterSnapshot<'materials' | 'descriptor'> {
  const toolIds = ['opaque:C', 'opaque:A', 'opaque:Z'].map(value => id<'tool'>(value));
  const topology: D.MaterialTopology = {
    units: [{ id: id('feeder'), name: 'Five-slot feeder', kind: 'automatic-feeder', sensorIds: [] }],
    slots: Array.from({ length: 5 }, (_, i) => ({ id: id(`slot/${i}`), unitId: id('feeder'), name: `Supply ${i}` })),
    paths: Array.from({ length: 5 }, (_, i) => ({ id: id(`path/${i}`), slotId: id(`slot/${i}`), toolId: toolIds[i % 3], loading: 'automatic' })), dryers: [],
  };
  topology.paths = [...topology.paths, { ...topology.paths[0], id: id('alternative-path') }];
  const inventory: D.MaterialInventory = { topologyRevision: 'topology', topology, toolIds,
    state: { inventoryRevision: 'inventory', slots: topology.slots.map((slot, i) => ({ slotId: slot.id,
      presence: i === 0 ? known('empty' as const) : unknown,
      material: i === 4 ? unknown : known({ materialType: 'PLA', manufacturer: null, diameterMm: null,
        color: { kind: 'solid', rgba: '#AA0000FF' }, catalogRefs: [] }), spoolIdentity: unknown, remaining: unknown })), tools: [], dryers: [] } };
  const hardware: D.PrinterTopology = { revision: 'topology', completeness: 'complete', materials: topology, motionGroups: [], extruders: [],
    tools: toolIds.map((toolId, i) => ({ id: toolId, name: `Configured ${i}`, extruderId: id(`e${i}`), nozzleId: id(`n${i}`), motionGroupId: id('motion') })),
    nozzles: toolIds.map((_, i) => ({ id: id(`n${i}`), diameterMm: i === 1 ? 0.6 : 0.4, flowType: 'standard flow', constructionMaterial: null, type: null, heaterId: null })),
    heaters: [], fans: [], lights: [], cameras: [], sensors: [] };
  return { target, configurationRevision: 'configuration', values: {
    materials: known(inventory), descriptor: known({ revision: 'descriptor', identity, technology: 'fdm', firmware: unknown, buildVolume: null, topology: hardware }),
  } };
}
function inventory(s: ReturnType<typeof snapshot>) { if (s.values.materials?.kind !== 'known') throw new Error('fixture'); return s.values.materials.value; }
async function fixture(s = snapshot()) {
  const base = createMoonrakerService({ configuration: { load: async () => ({ version: 1, printers: [{ id: 'printer', displayName: 'Fixture', driverId: 'moonraker', apiBaseUrl: 'http://printer.local/', consoleUrl: '', apiKey: '' }] }), save: async () => {} },
    host: { id: id('host'), name: 'Host', execution: 'browser' }, transport: { request: vi.fn(async () => { throw new Error('Must not probe'); }) } });
  const saved = await base.listSaved(); if (!saved.ok) throw new Error('fixture');
  // Use an ordinary route shape, with only the observation support required by this fixture.
  const route: D.PrinterRoute = { id: target.routeId, printerId: target.printerId, providerId: id('fixture'), label: 'On demand', configurationRevision: 'configuration',
    configuration: { typeId: id('fixture'), hostId: id('host'), channel: 'lan', address: 'printer.local', webInterfaceUrl: null, credentialRef: null },
    management: { rename: false, configure: false, forget: false }, capabilities: structuredClone(saved.value[0].routes[0].capabilities) };
  route.capabilities.observations.descriptor = { kind: 'unsupported', layer: 'adapter', reason: 'Materials only' };
  route.capabilities.observations.materials = { kind: 'supported', constraints: { delivery: ['on-demand'] } };
  const printer: D.SavedPrinter = { identity, routes: [route] };
  const read = vi.fn(async <K extends D.StateTopic>(request: D.ObservationRequest<K> & { source: 'cache' | 'device' }): Promise<D.Result<D.PrinterSnapshot<K>>> => ({
    ok: true, value: { target, configurationRevision: s.configurationRevision,
      values: Object.fromEntries(request.topics.filter(t => t in s.values).map(t => [t, s.values[t as 'descriptor' | 'materials']])) as D.ObservationValues<K> },
  }));
  const service: D.PrinterService = { ...base, listSaved: vi.fn(async () => ({ ok: true as const, value: [printer] })), observations: { ...base.observations, read: read as D.PrinterObservations['read'] } };
  return { service, read, printer, route, s };
}
describe('project synchronization source boundary', () => {
  it('retains arbitrary tool order and five-slot topology, counts distinct physical slots and includes retained empty/unknown metadata', () => {
    const result = synchronizationSource(snapshot(), identity, 'printer'); if (!result.ok) throw new Error(result.error.message);
    expect(result.value.tools.map(t => [t.id, t.diameterMm, t.capacity])).toEqual([['opaque:C', 0.4, 2], ['opaque:A', 0.6, 2], ['opaque:Z', 0.4, 1]]);
    expect(result.value.materials[0]).toMatchObject({ presence: 'empty', toolIndices: [0], metadata: { materialType: 'PLA' } });
    expect(result.value.materials[1]).toMatchObject({ presence: 'unknown', toolIndices: [1], metadata: { materialType: 'PLA' } });
    expect(result.value.materials[4].metadata).toBeNull();
  });
  it('rejects stale/cross-route observations, mismatched topology and dangling paths without mutating inputs', () => {
    const s = snapshot(), before = structuredClone(s);
    if (s.values.materials?.kind !== 'known') throw new Error('fixture');
    s.values.materials.freshness = 'stale'; expect(synchronizationSource(s, identity, 'printer').ok).toBe(false);
    s.values.materials.freshness = 'fresh'; s.values.materials.sourceRouteId = id('other'); expect(synchronizationSource(s, identity, 'printer').ok).toBe(false);
    const wrong = snapshot(); inventory(wrong).topologyRevision = 'changed'; expect(synchronizationSource(wrong, identity, 'printer').ok).toBe(false);
    const path = snapshot(); inventory(path).topology.paths = [{ ...inventory(path).topology.paths[0], slotId: id('absent') }];
    expect(synchronizationSource(path, identity, 'printer').ok).toBe(false);
    expect(synchronizationSource(before, identity, 'printer').ok).toBe(true);
  });
  it('supports a materials-only on-demand agent without requesting descriptor or Monitor topics', async () => {
    const f = await fixture(); const result = await readSynchronizationSource(f.service, f.printer, f.route, 'filament');
    expect(result.ok).toBe(true); expect(f.read).toHaveBeenCalledWith(expect.objectContaining({ topics: ['materials'], source: 'device' }), expect.anything());
    expect(await readSynchronizationSource(f.service, f.printer, f.route, 'printer')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(f.read).toHaveBeenCalledOnce();
  });
  it('rejects a provider response for another route even if its configuration token is equal', async () => {
    const f = await fixture();
    f.s.target = { ...target, routeId: id('other-route') };
    f.read.mockImplementationOnce(async () => ({ ok: true, value: f.s }));
    expect(await readSynchronizationSource(f.service, f.printer, f.route, 'filament')).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  });
  it('rejects edits to source configuration even with identical topology/inventory tokens, using cache-only confirmation', async () => {
    const f = await fixture(); const result = await readSynchronizationSource(f.service, f.printer, f.route, 'filament'); if (!result.ok) throw new Error('fixture');
    expect(await validateSynchronizationSource(f.service, result.value)).toEqual({ ok: true, value: null });
    expect(f.read).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'cache' }));
    f.route.configurationRevision = 'edited';
    expect(await validateSynchronizationSource(f.service, result.value)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect(f.read).toHaveBeenCalledTimes(2);
  });
});
