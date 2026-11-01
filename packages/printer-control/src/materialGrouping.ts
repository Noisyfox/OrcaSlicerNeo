import type * as D from './domain';

/** Advisory raw device materials. Project Sync deliberately uses a stricter source policy. */
export interface DeviceGroupingContext {
  identity: D.PrinterIdentity;
  toolCount: number;
  materials: {
    slotId: string; toolIndex: number; external: boolean; materialType: string;
    colour: string | null; catalogRefs: readonly D.ExternalRef[];
  }[];
}

export function deviceGroupingContext(snapshot: D.PrinterSnapshot, identity: D.PrinterIdentity): DeviceGroupingContext | null {
  const reading = snapshot.values.materials;
  if (snapshot.target.printerId !== identity.id || reading?.kind !== 'known' || reading.sourceRouteId !== snapshot.target.routeId) return null;
  // Stale same-source metadata is useful for advisory grouping, unlike commands/imports.
  const inventory = reading.value, topology = inventory.topology;
  const descriptor = snapshot.values.descriptor;
  const hardware = descriptor?.kind === 'known' && descriptor.sourceRouteId === snapshot.target.routeId
    && descriptor.value.identity.id === identity.id ? descriptor.value : null;
  if (hardware && hardware.topology.revision !== inventory.topologyRevision) return null;
  const tools = hardware?.topology.tools.map(t => t.id) ?? [...inventory.toolIds];
  const unique = (values: readonly string[]) => new Set(values).size === values.length;
  if (!unique(tools) || !unique(topology.slots.map(s => s.id)) || !unique(topology.units.map(u => u.id))
    || !unique(inventory.state.slots.map(s => s.slotId)) || tools.some(id => !inventory.toolIds.includes(id))
    || topology.paths.some(p => !tools.includes(p.toolId) || !topology.slots.some(s => s.id === p.slotId))) return null;
  const materials: DeviceGroupingContext['materials'] = [];
  for (const slot of topology.slots) {
    const unit = topology.units.find(u => u.id === slot.unitId);
    if (!unit) return null;
    const observed = inventory.state.slots.find(s => s.slotId === slot.id)?.material;
    const metadata = observed?.kind === 'known' && observed.sourceRouteId === snapshot.target.routeId ? observed.value : null;
    if (!metadata) continue;
    const color = metadata.color;
    const representative = !color ? null : color.kind === 'solid' ? color.rgba : color.representativeRgba;
    const colour = representative && /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(representative) ? representative.toUpperCase() : null;
    for (const [toolIndex, tool] of tools.entries()) {
      if (!topology.paths.some(p => p.slotId === slot.id && p.toolId === tool)) continue;
      materials.push({ slotId: slot.id, toolIndex, external: unit.kind === 'manual-holder',
        materialType: metadata.materialType ?? '', colour, catalogRefs: metadata.catalogRefs });
    }
  }
  return { identity: hardware?.identity ?? identity, toolCount: tools.length, materials };
}
