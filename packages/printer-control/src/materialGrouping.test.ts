import { describe, expect, it } from 'vitest';
import type * as D from './domain';
import { deviceGroupingContext } from './materialGrouping';
const id = <K extends string>(value: string) => value as D.Id<K>;
const target: D.PrinterTarget = { printerId: id('printer'), routeId: id('route') };
const identity: D.PrinterIdentity = { id: target.printerId, displayName: 'Printer', manufacturer: null, model: 'H2D', serialNumber: null, externalRefs: [] };
const known = <T>(value: T): D.Reading<T> => ({ kind: 'known', value, freshness: 'stale', sourceRouteId: target.routeId, receivedAtMs: 1, observedAtMs: null });
const unknown = { kind: 'unknown', reason: 'not-reported' } as const;
function fixture(): D.PrinterSnapshot<'materials'> {
  return { target, configurationRevision: 'config', values: { materials: known({ topologyRevision: 'topology', toolIds: [id('opaque:right'), id('opaque:left')],
    topology: { units: [{ id: id('holder'), name: 'Spool', kind: 'manual-holder', sensorIds: [] }],
      slots: [{ id: id('supply'), unitId: id('holder'), name: 'Supply' }],
      paths: [0, 1].map(i => ({ id: id(`path/${i}`), slotId: id('supply'), toolId: id(i ? 'opaque:left' : 'opaque:right'), loading: 'manual' })), dryers: [] },
    state: { inventoryRevision: 'inventory', slots: [{ slotId: id('supply'), presence: known('empty' as const), remaining: unknown, spoolIdentity: unknown,
      material: known({ materialType: 'PLA', diameterMm: null, manufacturer: null, catalogRefs: [],
        color: { kind: 'multiple', rgba: ['#00FF00FF', '#0000FFFF'], representativeRgba: '#ff0000ff', appearance: 'parallel' as const } }) }], tools: [], dryers: [] } }) } };
}
describe('advisory native grouping materials', () => {
  it('retains stale/empty/no-catalogue supplies, representative color and opaque tool routing', () => {
    expect(deviceGroupingContext(fixture(), identity)).toMatchObject({ toolCount: 2, materials: [
      { toolIndex: 0, slotId: 'supply', external: true, colour: '#FF0000FF', catalogRefs: [] },
      { toolIndex: 1, slotId: 'supply', external: true, colour: '#FF0000FF', catalogRefs: [] },
    ] });
  });
  it('never substitutes a multi-color component for an unreported representative', () => {
    const s = fixture();
    if (s.values.materials?.kind !== 'known') throw new Error('fixture');
    const reading = s.values.materials.value.state.slots[0].material;
    if (reading.kind !== 'known' || reading.value?.color?.kind !== 'multiple') throw new Error('fixture');
    reading.value.color.representativeRgba = null;
    expect(deviceGroupingContext(s, identity)?.materials.map(m => m.colour)).toEqual([null, null]);
  });
  it('rejects cross-route metadata and invalid tool references instead of inventing routing', () => {
    const s = fixture(); if (s.values.materials?.kind !== 'known') throw new Error('fixture');
    s.values.materials.sourceRouteId = id('other');
    expect(deviceGroupingContext(s, identity)).toBeNull();
    const invalid = fixture(); if (invalid.values.materials?.kind !== 'known') throw new Error('fixture');
    invalid.values.materials.value.topology.paths = [{ id: id('wrong'), slotId: id('supply'), toolId: id('absent'), loading: 'manual' }];
    expect(deviceGroupingContext(invalid, identity)).toBeNull();
  });
});
