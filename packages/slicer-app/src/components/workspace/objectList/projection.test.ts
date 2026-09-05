import { describe, expect, it } from 'vitest';
import type { ModelObjectStructure } from '@slicer/client';
import { buildSelectableRows, objectListValidity, projectObjectGroups, projectSelection } from './projection';
import type { PlateSessionSnapshot } from '@slicer/client';

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
  it('highlights only a part row when a single part is selected', () => {
    const p = projectSelection(structure, [{ objectIdx: 0, volumeIdx: 0, instanceIdx: 0 }]);
    expect([...p.objectIds]).toEqual([]);
    expect([...p.volumeIds]).toEqual([10]);
    expect([...p.instanceIds]).toEqual([]);
  });

  it('highlights only the object rows when whole objects are selected', () => {
    const p = projectSelection(structure, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 },
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 },
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 1 },
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 1 },
    ]);
    expect([...p.objectIds]).toEqual([1]);
    expect([...p.volumeIds]).toEqual([]);
    expect([...p.instanceIds]).toEqual([]);
  });

  it('highlights the instance rows when a full object is selected via its Instances group', () => {
    const p = projectSelection(
      structure,
      [
        { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 },
        { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 },
        { objectIdx: 0, volumeIdx: 0, instanceIdx: 1 },
        { objectIdx: 0, volumeIdx: 1, instanceIdx: 1 },
      ],
      { 0: 'instances' },
    );
    expect([...p.objectIds]).toEqual([]);
    expect([...p.volumeIds]).toEqual([]);
    expect([...p.instanceIds]).toEqual([20, 21]);
  });

  it('highlights only the instance rows when a whole instance is selected', () => {
    const p = projectSelection(structure, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 },
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 },
    ]);
    expect([...p.objectIds]).toEqual([]);
    expect([...p.volumeIds]).toEqual([]);
    expect([...p.instanceIds]).toEqual([20]);
  });

  it('highlights the object row for each fully-selected object in a multi-object selection', () => {
    const p = projectSelection(structure, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 },
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 },
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 1 },
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 1 },
      { objectIdx: 1, volumeIdx: 0, instanceIdx: 0 },
    ]);
    expect([...p.objectIds].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...p.volumeIds]).toEqual([]);
    expect([...p.instanceIds]).toEqual([]);
  });

  it('highlights a full instance and a full object at their own most-relative rows', () => {
    // A full instance of object 0 (both volumes, instance 0) plus the whole
    // single-part object 1: both are Instance-mode and mixable. Object 0 is not
    // fully selected (only one of its two instances), so it highlights its
    // instance row; object 1 is fully selected, so it highlights its object row.
    const p = projectSelection(structure, [
      { objectIdx: 0, volumeIdx: 0, instanceIdx: 0 },
      { objectIdx: 0, volumeIdx: 1, instanceIdx: 0 },
      { objectIdx: 1, volumeIdx: 0, instanceIdx: 0 },
    ]);
    expect([...p.objectIds]).toEqual([2]);
    expect([...p.volumeIds]).toEqual([]);
    expect([...p.instanceIds]).toEqual([20]);
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
    expect([...before.volumeIds]).toEqual([...after.volumeIds]);
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

describe('projectObjectGroups', () => {
  const snapshot: PlateSessionSnapshot = {
    ok: true,
    version: 1,
    currentPlateId: 'plate-1',
    plates: [
      { plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', valid: true },
      { plateId: 'plate-2', displayIndex: 1, origin: [240, 0, 0], name: 'Plate 2', valid: false },
    ],
    instances: [
      { instanceId: 20, objectId: 1, objectIndex: 0, instanceIndex: 0, plateId: 'plate-2', member: true, unprintable: false, outOfBounds: false },
      // The second instance is on another plate, but the object remains in the
      // first-instance group by design.
      { instanceId: 21, objectId: 1, objectIndex: 0, instanceIndex: 1, plateId: 'plate-1', member: true, unprintable: false, outOfBounds: false },
      { instanceId: 22, objectId: 2, objectIndex: 1, instanceIndex: 0, plateId: '', member: false, unprintable: true, outOfBounds: false },
    ],
  };

  it('keeps empty plates and groups multi-instance objects by their first instance', () => {
    const groups = projectObjectGroups(structure, snapshot);
    expect(groups.map((group) => [group.label, group.objects.map((object) => object.id)])).toEqual([
      ['Plate 1', []],
      ['Plate 2', [1]],
      ['Unprintable', [2]],
    ]);
  });

  it('projects validity independently from first-instance grouping', () => {
    expect(objectListValidity(structure[0], snapshot)).toBe('valid');
    expect(objectListValidity(structure[1], snapshot)).toBe('unprintable');
    const outOfBounds = {
      ...snapshot,
      instances: snapshot.instances?.map((instance) => instance.instanceId === 21
        ? { ...instance, outOfBounds: true }
        : instance),
    };
    expect(objectListValidity(structure[0], outOfBounds)).toBe('out-of-bounds');
  });
});
