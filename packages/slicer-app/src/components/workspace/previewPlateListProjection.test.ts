import type { PlateSessionSnapshot } from '@slicer/client';
import { describe, expect, it } from 'vitest';
import { projectPreviewPlateList } from './previewPlateListProjection';

const snapshot: PlateSessionSnapshot = {
  ok: true,
  version: 1,
  currentPlateId: 'b',
  plates: [
    { plateId: 'b', displayIndex: 1, origin: [264, 0, 0], name: 'Plate 2', instanceIds: [2], valid: true },
    { plateId: 'a', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [1], valid: true },
    { plateId: 'c', displayIndex: 2, origin: [0, 264, 0], name: 'Plate 3', instanceIds: [], valid: true },
    { plateId: 'd', displayIndex: 3, origin: [264, 264, 0], name: 'Plate 4', instanceIds: [4], valid: false, outOfBoundsInstanceIds: [4] },
  ],
  inputRevisions: { a: 4, b: 7, c: 1, d: 2 },
};

describe('Preview plate list projection', () => {
  it('orders by native display index and projects current, empty, invalid, and unsliced state', () => {
    const rows = projectPreviewPlateList(snapshot);
    expect(rows.map((row) => [row.plate.plateId, row.status, row.current])).toEqual([
      ['a', 'unsliced', false],
      ['b', 'unsliced', true],
      ['c', 'empty', false],
      ['d', 'out-of-bounds', false],
    ]);
  });

  it('marks only a result matching the authoritative input revision as sliced', () => {
    const rows = projectPreviewPlateList(snapshot, {
      a: { target: { plateId: 'a', inputRevision: 4 }, result: { layers: 2 } as any },
      b: { target: { plateId: 'b', inputRevision: 6 }, result: { layers: 2 } as any },
    });
    expect(rows.find((row) => row.plate.plateId === 'a')?.status).toBe('sliced');
    expect(rows.find((row) => row.plate.plateId === 'b')?.status).toBe('unsliced');
  });

  it('retains an inactive plate result when the current plate changes', () => {
    const result = { target: { plateId: 'a', inputRevision: 4 }, result: { layers: 2 } as any };
    const rows = projectPreviewPlateList({ ...snapshot, currentPlateId: 'a' }, { a: result });
    expect(rows.find((row) => row.plate.plateId === 'a')).toMatchObject({ current: true, status: 'sliced' });

    const afterSelection = projectPreviewPlateList({ ...snapshot, currentPlateId: 'b' }, { a: result });
    expect(afterSelection.find((row) => row.plate.plateId === 'a')).toMatchObject({ current: false, status: 'sliced' });
  });
});
