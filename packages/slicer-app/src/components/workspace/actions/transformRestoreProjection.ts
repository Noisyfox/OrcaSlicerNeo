import type { ModelStructureResult, TransformRestoreReceipt } from '@slicer/client';
import type { GLVolume } from '../viewport/GLVolume';

/**
 * Check that a native Move receipt still describes the retained renderer
 * collection.  This is intentionally stricter than an index-only lookup:
 * stable IDs must agree with the current Worker structure before any scene
 * transform is changed.
 */
export function isTransformRestoreProjectionCompatible(
  receipt: TransformRestoreReceipt,
  structure: ModelStructureResult,
  volumes: readonly GLVolume[],
): boolean {
  if (receipt.version !== 1 || (receipt.state !== 'before' && receipt.state !== 'after') ||
      !Number.isSafeInteger(receipt.beforeRevision) || receipt.beforeRevision < 0 ||
      !Number.isSafeInteger(receipt.afterRevision) || receipt.afterRevision < 0 ||
      receipt.afterRevision !== receipt.beforeRevision + 1 ||
      !Array.isArray(receipt.records) || receipt.records.length === 0 ||
      !structure.ok || !Array.isArray(structure.objects)) return false;
  const seen = new Set<string>();
  for (const record of receipt.records) {
    if (!Number.isSafeInteger(record.objectId) || record.objectId <= 0 ||
        !Number.isSafeInteger(record.volumeId) || record.volumeId <= 0 ||
        !Number.isSafeInteger(record.instanceId) || record.instanceId <= 0 ||
        !Number.isSafeInteger(record.objectIndex) || record.objectIndex < 0 ||
        !Number.isSafeInteger(record.volumeIndex) || record.volumeIndex < 0 ||
        !Number.isSafeInteger(record.instanceIndex) || record.instanceIndex < 0) return false;
    const key = `${record.objectIndex}:${record.volumeIndex}:${record.instanceIndex}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const object = structure.objects.find((candidate) => candidate.index === record.objectIndex);
    const volume = object?.volumes.find((candidate) => candidate.index === record.volumeIndex);
    const instance = object?.instances.find((candidate) => candidate.index === record.instanceIndex);
    if (!object || !volume || !instance || object.id !== record.objectId ||
        volume.id !== record.volumeId || instance.id !== record.instanceId) return false;
    const rendered = volumes.filter((candidate) => candidate.buffer.objectIdx === record.objectIndex &&
      candidate.buffer.volumeIdx === record.volumeIndex && candidate.buffer.instanceIdx === record.instanceIndex);
    if (rendered.length !== 1) return false;
    if (!validTransform(record.instanceTransform) || !validTransform(record.volumeTransform)) return false;
  }
  return true;
}

/** Apply a previously validated receipt atomically to existing GL volumes. */
export function applyTransformRestoreReceipt(
  receipt: TransformRestoreReceipt,
  structure: ModelStructureResult,
  volumes: readonly GLVolume[],
): boolean {
  if (!isTransformRestoreProjectionCompatible(receipt, structure, volumes)) return false;
  const byComposite = new Map(receipt.records.map((record) => [
    `${record.objectIndex}:${record.volumeIndex}:${record.instanceIndex}`, record,
  ]));
  const targets = volumes.filter((volume) => byComposite.has(
    `${volume.buffer.objectIdx}:${volume.buffer.volumeIdx}:${volume.buffer.instanceIdx}`,
  ));
  for (const volume of targets) {
    const record = byComposite.get(`${volume.buffer.objectIdx}:${volume.buffer.volumeIdx}:${volume.buffer.instanceIdx}`)!;
    volume.instanceTransform = structuredClone(record.instanceTransform);
    volume.volumeTransform = structuredClone(record.volumeTransform);
  }
  return true;
}

function validTransform(transform: unknown): boolean {
  if (!transform || typeof transform !== 'object') return false;
  const value = transform as Record<string, unknown>;
  const tuple = (entry: unknown, length: number): boolean =>
    Array.isArray(entry) && entry.length === length && entry.every((item) => typeof item === 'number' && Number.isFinite(item));
  return tuple(value.offset, 3) && tuple(value.rotation, 3) && tuple(value.scale, 3) &&
    tuple(value.mirror, 3) && (value.matrix === undefined || tuple(value.matrix, 16));
}
