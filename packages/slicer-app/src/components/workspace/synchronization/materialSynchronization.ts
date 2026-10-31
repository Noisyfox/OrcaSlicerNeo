import type { SynchronizationSource } from '@orca/printer-control';
import type { FilamentSessionSnapshot, MaterialImportPreparation, MaterialImportSource } from '@slicer/client';

/** Device-native catalogue associations have already been normalized by the agent. */
export function materialImportSources(source: SynchronizationSource): MaterialImportSource[] {
  return source.materials.flatMap(slot => {
    const metadata = slot.metadata;
    if (!metadata || !slot.toolIndices.length) return [];
    const color = metadata.color;
    const colour: MaterialImportSource['colour'] = !color ? null : color.kind === 'solid'
      ? { kind: 'solid', color: color.rgba }
      : color.rgba.length < 2 ? color.rgba.length ? { kind: 'solid', color: color.rgba[0] } : null
      : { kind: color.appearance === 'gradient' ? 'linear-gradient' : 'parallel', colors: color.rgba };
    return [{ slotId: slot.slotId, catalogRefs: metadata.catalogRefs, materialType: metadata.materialType ?? '', colour, toolIndices: slot.toolIndices }];
  });
}
export type PreparedMaterials = Extract<MaterialImportPreparation, { ok: true }>;
export function suggestMaterialMapping(source: SynchronizationSource, prepared: PreparedMaterials, rack: FilamentSessionSnapshot): (string | null)[] {
  return rack.slots.map((slot, i) => {
    const tool = rack.mappings.filament[i] - 1;
    const candidates = source.materials.filter(s => prepared.sources.some(p => p.slotId === s.slotId && p.matches[i]?.preset)
      && s.toolIndices.includes(tool));
    const color = slot.colour.effective.toLowerCase();
    // Orca's initial suggestion prefers the same material/preset and color, then type.
    const sameType = (s: SynchronizationSource['materials'][number]) => !!s.metadata?.materialType && s.metadata.materialType.toLowerCase() === prepared.projectTypes[i]?.toLowerCase();
    const same = (s: SynchronizationSource['materials'][number]) => prepared.sources.find(p => p.slotId === s.slotId)?.matches[i]?.preset === slot.preset.name;
    return (candidates.find(s => sameType(s) && same(s) && s.metadata?.color?.kind === 'solid' && s.metadata.color.rgba.toLowerCase() === color)
      ?? candidates.find(s => sameType(s) && same(s)) ?? candidates.find(sameType))?.slotId ?? null;
  });
}
export function displayedMaterialMatch(prepared: PreparedMaterials, sourceId: string, projectIndex: number) {
  const source = prepared.sources.find(s => s.slotId === sourceId);
  return source?.matches[projectIndex] ?? source;
}
