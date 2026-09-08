import type { FilamentSessionSnapshot, FilamentSessionSlot } from '@slicer/client';

export interface FilamentImpactSummary {
  slot: number;
  destination: number | null;
  assignmentCount: number;
  mappingCount: number;
  remapped: boolean;
}

export function slotByNumber(snapshot: FilamentSessionSnapshot | null, slot: number): FilamentSessionSlot | undefined {
  return snapshot?.slots.find((entry) => entry.slot === slot);
}

export function compatiblePresetNames(snapshot: FilamentSessionSnapshot | null, installed: readonly string[]): string[] {
  // The Worker supplies the effective slot state. Candidate names are the
  // already compatibility-filtered global profile list; preserve its order.
  const current = new Set(snapshot?.slots.map((slot) => slot.preset.name) ?? []);
  return [...new Set([...installed, ...current])];
}

export function filamentImpactSummary(
  snapshot: FilamentSessionSnapshot,
  source: number,
  destination: number | null,
): FilamentImpactSummary {
  const assignmentCount = [
    ...snapshot.assignments.objects,
    ...snapshot.assignments.parts,
    ...snapshot.assignments.modifiers,
  ].filter((entry) => entry.effectiveSlot === source || entry.explicitSlot === source).length;
  const mappingCount = (Object.values(snapshot.mappings) as readonly number[][]).reduce(
    (count, values) => count + values.filter((value: number) => value === source).length,
    0,
  );
  return { slot: source, destination, assignmentCount, mappingCount, remapped: destination !== null };
}

export function effectiveAssignmentLabel(slot: number, inherited: boolean): string {
  if (slot <= 0) return 'Default';
  return `${slot}${inherited ? ' (inherited)' : ''}`;
}
