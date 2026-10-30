/** Shared observation-to-project input boundary. No protocol, native preset policy or device writes. */
import type * as D from './domain';

export type SynchronizationKind = 'printer' | 'filament';
export interface SynchronizationSource {
  kind: SynchronizationKind;
  target: D.PrinterTarget;
  configurationRevision: D.Revision;
  topologyRevision: D.Revision;
  inventoryRevision: D.Revision;
  identity: D.PrinterIdentity;
  /** Normalized descriptor/tool order, never parsed from opaque device IDs. */
  tools: readonly {
    id: D.Id<'tool'>;
    name: string;
    diameterMm: number | null;
    flowType: string | null;
    flowReporting: D.Nozzle['flowReporting'];
    capacity: number;
  }[];
  materials: readonly {
    slotId: D.Id<'slot'>;
    label: string;
    unitKind: D.MaterialUnit['kind'];
    toolIndices: readonly number[];
    presence: 'present' | 'empty' | 'unknown';
    metadata: D.MaterialMetadata | null;
  }[];
}
const failure = (code: D.ErrorCode, message: string): D.Result<never> => ({ ok: false, error: { code, message } });
function fresh<T>(reading: D.Reading<T> | undefined, route: D.Id<'route'>): T | undefined {
  return reading?.kind === 'known' && reading.freshness === 'fresh' && reading.sourceRouteId === route ? reading.value : undefined;
}
/** A coherent material read is sufficient for a material-only agent; unrelated Monitor topics are optional. */
export function synchronizationSource(
  snapshot: D.PrinterSnapshot<'descriptor' | 'materials'>, identity: D.PrinterIdentity, kind: SynchronizationKind,
): D.Result<SynchronizationSource> {
  if (!snapshot.configurationRevision) return failure('stale-context', 'Synchronization configuration has no revision.');
  if (snapshot.target.printerId !== identity.id) return failure('stale-context', 'Synchronization device changed.');
  const route = snapshot.target.routeId;
  const inventory = fresh(snapshot.values.materials, route);
  const descriptor = fresh(snapshot.values.descriptor, route);
  if (!inventory || kind === 'printer' && !descriptor) return failure('offline', 'Current synchronization observations are unavailable.');
  if (descriptor && (descriptor.identity.id !== identity.id || descriptor.topology.revision !== inventory.topologyRevision))
    return failure('stale-context', 'Hardware and material observations do not describe the same topology.');
  const topology = inventory.topology;
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  if (!unique(topology.slots.map(s => s.id)) || !unique(topology.units.map(u => u.id)) || !unique(inventory.toolIds)
    || !unique(inventory.state.slots.map(s => s.slotId))) return failure('invalid-request', 'Duplicate synchronization resource identity.');
  const ordered = descriptor?.topology.tools.map(t => ({ id: t.id, name: t.name, nozzle: descriptor.topology.nozzles.find(n => n.id === t.nozzleId) }))
    ?? inventory.toolIds.map(id => ({ id, name: id, nozzle: undefined }));
  if (!unique(ordered.map(t => t.id)) || ordered.some(t => !inventory.toolIds.includes(t.id)))
    return failure('invalid-request', 'Synchronization tool references are inconsistent.');
  const tools = ordered.map(tool => ({ id: tool.id, name: tool.name, diameterMm: tool.nozzle?.diameterMm || null,
    flowType: tool.nozzle?.flowType ?? null, flowReporting: tool.nozzle?.flowReporting ?? 'unknown',
    capacity: Math.max(1, new Set(topology.paths.filter(p => p.toolId === tool.id).map(p => p.slotId)).size),
  }));
  if (topology.paths.some(p => !tools.some(t => t.id === p.toolId) || !topology.slots.some(s => s.id === p.slotId)))
    return failure('invalid-request', 'Material paths refer to unavailable resources.');
  const materials: SynchronizationSource['materials'][number][] = [];
  for (const slot of topology.slots) {
    const unit = topology.units.find(u => u.id === slot.unitId);
    if (!unit) return failure('invalid-request', 'Material slot has no supply unit.');
    const state = inventory.state.slots.find(s => s.slotId === slot.id);
    const metadata = fresh(state?.material, route);
    materials.push({ slotId: slot.id, label: `${unit.name} · ${slot.name}`, unitKind: unit.kind,
      toolIndices: tools.flatMap((tool, index) => topology.paths.some(p => p.slotId === slot.id && p.toolId === tool.id) ? [index] : []),
      presence: fresh(state?.presence, route) ?? 'unknown', metadata: metadata ?? null });
  }
  return { ok: true, value: { kind, target: { ...snapshot.target }, configurationRevision: snapshot.configurationRevision,
    topologyRevision: inventory.topologyRevision, inventoryRevision: inventory.state.inventoryRevision,
    identity: descriptor?.identity ?? identity, tools, materials } };
}
export async function readSynchronizationSource(
  service: D.PrinterService, printer: D.SavedPrinter, route: D.PrinterRoute, kind: SynchronizationKind, signal?: AbortSignal,
): Promise<D.Result<SynchronizationSource>> {
  if (route.printerId !== printer.identity.id) return failure('invalid-target', 'Synchronization route does not belong to this printer.');
  const topics: ['materials', ...('descriptor' | 'materials')[]] = ['materials'];
  if (kind === 'printer' || route.capabilities.observations.descriptor.kind === 'supported') topics.push('descriptor');
  if (topics.some(topic => route.capabilities.observations[topic].kind !== 'supported'))
    return failure('unsupported', 'This route does not provide the required synchronization observations.');
  const result = await service.observations.read({ target: { printerId: printer.identity.id, routeId: route.id }, topics, source: 'device' }, { signal });
  if (!result.ok) return result;
  if (result.value.target.printerId !== printer.identity.id || result.value.target.routeId !== route.id
    || result.value.configurationRevision !== route.configurationRevision) return failure('stale-context', 'Printer connection settings changed.');
  return synchronizationSource(result.value, printer.identity, kind);
}
/** Confirmation checks local catalogue/cache only; never starts another device read or connection. */
export async function validateSynchronizationSource(service: D.PrinterService, source: SynchronizationSource): Promise<D.Result<null>> {
  const saved = await service.listSaved();
  if (!saved.ok) return saved;
  const route = saved.value.find(p => p.identity.id === source.target.printerId)?.routes.find(r => r.id === source.target.routeId);
  if (!route || route.configurationRevision !== source.configurationRevision) return failure('stale-context', 'Synchronization connection settings changed.');
  const snapshot = await service.observations.read({ target: source.target, topics: ['materials'], source: 'cache' });
  if (!snapshot.ok) return snapshot;
  const inventory = fresh(snapshot.value.values.materials, source.target.routeId);
  if (!inventory || snapshot.value.configurationRevision !== source.configurationRevision
    || inventory.topologyRevision !== source.topologyRevision || inventory.state.inventoryRevision !== source.inventoryRevision)
    return failure('stale-context', 'Synchronization inventory changed; refresh before applying.');
  return { ok: true, value: null };
}
