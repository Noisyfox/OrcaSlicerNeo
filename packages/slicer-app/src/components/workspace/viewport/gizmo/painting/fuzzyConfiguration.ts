import type { ModelObjectStructure, NativeScopedConfigSnapshot, OptionMetadata, PaintingSessionMetadata } from '@slicer/client';
import { projectScopedConfigurationFields } from '../../../settings/scopedConfigurationProjection';

/** Reuse the native scoped projection for each editable part. A whole-object
 * action does not erase more-specific part/modifier overrides. */
export function fuzzyConfigurationProjection(session: PaintingSessionMetadata | null, metadata: OptionMetadata | null,
  baseValues: Readonly<Record<string, string>>, snapshot: NativeScopedConfigSnapshot, structure: readonly ModelObjectStructure[] = []) {
  if (!session || !metadata?.fuzzy_skin) return [];
  const object = structure.find(object => object.id === session.objectId);
  const volumes = [...session.parts.map(part => ({ id: part.volumeId, modifier: false })),
    ...(object?.volumes.filter(volume => volume.type === 'parameter_modifier').map(volume => ({ id: volume.id, modifier: true })) ?? [])];
  return volumes.map(part => ({ volumeId: part.id, modifier: part.modifier, name: object?.volumes.find(volume => volume.id === part.id)?.name ?? `Part ${part.id}`, field: projectScopedConfigurationFields({
    mode: 'scoped', metadata: { fuzzy_skin: metadata.fuzzy_skin }, baseValues, snapshot,
    resolution: { scope: 'part', label: 'Painted part', visibleScopes: ['preset', 'project', 'object', 'part'],
      targets: [{ scope: 'part', id: String(part.id), objectId: String(session.objectId), label: 'Painted part' }] },
  }).find(field => field.key === 'fuzzy_skin') }));
}

export function fuzzyModeKnown(value: string | null | undefined): boolean {
  return ['none','external','hole','all','allwalls','disabled_fuzzy'].includes(value ?? '');
}

export function fuzzyModeLabel(value: string | null | undefined, metadata: OptionMetadata | null): string {
  const meta = metadata?.fuzzy_skin;
  const index = value ? meta?.enum_values?.indexOf(value) ?? -1 : -1;
  return (index >= 0 ? meta?.enum_labels?.[index] : undefined) ??
    ({none:'Painted only',external:'Contour',hole:'Hole',all:'Contour and hole',allwalls:'All walls',disabled_fuzzy:'Disabled'} as Record<string,string>)[value ?? ''] ?? 'Unavailable';
}
