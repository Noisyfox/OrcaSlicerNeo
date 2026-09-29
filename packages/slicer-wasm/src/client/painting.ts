/** Version-one native lifecycle schema. Tool sample and binary draft commands
 * are added only when the native engine can execute them (stages 06/07). */
import type { HistoryEditingSessionId, StableObjectId, StableInstanceId, StablePartId } from './history';
/** Canonical ps-<positive uint64 decimal>, allocated for the WASM lifetime. */
export type PaintingSessionId = string;
/** Reserved pst-<session uint64>-<session-local positive uint64>; no stroke API yet. */
export type PaintingStrokeId = string;
export type PaintingRevision = number;
export interface PaintingSessionOpenRequest {
  readonly version: 1;
  readonly historySessionId: HistoryEditingSessionId;
  readonly objectId: StableObjectId;
  readonly instanceId: StableInstanceId;
}
export interface PaintingSessionRequest {
  readonly version: 1;
  readonly sessionId: PaintingSessionId;
  readonly revision: PaintingRevision;
}
export interface PaintingTargetRequest extends PaintingSessionRequest {
  readonly objectId: StableObjectId;
  readonly instanceId: StableInstanceId;
}
export interface PaintingPartMetadata {
  readonly volumeId: StablePartId;
  readonly sourceTriangleCount: number;
  /** Counts indexed by annotation state 0..16; includes selector subdivisions. */
  readonly facetCounts: readonly number[];
  /** Draft-only identity, never a committed scene resource key. */
  readonly draftResourceId: string;
}
export interface PaintingSessionMetadata {
  readonly id: PaintingSessionId;
  readonly historySessionId: HistoryEditingSessionId;
  readonly revision: PaintingRevision;
  readonly objectId: StableObjectId;
  readonly instanceId: StableInstanceId;
  readonly annotation: 'mmu';
  readonly phase: 'idle';
  readonly strokeId: null;
  readonly parts: readonly PaintingPartMetadata[];
}
export type PaintingSessionResult = { readonly ok: true; readonly version: 1; readonly session: PaintingSessionMetadata }
  | { readonly error: string };
export type PaintingSessionCloseResult = { readonly ok: true; readonly version: 1 } | { readonly error: string };
