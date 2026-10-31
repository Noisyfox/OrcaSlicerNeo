import { afterEach, describe, expect, it } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { useDeviceSelectionStore as store } from './useDeviceSelectionStore';
const id = <K extends string>(value: string) => value as D.Id<K>;
function snapshot(): D.PrinterSnapshot<'descriptor'> {
  return { target: { printerId: id('printer'), routeId: id('route') }, configurationRevision: 'config', values: {
    descriptor: { kind: 'known', freshness: 'fresh', sourceRouteId: id('route'), receivedAtMs: 1, observedAtMs: null,
      value: { revision: 'topology', technology: 'fdm', firmware: { kind: 'unknown', reason: 'not-reported' }, buildVolume: null,
        topology: { revision: 'topology', completeness: 'partial', tools: [], nozzles: [], extruders: [], motionGroups: [], heaters: [], fans: [], lights: [], sensors: [], cameras: [], materials: { units: [], slots: [], paths: [], dryers: [] } }, identity: { id: id('printer'), displayName: 'Device', manufacturer: 'Vendor', model: 'Model', serialNumber: null, externalRefs: [] } } },
  } };
}
function materialSnapshot(): D.PrinterSnapshot<'descriptor' | 'materials'> {
  const next: D.PrinterSnapshot<'descriptor' | 'materials'> = snapshot();
  if (next.values.descriptor?.kind !== 'known') throw new Error('fixture');
  next.values.materials = { kind: 'known', freshness: 'fresh', sourceRouteId: id('route'), receivedAtMs: 1, observedAtMs: null,
    value: { topologyRevision: 'topology', topology: next.values.descriptor.value.topology.materials, toolIds: [],
      state: { inventoryRevision: 'inventory', slots: [], tools: [], dryers: [] } } };
  return next;
}
afterEach(() => store.setState({ connection: null, connectionOwner: null, materials: null, currentPrinterId: null,
  groupingSource: null, groupingContext: null, groupingVersion: 0, groupingReading: null, groupingFailedReading: null, groupingPullFailed: false }));

function groupingFixture() {
  const s = materialSnapshot();
  if (s.values.descriptor?.kind !== 'known' || s.values.materials?.kind !== 'known') throw new Error('fixture');
  const tool = id<'tool'>('opaque:tool');
  s.values.descriptor.value.topology.tools = [{ id: tool, name: 'Tool', extruderId: id('e'), nozzleId: id('n'), motionGroupId: id('m') }];
  const inventory = s.values.materials.value;
  inventory.toolIds = [tool];
  inventory.topology = { units: [{ id: id('unit'), name: 'Unit', kind: 'automatic-feeder', sensorIds: [] }],
    slots: [{ id: id('slot'), unitId: id('unit'), name: 'Slot' }], paths: [{ id: id('path'), slotId: id('slot'), toolId: tool, loading: 'automatic' }], dryers: [] };
  inventory.state.slots = [{ slotId: id('slot'), presence: { kind: 'unknown', reason: 'not-reported' }, remaining: { kind: 'unknown', reason: 'not-reported' }, spoolIdentity: { kind: 'unknown', reason: 'not-reported' },
    material: { kind: 'known', freshness: 'stale', sourceRouteId: s.target.routeId, receivedAtMs: 1, observedAtMs: null,
      value: { materialType: 'PLA', manufacturer: null, diameterMm: null, color: { kind: 'solid', rgba: '#FF0000' }, catalogRefs: [] } } }];
  const route = { id: s.target.routeId, configurationRevision: s.configurationRevision,
    capabilities: { observations: { materials: { kind: 'supported', constraints: { delivery: ['on-demand'] } } } } } as unknown as D.PrinterRoute;
  const printer: D.SavedPrinter = { identity: s.values.descriptor.value.identity, routes: [route] };
  store.getState().selectGroupingSource(printer, route);
  return { s, printer, route };
}

