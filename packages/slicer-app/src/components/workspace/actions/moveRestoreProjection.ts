import type { HistoryContext, PlateSessionSnapshot, TransformRestoreReceipt } from '@slicer/client';

/**
 * A Move receipt carries transforms, not plate metadata. It may skip the
 * Worker session read when the native-canonical target context proves that
 * the retained model/session is the same structure and that every session
 * change is attributable to one of the receipt's affected instances. The
 * target session is then published atomically; tower projection is refreshed
 * separately when this model move can change its eligibility.
 */
export function moveRestoreSessionProof(
  context: HistoryContext,
  retained: PlateSessionSnapshot | null,
  retainedOverlay?: unknown,
  receipt?: TransformRestoreReceipt,
): PlateSessionSnapshot | null {
  return moveRestoreSessionProofResult(context, retained, retainedOverlay, receipt).session;
}

export interface MoveRestoreSessionProofResult {
  readonly session: PlateSessionSnapshot | null;
  /** Bounded field/condition label; never contains project payload. */
  readonly failure: string | null;
}

export function moveRestoreSessionProofResult(
  context: HistoryContext,
  retained: PlateSessionSnapshot | null,
  retainedOverlay?: unknown,
  receipt?: TransformRestoreReceipt,
): MoveRestoreSessionProofResult {
  const fail = (failure: string): MoveRestoreSessionProofResult => ({ session: null, failure });
  const target = context.plateSession;
  if (!retained) return fail('retained-session-missing');
  if (!target) return fail('context-session-missing');
  if (retained.ok !== true || target.ok !== true || retained.version !== 1 || target.version !== 1)
    return fail('session-version-or-envelope');
  if (!Array.isArray(retained.plates) || !Array.isArray(target.plates)) return fail('plates-not-arrays');
  if (!Array.isArray(retained.instances) || !Array.isArray(target.instances)) return fail('instances-not-arrays');
  if (!retained.inputRevisions || !target.inputRevisions) return fail('input-revisions-missing');
  if (!Array.isArray(retained.instanceTransforms) || !Array.isArray(target.instanceTransforms)) return fail('transforms-not-arrays');
  if (!receipt) return fail('transform-receipt-missing');
  if (receipt.version !== 1 || (receipt.state !== 'before' && receipt.state !== 'after') ||
      !Number.isSafeInteger(receipt.beforeRevision) || receipt.beforeRevision < 0 ||
      !Number.isSafeInteger(receipt.afterRevision) || receipt.afterRevision !== receipt.beforeRevision + 1)
    return fail('transform-receipt-envelope');
  if (!Array.isArray(receipt.records)) return fail('transform-receipt-records-not-array');
  if (!validSessionEntries(retained) || !validSessionEntries(target)) return fail('session-entry-malformed');
  if (!receipt.records.every(validReceiptRecord)) return fail('transform-receipt-record-malformed');
  if (retainedOverlay !== undefined && stableJson(retainedOverlay) !== stableJson(context.projectConfigOverlay)) return fail('project-overlay-mismatch');
  if (context.activePlateId !== target.currentPlateId) return fail('active-plate-mismatch');
  const transformKey = (entry: { objectIndex: number; instanceIndex: number }): string =>
    `${entry.objectIndex}:${entry.instanceIndex}`;
  const receiptIdentity = (entry: { objectIndex: number; volumeIndex: number; instanceIndex: number }): string =>
    `${entry.objectIndex}:${entry.volumeIndex}:${entry.instanceIndex}`;
  const retainedTransforms = new Map(retained.instanceTransforms.map((entry) => [transformKey(entry), entry.worldTransform]));
  const targetTransforms = new Map(target.instanceTransforms.map((entry) => [transformKey(entry), entry.worldTransform]));
  // A Move receipt is volume-granular, while the retained plate-session
  // transform projection is instance-granular. Keep both identities: a
  // multi-volume object legitimately has multiple receipt rows for one
  // instance and must not be rejected as a duplicate.
  const receiptIdentities = receipt.records.map(receiptIdentity);
  if (receipt.records.length === 0) return fail('transform-receipt-empty');
  if (new Set(receiptIdentities).size !== receiptIdentities.length) return fail('transform-receipt-duplicate-target');
  const receiptInstanceKeys = new Set(receipt.records.map(transformKey));
  // A set_model_transforms rebuild can change the target instance's plate
  // membership, parked flag, and out-of-bounds flag. Those are not stale
  // session data: they are the native result of the transform being restored.
  // Every other instance and every plate fact must remain unchanged.
  const affectedPlateIds = new Set<string>();
  const retainedInstances = new Map(retained.instances!.map((entry) => [transformKey(entry), entry]));
  const targetInstances = new Map(target.instances!.map((entry) => [transformKey(entry), entry]));
  if (retainedInstances.size !== targetInstances.size ||
      [...retainedInstances.keys()].some((key) => !targetInstances.has(key)))
    return fail('session-instance-identity-set-mismatch');
  const retainedPlates = new Map(retained.plates.map((plate) => [plate.plateId, plate]));
  const targetPlates = new Map(target.plates.map((plate) => [plate.plateId, plate]));
  if (retainedPlates.size !== targetPlates.size ||
      [...retainedPlates.keys()].some((plateId) => !targetPlates.has(plateId)))
    return fail('session-plate-identity-set-mismatch');
  for (const record of receipt.records) {
    const key = transformKey(record);
    const retainedInstance = retainedInstances.get(key);
    const targetInstance = targetInstances.get(key);
    if (!retainedInstance || !targetInstance ||
        retainedInstance.objectId !== record.objectId || retainedInstance.instanceId !== record.instanceId ||
        targetInstance.objectId !== record.objectId || targetInstance.instanceId !== record.instanceId)
      return fail(`receipt-instance-identity-mismatch:${record.objectIndex}:${record.instanceIndex}`);
    if (retainedInstance.plateId) affectedPlateIds.add(retainedInstance.plateId);
    if (targetInstance.plateId) affectedPlateIds.add(targetInstance.plateId);
  }
  for (const [plateId, retainedPlate] of retainedPlates) {
    const targetPlate = targetPlates.get(plateId)!;
    const staticPlate = (plate: typeof retainedPlate) => ({
      plateId: plate.plateId, displayIndex: plate.displayIndex, origin: plate.origin,
      name: plate.name, locked: plate.locked, settings: plate.settings,
      opaqueMetadata: plate.opaqueMetadata, futureMetadata: plate.futureMetadata,
    });
    const staticMismatch = boundedMismatch(`plates.${plateId}`, staticPlate(retainedPlate), staticPlate(targetPlate));
    if (staticMismatch) return fail(staticMismatch);
    if (!affectedPlateIds.has(plateId)) {
      const retainedDynamic = { instanceIds: retainedPlate.instanceIds,
        outOfBoundsInstanceIds: retainedPlate.outOfBoundsInstanceIds, valid: retainedPlate.valid };
      const targetDynamic = { instanceIds: targetPlate.instanceIds,
        outOfBoundsInstanceIds: targetPlate.outOfBoundsInstanceIds, valid: targetPlate.valid };
      const dynamicMismatch = boundedMismatch(`plates.${plateId}`, retainedDynamic, targetDynamic);
      if (dynamicMismatch) return fail(dynamicMismatch);
    }
  }
  for (const [key, retainedInstance] of retainedInstances) {
    const targetInstance = targetInstances.get(key)!;
    const identityMismatch = boundedMismatch(`instances[${key}]`,
      { instanceId: retainedInstance.instanceId, objectId: retainedInstance.objectId,
        objectIndex: retainedInstance.objectIndex, instanceIndex: retainedInstance.instanceIndex },
      { instanceId: targetInstance.instanceId, objectId: targetInstance.objectId,
        objectIndex: targetInstance.objectIndex, instanceIndex: targetInstance.instanceIndex });
    if (identityMismatch) return fail(identityMismatch);
    if (!receiptInstanceKeys.has(key) && stableJson(retainedInstance) !== stableJson(targetInstance))
      return fail(`instances[${key}]-unexpected-change`);
  }
  const retainedRevisions = retained.inputRevisions;
  const targetRevisions = target.inputRevisions;
  const revisionIds = new Set([...Object.keys(retainedRevisions), ...Object.keys(targetRevisions)]);
  let changedRevisionCount = 0;
  let unexpectedRevisionCount = 0;
  for (const plateId of revisionIds) {
    const retainedRevision = retainedRevisions[plateId];
    const targetRevision = targetRevisions[plateId];
    if (retainedRevision === targetRevision) continue;
    changedRevisionCount += 1;
    if (!affectedPlateIds.has(plateId) || targetRevision === undefined || Math.abs(retainedRevision - targetRevision) !== 1)
      unexpectedRevisionCount += 1;
  }
  if (unexpectedRevisionCount > 0)
    return fail(`input-revisions-mismatch:changed=${changedRevisionCount}:unexpected=${unexpectedRevisionCount}`);
  // Canonical history contexts normally carry an empty transform list. When a
  // producer does include it, retain the same safety fence: only receipt
  // instances may differ, and every changed target must match the explicit
  // instance transform carried by the receipt.
  if (retainedTransforms.size > 0 && targetTransforms.size > 0 &&
      (retainedTransforms.size !== targetTransforms.size ||
       [...retainedTransforms.keys()].some((key) => !targetTransforms.has(key))))
    return fail('retained-target-transform-set-mismatch');
  if (retainedTransforms.size > 0 && targetTransforms.size > 0) {
    for (const [key, retainedTransform] of retainedTransforms) {
      const targetTransform = targetTransforms.get(key)!;
      if (!receiptInstanceKeys.has(key) && stableJson(retainedTransform) !== stableJson(targetTransform))
        return fail(`instance-transform-unexpected-change:${key}`);
      if (receiptInstanceKeys.has(key)) {
        const matching = receipt.records.find((record) => transformKey(record) === key);
        if (!matching || stableJson(matching.instanceTransform) !== stableJson(targetTransform))
          return fail(`receipt-target-transform-mismatch:${key}`);
      }
    }
  }
  return { session: target, failure: null };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validSessionEntries(session: PlateSessionSnapshot): boolean {
  if (typeof session.currentPlateId !== 'string' || session.currentPlateId.length === 0 ||
      !session.inputRevisions || Array.isArray(session.inputRevisions) ||
      Object.values(session.inputRevisions).some((revision) => !Number.isSafeInteger(revision) || revision < 0)) return false;
  if (session.plates.some((plate) => {
    if (!plate || typeof plate !== 'object' || typeof plate.plateId !== 'string' || plate.plateId.length === 0 ||
        !Number.isSafeInteger(plate.displayIndex) || !Array.isArray(plate.origin) || plate.origin.length !== 3 ||
        !plate.origin.every((value) => typeof value === 'number' && Number.isFinite(value)) || typeof plate.name !== 'string' ||
        (plate.locked !== undefined && typeof plate.locked !== 'boolean') ||
        (plate.valid !== undefined && typeof plate.valid !== 'boolean')) return true;
    const record = (value: unknown): value is Record<string, unknown> =>
      !!value && typeof value === 'object' && !Array.isArray(value);
    const integerArray = (value: unknown): boolean =>
      Array.isArray(value) && value.every((item) => Number.isSafeInteger(item) && (item as number) >= 0) &&
      new Set(value).size === value.length;
    const metadata = plate.opaqueMetadata;
    return !Array.isArray(plate.instanceIds) || !Array.isArray(plate.outOfBoundsInstanceIds) ||
      (plate.settings !== undefined && !record(plate.settings)) ||
      (metadata !== undefined && (!Array.isArray(metadata) || metadata.some((item) =>
        !item || typeof item !== 'object' || typeof item.key !== 'string' || typeof item.value !== 'string'))) ||
      (plate.futureMetadata !== undefined && !record(plate.futureMetadata)) ||
      (plate.instanceIds !== undefined && !integerArray(plate.instanceIds)) ||
      (plate.outOfBoundsInstanceIds !== undefined && !integerArray(plate.outOfBoundsInstanceIds));
  })) return false;
  const plateIds = session.plates.map((plate) => plate.plateId);
  if (new Set(plateIds).size !== plateIds.length || Object.keys(session.inputRevisions).length !== plateIds.length ||
      plateIds.some((plateId) => !Object.prototype.hasOwnProperty.call(session.inputRevisions, plateId))) return false;
  if (session.instances!.some((instance) => !instance || typeof instance !== 'object' ||
      ![instance.instanceId, instance.objectId].every((value) => Number.isSafeInteger(value) && value > 0) ||
      ![instance.objectIndex, instance.instanceIndex].every((value) => Number.isSafeInteger(value) && value >= 0) ||
      typeof instance.plateId !== 'string' ||
      typeof instance.member !== 'boolean' || typeof instance.unprintable !== 'boolean' ||
      typeof instance.outOfBounds !== 'boolean' ||
      (instance.parked !== undefined && typeof instance.parked !== 'boolean'))) return false;
  const instanceKeys = session.instances!.map((instance) => `${instance.objectIndex}:${instance.instanceIndex}`);
  if (new Set(instanceKeys).size !== instanceKeys.length) return false;
  const knownPlateIds = new Set(plateIds);
  const memberIdsByPlate = new Map<string, Set<number>>();
  const outOfBoundsIdsByPlate = new Map<string, Set<number>>();
  for (const plateId of plateIds) {
    const plate = session.plates.find((candidate) => candidate.plateId === plateId)!;
    memberIdsByPlate.set(plateId, new Set(plate.instanceIds ?? []));
    outOfBoundsIdsByPlate.set(plateId, new Set(plate.outOfBoundsInstanceIds ?? []));
  }
  const memberIds = new Set<number>();
  const outOfBoundsIds = new Set<number>();
  for (const instance of session.instances!) {
    if (instance.member !== (instance.plateId.length > 0) ||
        (instance.plateId && !knownPlateIds.has(instance.plateId)) ||
        (instance.parked === true && instance.plateId.length > 0) ||
        (instance.outOfBounds && instance.plateId.length === 0)) return false;
    if (instance.member) {
      if (!memberIds.add(instance.instanceId) || !memberIdsByPlate.get(instance.plateId)?.has(instance.instanceId)) return false;
    }
    if (instance.outOfBounds) {
      if (!outOfBoundsIds.add(instance.instanceId) || !outOfBoundsIdsByPlate.get(instance.plateId)?.has(instance.instanceId)) return false;
    }
  }
  for (const plateId of plateIds) {
    const plate = session.plates.find((candidate) => candidate.plateId === plateId)!;
    if ((plate.instanceIds ?? []).some((id) => !session.instances!.some((instance) => instance.instanceId === id && instance.plateId === plateId && instance.member)) ||
      (plate.outOfBoundsInstanceIds ?? []).some((id) => !session.instances!.some((instance) => instance.instanceId === id && instance.plateId === plateId && instance.outOfBounds)))
      return false;
    if (plate.valid !== undefined && plate.valid !== ((plate.outOfBoundsInstanceIds ?? []).length === 0)) return false;
  }
  if (session.instanceTransforms!.some((entry) => !entry || typeof entry !== 'object' ||
      ![entry.instanceId, entry.objectId].every((value) => Number.isSafeInteger(value) && value > 0) ||
      ![entry.objectIndex, entry.instanceIndex].every((value) => Number.isSafeInteger(value) && value >= 0))) return false;
  const transformEntryKeys = session.instanceTransforms!.map((entry) => `${entry.objectIndex}:${entry.instanceIndex}`);
  if (new Set(transformEntryKeys).size !== transformEntryKeys.length) return false;
  const transformKeys = new Set<string>();
  return session.instanceTransforms!.every((entry) => {
    if (!entry || typeof entry !== 'object' || !validModelTransform(entry.worldTransform)) return false;
    const key = `${entry.objectIndex}:${entry.instanceIndex}`;
    if (transformKeys.has(key)) return false;
    transformKeys.add(key);
    const instance = session.instances!.find((candidate) => `${candidate.objectIndex}:${candidate.instanceIndex}` === key);
    return !!instance && instance.instanceId === entry.instanceId && instance.objectId === entry.objectId;
  });
}

function validReceiptRecord(record: TransformRestoreReceipt['records'][number]): boolean {
  return !!record && typeof record === 'object' &&
    [record.objectId, record.volumeId, record.instanceId].every((value) => Number.isSafeInteger(value) && value > 0) &&
    [record.objectIndex, record.volumeIndex, record.instanceIndex].every((value) => Number.isSafeInteger(value) && value >= 0) &&
    validModelTransform(record.instanceTransform) &&
    validModelTransform(record.volumeTransform);
}

function validModelTransform(transform: unknown): boolean {
  if (!transform || typeof transform !== 'object') return false;
  const value = transform as Record<string, unknown>;
  const tuple = (entry: unknown, length: number): boolean =>
    Array.isArray(entry) && entry.length === length && entry.every((item) => typeof item === 'number' && Number.isFinite(item));
  return tuple(value.offset, 3) && tuple(value.rotation, 3) && tuple(value.scale, 3) &&
    tuple(value.mirror, 3) && (value.matrix === undefined || tuple(value.matrix, 16));
}

/**
 * Diagnostics intentionally identify only the first mismatching field and
 * collection cardinalities. This makes a real proof miss actionable without
 * logging opaque project metadata or transform payloads.
 */
function boundedMismatch(label: string, left: unknown, right: unknown): string | null {
  if (stableJson(left) === stableJson(right)) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${label}-length:${left.length}->${right.length}`;
    for (let index = 0; index < left.length; index += 1) {
      const mismatch = boundedMismatch(`${label}[${index}]`, left[index], right[index]);
      if (mismatch) return mismatch;
    }
    return `${label}-value`;
  }
  if (left && typeof left === 'object' && right && typeof right === 'object' &&
      !Array.isArray(left) && !Array.isArray(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      if (!(key in leftRecord) || !(key in rightRecord)) return `${label}.${key}-presence`;
      const mismatch = boundedMismatch(`${label}.${key}`, leftRecord[key], rightRecord[key]);
      if (mismatch) return mismatch;
    }
  }
  return `${label}-value`;
}
