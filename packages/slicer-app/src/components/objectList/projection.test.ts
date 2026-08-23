import { describe, expect, it } from 'vitest';
import type { ModelObjectStructure } from '@slicer/client';
import { buildSelectableRows, projectSelection } from './projection';

const structure: ModelObjectStructure[] = [
  {
    id: 1, index: 0, name: 'Cube', printable: true, instanceCount: 2,
    volumes: [
      { id: 10, index: 0, name: 'Part 1', type: 'model_part', isSplittable: false },
      { id: 11, index: 1, name: 'Part 2', type: 'model_part', isSplittable: false },
    ],
    instances: [
      { id: 20, index: 0, printable: true },
      { id: 21, index: 1, printable: true },
    ],
  },
  {
    id: 2, index: 1, name: 'Cube2', printable: true, instanceCount: 1,
    volumes: [{ id: 12, index: 0, name: 'Part 1', type: 'model_part', isSplittable: false }],
    instances: [{ id: 22, index: 0, printable: true }],
  },
];

describe('projectSelection', () => {
  it('projects a selected instance onto its object/volume/instance IDs', () => {
    const p = projectSelection(structure, [{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }]);
    expect([...p.objectIds]).toEqual([1]);
    expect([...p.volumeIds]).toEqual([10]);
    expect([...p.instanceIds]).toEqual([20]);
  });

  it('projects several selected volumes', () => {
    const p = projectSelection(structure, [
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 1 },
      { objectIdx: 1, volumeIdx: 0, instanceIdx: 0 },
    ]);
    expect([...p.objectIds].sort()).toEqual([1, 2]);
    expect([...p.volumeIds].sort()).toEqual([11, 12]);
    expect([...p.instanceIds].sort()).toEqual([21, 22]);
  });

  it('ignores indices that are out of range for the current structure', () => {
    const p = projectSelection(structure, [{ objectIdx: 9, volumeIdx: 0, instanceIdx: 0 }]);
    expect([...p.objectIds]).toEqual([]);
    expect([...p.volumeIds]).toEqual([]);
    expect([...p.instanceIds]).toEqual([]);
  });

  it('returns a stable selection projection after a reload', () => {
    const before = projectSelection(structure, [{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }]);
    const after = projectSelection(structure, [{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }]);
    expect([...before.objectIds]).toEqual([...after.objectIds]);
  });
});

describe('buildSelectableRows', () => {
  it('produces the tree reading order with the row volume IDs', () => {
    const rows = buildSelectableRows(structure);
    expect(rows.map((r) => r.key)).toEqual([
      'obj:0',
      'vol:0:0', 'vol:0:1',
      'inst:0:0', 'inst:0:1',
      'obj:1',
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['object', 'part', 'part', 'instance', 'instance', 'object']);
    // Object 0 selects every volume×instance; each part is anchored to instance
    // 0 (the static fallback; the ObjectList re-anchors to the selection's single
    // instance); each instance selects all volumes of that instance.
    expect(rows[0].volumeIds).toEqual(['0:0:0', '0:0:1', '0:1:0', '0:1:1']);
    expect(rows[1].volumeIds).toEqual(['0:0:0']);
    expect(rows[2].volumeIds).toEqual(['0:1:0']);
    expect(rows[3].volumeIds).toEqual(['0:0:0', '0:1:0']);
    // Single-part, single-instance object has no child rows.
    expect(rows[5].volumeIds).toEqual(['1:0:0']);
  });

  it('omits part/instance rows for single-part/single-instance objects', () => {
    const single: ModelObjectStructure[] = [{
      id: 1, index: 0, name: 'One', printable: true, instanceCount: 1,
      volumes: [{ id: 10, index: 0, name: 'Part', type: 'model_part', isSplittable: false }],
      instances: [{ id: 20, index: 0, printable: true }],
    }];
    expect(buildSelectableRows(single).map((r) => r.key)).toEqual(['obj:0']);
  });
});
