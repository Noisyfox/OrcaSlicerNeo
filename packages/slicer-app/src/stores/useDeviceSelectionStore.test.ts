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
afterEach(() => store.setState({ connection: null, connectionOwner: null, materials: null }));
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
