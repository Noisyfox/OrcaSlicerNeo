import type { FilamentAssignmentTargetRequest, FilamentSessionSnapshot } from '@slicer/client';
import type { SelectionProjection } from './projection';

export type FilamentSelectionTarget =
  | { kind: 'object'; id: number }
  | { kind: 'part'; id: number };

export function assignmentTargetsForSelection(
  target: FilamentSelectionTarget,
  selection: SelectionProjection,
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
  return ids.map((id) => ({ kind: 'model-part' as const, id }));
}

export function assignmentForRow(
  snapshot: FilamentSessionSnapshot | null,
  kind: 'object' | 'part',
  id: number,
) {
  const entries = kind === 'object' ? snapshot?.assignments.objects : snapshot?.assignments.parts;
  return entries?.find((entry) => entry.id === id);
}

export function assignmentSlotOptions(snapshot: FilamentSessionSnapshot | null): number[] {
  return snapshot?.slots.map((entry) => entry.slot) ?? [];
}
