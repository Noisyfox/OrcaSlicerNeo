import { describe, expect, it } from 'vitest';
import type { ModelObjectBuffer, ModelStructureResult, TransformRestoreReceipt } from '@slicer/client';
import { GLVolume } from '../viewport/GLVolume';
import { applyTransformRestoreReceipt, isTransformRestoreProjectionCompatible } from './transformRestoreProjection';

const transform = (x: number) => ({ offset: [x, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], mirror: [1, 1, 1] as [number, number, number] });
const structure: ModelStructureResult = { ok: true, objects: [{ id: 11, index: 0, name: 'object', printable: true, instanceCount: 1,
  volumes: [{ id: 22, index: 0, name: 'part', type: 'model_part', isSplittable: true }],
  instances: [{ id: 33, index: 0, printable: true }] }] };
const receipt: TransformRestoreReceipt = { version: 1, state: 'before', beforeRevision: 4, afterRevision: 5,
  records: [{ objectId: 11, volumeId: 22, instanceId: 33, objectIndex: 0, volumeIndex: 0, instanceIndex: 0,
    instanceTransform: transform(7), volumeTransform: transform(2) }] };

function volume(): GLVolume {
  const buffer: ModelObjectBuffer = { objectId: 11, volumeId: 21, instanceId: 31,
    objectIdx: 0, volumeIdx: 0, instanceIdx: 0,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), vertexCount: 3,
    indices: new Uint32Array([0, 1, 2]), indexCount: 3, offset: [0, 0, 0],
    instanceTransform: transform(0), volumeTransform: transform(0) };
  return new GLVolume(buffer);
}

describe('transform restore projection', () => {
  it('applies a stable-ID receipt without replacing the retained volume', () => {
    const target = volume();
    expect(isTransformRestoreProjectionCompatible(receipt, structure, [target])).toBe(true);
    expect(applyTransformRestoreReceipt(receipt, structure, [target])).toBe(true);
    expect(target.instanceTransform.offset[0]).toBe(7);
    expect(target.volumeTransform.offset[0]).toBe(2);
    target.dispose();
  });

  it('rejects stale identity before changing any renderer transform', () => {
    const target = volume();
    const stale = { ...receipt, records: [{ ...receipt.records[0]!, volumeId: 99 }] };
    expect(applyTransformRestoreReceipt(stale, structure, [target])).toBe(false);
    expect(target.instanceTransform.offset[0]).toBe(0);
    target.dispose();
  });
});
