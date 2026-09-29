/** Version-one native lifecycle and tool-draft schemas. Binary draft resources
 * and Model/history publication use the subsequent commit boundary. */
import type { HistoryEditingSessionId, StableObjectId, StableInstanceId, StablePartId } from './history';
/** Canonical ps-<positive uint64 decimal>, allocated for the WASM lifetime. */
export type PaintingSessionId = string;
/** pst-<session uint64>-<session-local positive uint64>. */
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
  readonly phase: 'idle' | 'drawing' | 'finished';
  readonly strokeId: PaintingStrokeId | null;
  readonly parts: readonly PaintingPartMetadata[];
  readonly candidate?: {
    readonly revision: PaintingRevision;
    readonly parts: readonly Pick<PaintingPartMetadata, 'volumeId' | 'facetCounts'>[];
    readonly selectedFacetCount: number;
    readonly gapRegionCount: number;
  };
}
export type PaintingSessionResult = { readonly ok: true; readonly version: 1; readonly session: PaintingSessionMetadata }
  | { readonly error: string };
export type PaintingSessionCloseResult = { readonly ok: true; readonly version: 1 } | { readonly error: string };

export type PaintingTool = 'circle' | 'sphere' | 'triangle' | 'height' | 'region' | 'gap' | 'eraseAll';
export interface PaintingSettings {
  readonly state?: number;
  readonly erase?: boolean;
  /** World-space millimetres, default 2. */
  readonly radius?: number;
  /** World-Z band height in millimetres, default 1. */
  readonly height?: number;
  /** 0..90 degrees, default 30; null disables geometry-edge detection. */
  readonly angle?: number | null;
  /** Pinned Orca mesh-space patch area threshold, 0..5 mm², default 0. */
  readonly gapArea?: number;
}
export interface PaintingPointerEvent {
  /** Same CSS-pixel coordinate system as viewport, top-left origin. */
  readonly pointer: readonly [number, number];
  readonly viewport: readonly [number, number, number, number];
  /** OpenGL column-major matrices, clip depth [-1,1]. */
  readonly projection: readonly number[];
  readonly view: readonly number[];
}
export interface PaintingPreviewRequest extends PaintingSessionRequest {
  readonly tool: 'region' | 'gap';
  readonly settings: PaintingSettings;
  readonly event?: PaintingPointerEvent;
}
export interface PaintingStrokeBeginRequest extends PaintingSessionRequest {
  readonly tool: PaintingTool;
  readonly settings: PaintingSettings;
  /** Required for pointer tools; prohibited for gap and eraseAll. */
  readonly event?: PaintingPointerEvent;
  /** Required for gap Apply; optional region-preview consistency guard. */
  readonly candidateRevision?: PaintingRevision;
}
export interface PaintingStrokeRequest extends PaintingSessionRequest {
  readonly strokeId: PaintingStrokeId;
}
export interface PaintingStrokeSampleRequest extends PaintingStrokeRequest {
  readonly settings: PaintingSettings;
  readonly event: PaintingPointerEvent;
}
/** Compact command receipt; full facet scans only occur on explicit session read.
 * finished is pending publication/discard, including no-ops. cancel discards
 * drawing or finished drafts atomically. No command here writes Model/history. */
export type PaintingDraftResult = {
  readonly ok: true;
  readonly version: 1;
  readonly sessionId: PaintingSessionId;
  readonly revision: PaintingRevision;
  readonly strokeId: PaintingStrokeId | null;
  readonly phase: 'idle' | 'drawing' | 'finished';
  readonly effective: boolean;
  /** Cumulative changed parts relative to this stroke's starting selectors. */
  readonly changedPartIds: readonly StablePartId[];
  readonly hit: { readonly volumeId: StablePartId; readonly originalFacet: number; readonly world: readonly [number, number, number] } | null;
  readonly candidateRevision: PaintingRevision | null;
} | { readonly error: string };
