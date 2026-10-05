import type { PlateSessionSnapshot } from '@slicer/client';
import { describe, expect, it } from 'vitest';
import { projectPreviewPlateList } from './previewPlateListProjection';

const snapshot: PlateSessionSnapshot = {
  instances: [],
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
  it('binds progress, failures and totals to their own plate and input revision', () => {
    const summary = { estimatedTimeSeconds: 1932, filamentLengthMeters: 2.79, filamentWeightGrams: 8.32 };
    const results = { a: { target: { plateId: 'a', inputRevision: 4 }, receipt: { plateId: 'a', inputStamp: 4, resultGeneration: '1', sliceTaskId: '1' }, warnings: [], summary } };
    const job = { target: { plateId: 'b', inputRevision: 7 }, progress: 45, text: 'Generating perimeters' };
    const rows = projectPreviewPlateList(snapshot, results, job);
    expect(rows[0]).toMatchObject({ status: 'sliced', summary });
    expect(rows[1]).toMatchObject({ status: 'slicing', progress: 45, progressText: job.text });
    expect(rows[1].summary).toBeUndefined();
    const failed = projectPreviewPlateList(snapshot, results, undefined, { b: { target: job.target, error: 'Invalid settings' } });
    expect(failed[1]).toMatchObject({ status: 'error', error: 'Invalid settings' });
    const edited = projectPreviewPlateList({ ...snapshot, inputRevisions: { ...snapshot.inputRevisions, a: 5, b: 8 } }, results, job, { b: { target: job.target, error: 'Old failure' } });
    expect(edited[0]).toMatchObject({ status: 'unsliced' });
    expect(edited[0].summary).toBeUndefined();
    expect(edited[1]).toMatchObject({ status: 'unsliced' });
    expect(edited[1].error).toBeUndefined();
  });
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
      a: { target: { plateId: 'a', inputRevision: 4 }, receipt: { plateId: 'a', inputStamp: 4, resultGeneration: '1', sliceTaskId: '1' }, warnings: [], summary: {} },
      b: { target: { plateId: 'b', inputRevision: 6 }, receipt: { plateId: 'b', inputStamp: 6, resultGeneration: '1', sliceTaskId: '2' }, warnings: [], summary: {} },
    });
    expect(rows.find((row) => row.plate.plateId === 'a')?.status).toBe('sliced');
    expect(rows.find((row) => row.plate.plateId === 'b')?.status).toBe('unsliced');
  });

  it('retains an inactive plate result when the current plate changes', () => {
    const result = { target: { plateId: 'a', inputRevision: 4 }, receipt: { plateId: 'a', inputStamp: 4, resultGeneration: '1', sliceTaskId: '1' }, warnings: [], summary: {} };
    const rows = projectPreviewPlateList({ ...snapshot, currentPlateId: 'a' }, { a: result });
    expect(rows.find((row) => row.plate.plateId === 'a')).toMatchObject({ current: true, status: 'sliced' });

    const afterSelection = projectPreviewPlateList({ ...snapshot, currentPlateId: 'b' }, { a: result });
    expect(afterSelection.find((row) => row.plate.plateId === 'a')).toMatchObject({ current: false, status: 'sliced' });
  });
});
