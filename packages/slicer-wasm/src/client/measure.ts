import type { PaintingPointerEvent } from './painting';

/** IDs are opaque, Worker-owned and never reused during a WASM lifetime. */
export type MeasureSessionId = string;
export type MeasureDisplayId = string;
export type MeasurePlaneId = string;
export type MeasureVector = readonly [number, number, number];
export type MeasurePointerEvent = PaintingPointerEvent;
export interface MeasureTarget { readonly objectId: number; readonly instanceId: number; readonly volumeId: number }

/** World-space feature descriptions originate in the pinned Orca core. */
export type MeasureFeature =
  | { readonly type: 'point'; readonly point: MeasureVector }
  | { readonly type: 'edge'; readonly start: MeasureVector; readonly end: MeasureVector; readonly length: number; readonly center: MeasureVector | null }
  | { readonly type: 'circle'; readonly center: MeasureVector; readonly radius: number; readonly normal: MeasureVector; readonly diameter: number }
  | { readonly type: 'plane'; readonly normal: MeasureVector; readonly point: MeasureVector; readonly resourceId: MeasurePlaneId; readonly transform: readonly number[] };
export interface MeasureSelection {
  readonly target: MeasureTarget;
  readonly kind: 'feature' | 'center' | 'midpoint' | 'pointOnFeature';
  readonly source: MeasureFeature;
  readonly value: MeasureFeature;
}
export interface MeasureDistance { readonly value: number; readonly from: MeasureVector; readonly to: MeasureVector }
export interface MeasureResult {
  readonly angle: { readonly radians: number; readonly center: MeasureVector;
    readonly edge1: readonly [MeasureVector, MeasureVector]; readonly edge2: readonly [MeasureVector, MeasureVector];
    readonly radius: number; readonly coplanar: boolean } | null;
  readonly infinite: MeasureDistance | null;
  readonly strict: MeasureDistance | null;
  readonly xyz: MeasureVector | null;
  /** Orca's epsilon rules for the presentation of strict distance and XYZ. */
  readonly showStrict: boolean;
  readonly showXyz: boolean;
}
export interface MeasureStatus {
  readonly ok: true;
  readonly version: 1;
  readonly sessionId: MeasureSessionId;
  readonly targetRevision: number;
  readonly selectionRevision: number;
  readonly first: MeasureSelection | null;
  readonly second: MeasureSelection | null;
  readonly sameTarget: boolean;
  readonly result: MeasureResult | null;
}
export interface MeasureSessionRequest { readonly version: 1; readonly sessionId: MeasureSessionId; readonly targetRevision: number }
export interface MeasureOpenRequest { readonly version: 1; readonly targets: readonly MeasureTarget[] }
export interface MeasureDisplayRequest extends MeasureSessionRequest { readonly event: MeasurePointerEvent }
export interface MeasureDisplay extends MeasureStatus {
  readonly displayId: MeasureDisplayId;
  readonly hover: { readonly target: MeasureTarget; readonly originalFacet: number; readonly world: MeasureVector;
    readonly local: MeasureVector; readonly feature: MeasureFeature | null } | null;
  readonly markers: readonly { readonly index: number; readonly position: MeasureVector; readonly item: MeasureSelection }[];
}
export interface MeasureClickRequest extends MeasureSessionRequest {
  readonly displayId?: MeasureDisplayId | null;
  readonly marker?: number | null;
  readonly shift: boolean;
  readonly event: MeasurePointerEvent;
}
export interface MeasureResetRequest extends MeasureSessionRequest { readonly action: 'first' | 'second' | 'all' | 'escape' }
export interface MeasureReceipt extends MeasureStatus { readonly outcome: 'selected' | 'mesh' | 'miss' | 'close' | 'unchanged' }
export interface MeasurePlaneRequest extends MeasureSessionRequest {
  readonly displayId: MeasureDisplayId;
  readonly role: 'hover' | 'first' | 'second';
  readonly resourceId: MeasurePlaneId;
}
export interface MeasurePlane {
  readonly ok: true;
  readonly version: 1;
  readonly sessionId: MeasureSessionId;
  readonly targetRevision: number;
  readonly displayId: MeasureDisplayId;
  readonly resourceId: MeasurePlaneId;
  /** Nonindexed local-space triangles, copied before the native lease is released. */
  readonly vertices: Float32Array;
  readonly transform: readonly number[];
}
export type MeasureReply<T> = T | { readonly error: string };
export interface MeasureApi {
  openMeasureSession(request: MeasureOpenRequest): Promise<MeasureReply<MeasureStatus>>;
  readMeasureSession(request: MeasureSessionRequest): Promise<MeasureReply<MeasureStatus>>;
  getMeasureDisplay(request: MeasureDisplayRequest): Promise<MeasureReply<MeasureDisplay>>;
  clickMeasure(request: MeasureClickRequest): Promise<MeasureReply<MeasureReceipt>>;
  resetMeasure(request: MeasureResetRequest): Promise<MeasureReply<MeasureReceipt>>;
  rebaseMeasure(request: MeasureSessionRequest): Promise<MeasureReply<MeasureStatus>>;
  closeMeasureSession(request: { readonly version: 1; readonly sessionId: MeasureSessionId }): Promise<MeasureReply<{ readonly ok: true; readonly version: 1; readonly sessionId: MeasureSessionId }>>;
  releaseMeasureDisplay(request: { readonly version: 1; readonly sessionId: MeasureSessionId; readonly displayId: MeasureDisplayId }): Promise<void>;
  getMeasurePlane(request: MeasurePlaneRequest): Promise<MeasureReply<MeasurePlane>>;
}
