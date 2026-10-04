import type { FilamentAssignmentTargetRequest, FilamentSessionSnapshot, ModelObjectStructure } from '@slicer/client';
import type { SelectionProjection } from './projection';

export type FilamentSelectionTarget =
  | { kind: 'object'; id: number }
  | { kind: 'part'; id: number };

export function assignmentTargetsForSelection(
  target: FilamentSelectionTarget,
  selection: SelectionProjection,
  structure: readonly Pick<ModelObjectStructure, 'volumes'>[],
): FilamentAssignmentTargetRequest[] {
  if (target.kind === 'object') {
    const ids = selection.objectIds.has(target.id) && selection.objectIds.size > 0
      ? [...selection.objectIds]
      : [target.id];
    return ids.map((id) => ({ kind: 'object' as const, id }));
  }
  const ids = selection.volumeIds.has(target.id) && selection.volumeIds.size > 0
    ? [...selection.volumeIds]
    : [target.id];
  const volumes = new Map(structure.flatMap((object) => object.volumes).map((volume) => [volume.id, volume]));
  return ids.flatMap<FilamentAssignmentTargetRequest>((id) => {
    const type = volumes.get(id)?.type;
    return type === 'parameter_modifier' ? [{ kind: 'parameter-modifier', id }]
      : type === 'model_part' ? [{ kind: 'model-part', id }] : [];
  });
}

export function assignmentForRow(
  snapshot: FilamentSessionSnapshot | null,
  kind: 'object' | 'part',
  id: number,
) {
  return kind === 'object'
    ? snapshot?.assignments.objects.find((entry) => entry.id === id)
    : snapshot?.assignments.parts.find((entry) => entry.id === id)
      ?? snapshot?.assignments.modifiers.find((entry) => entry.id === id);
}

export function assignmentSlotOptions(snapshot: FilamentSessionSnapshot | null): number[] {
  return snapshot?.slots.map((entry) => entry.slot) ?? [];
}
