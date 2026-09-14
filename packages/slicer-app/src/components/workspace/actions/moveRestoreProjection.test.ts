import { describe, expect, it } from 'vitest';
import type { HistoryContext, PlateSessionSnapshot, TransformRestoreReceipt } from '@slicer/client';
import { moveRestoreSessionProof, moveRestoreSessionProofResult } from './moveRestoreProjection';

const session = (overrides: Partial<PlateSessionSnapshot> = {}): PlateSessionSnapshot => ({
  ok: true, version: 1, currentPlateId: 'plate-1',
  plates: [{ plateId: 'plate-1', displayIndex: 0, origin: [0, 0, 0], name: 'Plate', locked: false,
    settings: {}, opaqueMetadata: [], futureMetadata: {}, instanceIds: [3], outOfBoundsInstanceIds: [], valid: true }],
  instances: [{ instanceId: 3, objectId: 2, objectIndex: 0, instanceIndex: 0, plateId: 'plate-1', member: true,
    unprintable: false, outOfBounds: false, parked: false }],
  instanceTransforms: [],
  inputRevisions: { 'plate-1': 4 },
  ...overrides,
});
const context = (plateSession?: PlateSessionSnapshot): HistoryContext => ({
  selection: { mode: 'object', objectIds: [], partIds: [], instanceIds: [] }, activePlateId: 'plate-1',
  gizmo: null, projectConfigOverlay: {}, ...(plateSession ? { plateSession } : {}),
});
const receipt: TransformRestoreReceipt = { version: 1, state: 'before', beforeRevision: 3, afterRevision: 4,
  records: [{ objectId: 2, volumeId: 4, instanceId: 3, objectIndex: 0, volumeIndex: 0, instanceIndex: 0,
    instanceTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] },
    volumeTransform: { offset: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] } }] };

describe('move restore session proof', () => {
  it('accepts an unchanged session even when instance transforms are omitted from comparison', () => {
    const retained = session({ instanceTransforms: [{ instanceId: 3, objectId: 2, objectIndex: 0, instanceIndex: 0,
      worldTransform: { offset: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], mirror: [1, 1, 1] } }] });
    expect(moveRestoreSessionProof(context(session()), retained, {}, receipt)).toEqual(session());
  });

  it.each([
    ['plate geometry', { plates: [{ ...session().plates[0]!, origin: [1, 0, 0] as [number, number, number] }] } as Partial<PlateSessionSnapshot>],
  ])('rejects a changed %s', (_label, changes) => {
    expect(moveRestoreSessionProof(context(session(changes)), session(), {}, receipt)).toBeNull();
  });

  it('accepts a native out-of-bounds transition and its affected revision', () => {
    const target = session({
      plates: [{ ...session().plates[0]!, outOfBoundsInstanceIds: [3], valid: false }],
      instances: [{ ...session().instances![0]!, outOfBounds: true }],
      inputRevisions: { 'plate-1': 5 },
    });
    expect(moveRestoreSessionProof(context(target), session(), {}, receipt)).toEqual(target);
  });

  it('accepts native parking or membership changes only for receipt instances', () => {
    const target = session({
      plates: [{ ...session().plates[0]!, instanceIds: [], outOfBoundsInstanceIds: [], valid: true }],
      instances: [{ ...session().instances![0]!, plateId: '', member: false, unprintable: true, parked: true }],
      inputRevisions: { 'plate-1': 5 },
    });
    expect(moveRestoreSessionProof(context(target), session(), {}, receipt)).toEqual(target);
  });

  it('rejects an unexpected affected revision jump', () => {
    expect(moveRestoreSessionProof(context(session({ inputRevisions: { 'plate-1': 6 } })), session(), {}, receipt)).toBeNull();
  });

  it('reports a bounded first field for a changed plate without exposing payload', () => {
    const result = moveRestoreSessionProofResult(context(session({
      plates: [{ ...session().plates[0]!, origin: [1, 0, 0] as [number, number, number] }],
    })), session(), {}, receipt);
    expect(result.failure).toBe('plates.plate-1.origin[0]-value');
  });

  it('accepts volume-granular receipt rows for one instance', () => {
    const secondVolume = { ...receipt.records[0]!, volumeId: 5, volumeIndex: 1 };
    expect(moveRestoreSessionProof(context(session()), session(), {}, {
      ...receipt, records: [...receipt.records, secondVolume],
    })).toEqual(session());
  });

  it('falls back for malformed receipt or retained session data', () => {
    expect(moveRestoreSessionProofResult(context(session()), session(), {}, {
      ...receipt, records: null as never,
    }).failure).toBe('transform-receipt-records-not-array');
    expect(moveRestoreSessionProofResult(context(session()), session({ plates: [null as never] }), {}, receipt).failure)
      .toBe('session-entry-malformed');
  });

  it('rejects missing session proof', () => expect(moveRestoreSessionProof(context(), session())).toBeNull());
  it('rejects a changed project overlay', () => expect(moveRestoreSessionProof(context(session()), session(), { changed: true })).toBeNull());
});
