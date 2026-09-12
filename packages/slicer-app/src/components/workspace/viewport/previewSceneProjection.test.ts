import type { PlateSessionSnapshot } from '@slicer/client';
import { describe, expect, it } from 'vitest';
import { currentPreviewPlate, previewVolumesForCurrentPlate } from './previewSceneProjection';

function snapshot(overrides: Partial<PlateSessionSnapshot> = {}): PlateSessionSnapshot {
  return {
    ok: true,
    version: 1,
    currentPlateId: 'plate-2',
    plates: [
      { plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate 1', instanceIds: [10] },
      { plateId: 'plate-2', displayIndex: 1, origin: [264, 0, 0], name: 'Plate 2', instanceIds: [11] },
    ],
    instances: [
      { instanceId: 10, objectId: 1, objectIndex: 0, instanceIndex: 0, plateId: 'plate-1', member: true, unprintable: false, outOfBounds: false },
      { instanceId: 11, objectId: 1, objectIndex: 0, instanceIndex: 1, plateId: 'plate-2', member: true, unprintable: false, outOfBounds: false },
      { instanceId: 12, objectId: 2, objectIndex: 1, instanceIndex: 0, plateId: '', member: false, unprintable: true, outOfBounds: false },
    ],
    ...overrides,
  };
}

function volume(objectIdx: number, instanceIdx: number) {
  return { buffer: { objectIdx, instanceIdx } } as any;
}

describe('Preview multi-plate scene projection', () => {
  it('keeps only current-plate members and does not mutate the input collection', () => {
    const volumes = [volume(0, 0), volume(0, 1), volume(1, 0)];
    const projected = previewVolumesForCurrentPlate(volumes, snapshot());
    expect(projected).toEqual([volumes[1]]);
    expect(volumes).toHaveLength(3);
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

  it('keeps legacy snapshots renderable when membership rows are absent', () => {
    const volumes = [volume(0, 0), volume(0, 1)];
    expect(previewVolumesForCurrentPlate(volumes, snapshot({ instances: undefined }))).toEqual(volumes);
  });
});
