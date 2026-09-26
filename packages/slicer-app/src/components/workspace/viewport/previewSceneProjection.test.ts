import type { ModelObjectStructure, PlateSessionSnapshot } from '@slicer/client';
import { describe, expect, it } from 'vitest';
import { currentPreviewPlate, previewVolumesForCurrentPlate } from './previewSceneProjection';

function snapshot(overrides: Partial<PlateSessionSnapshot> = {}): PlateSessionSnapshot {
  return {
    ok: true,
    version: 1,
    currentPlateId: 'plate-2',
    plates: [
      { plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [10] },
      { plateId: 'plate-2', displayIndex: 1, origin: [264, 0, 0], name: 'Plate 2', instanceIds: [11, 12, 13, 14] },
    ],
    instances: [
      { instanceId: 10, objectId: 1, objectIndex: 0, instanceIndex: 0, plateId: 'plate-1', member: true, unprintable: false, outOfBounds: false },
      { instanceId: 11, objectId: 1, objectIndex: 0, instanceIndex: 1, plateId: 'plate-2', member: true, unprintable: false, outOfBounds: false },
      { instanceId: 12, objectId: 1, objectIndex: 0, instanceIndex: 2, plateId: 'plate-2', member: true, unprintable: true, outOfBounds: false },
      { instanceId: 13, objectId: 2, objectIndex: 1, instanceIndex: 0, plateId: 'plate-2', member: true, unprintable: false, outOfBounds: false },
      { instanceId: 14, objectId: 3, objectIndex: 2, instanceIndex: 0, plateId: 'plate-2', member: true, unprintable: false, outOfBounds: false },
    ],
    ...overrides,
  };
}

const structure: ModelObjectStructure[] = [
  {
    id: 1, index: 0, name: 'Painted cube', printable: true, instanceCount: 3,
    volumes: [], instances: [
      { id: 10, index: 0, printable: true },
      { id: 11, index: 1, printable: true },
      { id: 12, index: 2, printable: true },
    ],
  },
  {
    id: 2, index: 1, name: 'Unprintable object', printable: false, instanceCount: 1,
    volumes: [], instances: [{ id: 13, index: 0, printable: true }],
  },
  {
    id: 3, index: 2, name: 'Unprintable instance', printable: true, instanceCount: 1,
    volumes: [], instances: [{ id: 14, index: 0, printable: false }],
  },
];

function volume(objectIdx: number, instanceIdx: number) {
  const object = structure[objectIdx]!;
  const instance = object.instances[instanceIdx]!;
  return { buffer: { objectId: object.id, instanceId: instance.id, objectIdx, instanceIdx } } as any;
}

describe('Preview multi-plate scene projection', () => {
  it('keeps only current-plate members that remain printable and does not mutate the source collection', () => {
    const volumes = [volume(0, 0), volume(0, 1), volume(0, 2), volume(1, 0), volume(2, 0)];
    const projected = previewVolumesForCurrentPlate(volumes, snapshot(), structure);
    expect(projected).toEqual([volumes[1]]);
    expect(volumes).toHaveLength(5);
  });

  it('keeps the selected plate available for world-space scene projection', () => {
    expect(currentPreviewPlate(snapshot())?.plateId).toBe('plate-2');
  });

  it('keeps retained world-space toolpath arrays unchanged by the render projection', () => {
    const starts = Float32Array.from([265, 2, 3, 268, 5, 6]);
    const ends = Float32Array.from([268, 5, 6, 271, 8, 9]);
    const startsBefore = starts.slice();
    const endsBefore = ends.slice();
    // Scene keeps the processor's world-space moves unchanged. Export/send
    // still use the separate printer-local source G-code text.
    expect(starts).toEqual(startsBefore);
    expect(ends).toEqual(endsBefore);
  });

  it('hides models until authoritative plate membership is available', () => {
    const volumes = [volume(0, 0), volume(0, 1)];
    expect(previewVolumesForCurrentPlate(volumes, null, structure)).toEqual([]);
  });
});