describe('advisory grouping session independent of live Sync evidence', () => {
  it('retains the selected identity without reported observation capabilities or a route', () => {
    const { printer } = groupingFixture();
    store.getState().selectGroupingSource(printer, null);
    expect(store.getState().groupingContext).toEqual({ identity: printer.identity, toolCount: 0, materials: [] });
    const version = store.getState().groupingVersion;
    store.getState().selectGroupingSource(printer, null);
    expect(store.getState().groupingVersion).toBe(version);
    store.getState().selectGroupingSource(null, null);
    expect(store.getState().groupingContext).toBeNull();
  });
  it('keeps stale materials and selected identity through observation loss without relaxing Sync evidence', () => {
    const { s } = groupingFixture(), owner = {};
    store.getState().publishConnection(owner, s);
    const previous = store.getState().groupingContext;
    expect(previous?.materials).toHaveLength(1);
    if (s.values.descriptor?.kind !== 'known' || s.values.materials?.kind !== 'known') throw new Error('fixture');
    s.values.descriptor.freshness = 'stale'; s.values.materials.freshness = 'stale';
    store.getState().publishConnection(owner, s);
    expect(store.getState().connection).toBeNull();
    expect(store.getState().groupingContext).toEqual(previous);
    store.getState().clearConnection({});
    expect(store.getState().groupingContext).toEqual(previous);
  });
  it('withdraws after explicit pull failure and does not revive the failed cached reading', () => {
    const { s } = groupingFixture(); store.getState().publishGrouping(s);
    store.getState().failGroupingPull(s.target, s.configurationRevision);
    expect(store.getState().groupingContext?.materials).toEqual([]);
    store.getState().publishGrouping(s);
    expect(store.getState().groupingContext?.materials).toEqual([]);
    if (s.values.materials?.kind !== 'known') throw new Error('fixture');
    s.values.materials.receivedAtMs = 2;
    store.getState().publishGrouping(s);
    expect(store.getState().groupingContext?.materials).toHaveLength(1);
  });
  it('withdraws an old configuration immediately and rejects late updates and failures', () => {
    const { s, printer, route } = groupingFixture(); store.getState().publishGrouping(s);
    store.getState().selectGroupingSource(printer, { ...route, configurationRevision: 'new' });
    expect(store.getState().groupingContext?.materials).toEqual([]);
    store.getState().publishGrouping(s);
    store.getState().failGroupingPull(s.target, s.configurationRevision);
    expect(store.getState().groupingContext?.materials).toEqual([]);
    store.getState().setCurrent('another');
    expect(store.getState().groupingContext).toBeNull();
  });
  it('requires a successful acquisition after failure before the first cached reading', () => {
    const { s } = groupingFixture();
    store.getState().failGroupingPull(s.target, s.configurationRevision);
    store.getState().publishGrouping(s);
    expect(store.getState().groupingContext?.materials).toEqual([]);
    store.getState().publishGrouping(s, true);
    expect(store.getState().groupingContext?.materials).toHaveLength(1);
    store.getState().failGroupingPull(s.target, s.configurationRevision);
    store.getState().publishGrouping(s, true);
    expect(store.getState().groupingContext?.materials).toHaveLength(1);
  });
});
describe('observed Device connection projection', () => {
  it('retains stable material observations and replaces them when the inventory changes', () => {
    const owner = {}, next = materialSnapshot();
    store.getState().publishConnection(owner, next);
    const previous = store.getState().materials;
    expect(previous).toMatchObject({ inventoryRevision: 'inventory' });
    store.getState().publishConnection(owner, structuredClone(next));
    expect(store.getState().materials).toBe(previous);
    if (next.values.materials?.kind !== 'known') throw new Error('fixture');
    next.values.materials.value.state.inventoryRevision = 'new-inventory';
    store.getState().publishConnection(owner, next);
    expect(store.getState().materials).toMatchObject({ inventoryRevision: 'new-inventory' });
    store.getState().clearConnection(owner);
    expect(store.getState().materials).toBeNull();
  });
  it.each(['stale', 'topology'] as const)('hides %s material evidence while retaining the connected model', reason => {
    const owner = {}, next = materialSnapshot();
    store.getState().publishConnection(owner, next);
    if (next.values.materials?.kind !== 'known' || next.values.descriptor?.kind !== 'known') throw new Error('fixture');
    if (reason === 'stale') next.values.materials.freshness = 'stale';
    else next.values.descriptor.value.topology.revision = 'changed';
    store.getState().publishConnection(owner, next);
    expect(store.getState().connection).not.toBeNull();
    expect(store.getState().materials).toBeNull();
  });
  it('retains stable model evidence across ordinary telemetry updates', () => {
    const owner = {}; store.getState().publishConnection(owner, snapshot());
    const connection = store.getState().connection;
    const next = snapshot(); if (next.values.descriptor?.kind === 'known') next.values.descriptor.receivedAtMs = 2;
    store.getState().publishConnection(owner, next);
    expect(store.getState().connection).toBe(connection);
    const stale = snapshot(); if (stale.values.descriptor?.kind === 'known') stale.values.descriptor.freshness = 'stale';
    store.getState().publishConnection(owner, stale);
    expect(store.getState().connection).toBeNull();
  });
  it('rejects cross-route evidence and does not let an old monitor cleanup erase its successor', () => {
    const old = {}, current = {}; store.getState().publishConnection(old, snapshot());
    store.getState().publishConnection(current, snapshot()); store.getState().clearConnection(old);
    expect(store.getState().connectionOwner).toBe(current);
    const wrong = snapshot(); if (wrong.values.descriptor?.kind === 'known') wrong.values.descriptor.sourceRouteId = id('other');
    store.getState().publishConnection(current, wrong);
    expect(store.getState().connection).toBeNull();
  });
  it('hides a retained hardware identity when live status becomes stale', () => {
    const owner = {}, next: D.PrinterSnapshot = snapshot();
    store.getState().publishConnection(owner, next);
    const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
    next.values.status = { kind: 'known', freshness: 'stale', sourceRouteId: id('route'), receivedAtMs: 1, observedAtMs: null,
      value: { operationalState: unknown, activeToolIds: unknown, actions: unknown, printStatus: {
        phase: unknown, name: unknown, progressFraction: unknown, remainingSeconds: unknown, taskId: unknown, stage: unknown,
        currentLayer: unknown, totalLayers: unknown, speedModeId: unknown,
      } } };
    store.getState().publishConnection(owner, next);
    expect(store.getState().connection).toBeNull();
  });
});
