import { describe, expect, it } from 'vitest';
import { compatiblePresetNames, filamentImpactSummary, effectiveAssignmentLabel } from './filamentRackProjection';
import type { FilamentSessionSnapshot } from '@slicer/client';

const snapshot = {
  ok: true, version: 1,
  slots: [
    { slot: 1, preset: { id: 'a', name: 'PLA' }, colour: { effective: '#112233', provenance: 'preset' } },
    { slot: 2, preset: { id: 'b', name: 'PETG' }, colour: { effective: '#445566', provenance: 'user' } },
  ],
  mappings: { filament: [1, 2], volume: [1, 0], nozzle: [2], filament2: [1], physicalExtruder: [0] },
  flushing: { matrix: [0], vector: [0], matrixDimension: 1, planeCount: 1, source: 'native' },
  capabilities: { minSlots: 1, maxSlots: 8, nozzleCount: 1, flexible: true, canAdd: true, canDelete: true, canMerge: true },
  assignments: {
    objects: [{ target: 'object', id: 10, objectId: 10, explicitSlot: 2, effectiveSlot: 2, inherited: false }],
    parts: [], modifiers: [],
  },
  revisions: { session: 3, project: 3, result: 0, plates: {} },
  status: { state: 'ready', error: null },
} as unknown as FilamentSessionSnapshot;

describe('filament rack projection', () => {
  it('preserves native candidate order and includes the current slot preset', () => {
    expect(compatiblePresetNames(snapshot, ['PLA', 'ABS'])).toEqual(['PLA', 'ABS', 'PETG']);
  });

  it('summarizes references before a destructive operation', () => {
    const impact = filamentImpactSummary(snapshot, 2, 1);
    expect(impact.assignmentCount).toBe(1);
    expect(impact.mappingCount).toBe(2);
    expect(impact.remapped).toBe(true);
  });

  it('labels Default and inherited values without reconstructing inheritance', () => {
    expect(effectiveAssignmentLabel(0, false)).toBe('Default');
    expect(effectiveAssignmentLabel(2, true)).toBe('2 (inherited)');
  });
});
