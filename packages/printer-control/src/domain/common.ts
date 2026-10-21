/** Shared domain vocabulary. Units and branded IDs do not replace runtime validation. */

export type Id<K extends string> = string & {
  readonly __idKind: K;
};

/** Opaque equality token, not an ordered counter. */
export type Revision = string;
export type UnixMs = number;
export type Axis = 'x' | 'y' | 'z';
export interface ExternalRef {
  namespace: string;
  value: string;
}
/** Individual device limits may be unknown; null never means unrestricted or safe. */
export interface Range {
  min: number | null;
  max: number | null;
  /** Null means unknown granularity; intrinsic command units/validity still apply. */
  step: number | null;
}
/** Explicit empty description for capabilities with no additional request constraints. */
export type NoConstraints = Readonly<Record<string, never>>;
export type ErrorCode = 'unsupported' | 'invalid-request' | 'invalid-target' | 'offline' | 'authentication-required' | 'permission-denied' | 'busy' | 'out-of-range' | 'precondition-failed' | 'stale-context' | 'transport' | 'device-rejected' | 'device-failed' | 'cancelled' | 'file-not-found' | 'file-changed' | 'file-in-use' | 'storage-unavailable' | 'listing-expired' | 'range-not-supported' | 'preview-unavailable' | 'no-compatible-media' | 'viewer-limit' | 'lease-expired' | 'stream-gap';

/** Public message must not contain credentials or private transport details. */
export interface PrinterError {
  code: ErrorCode;
  message: string;
}

/** Expected domain failures are values; programming errors may still reject. */
export type Result<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: PrinterError;
};

/** Stream implementations throw this shape for domain failures after opening. */
export interface PrinterStreamError extends Error {
  detail: PrinterError;
}

/** Aborts this read/subscription only; never cancels a physical command. */
export interface ReadOptions {
  signal?: AbortSignal;
}
export type Capability<C extends object> = {
  kind: 'supported';
  /** Required request-construction information; only documented leaf limits may be null. */
  constraints: C;
} | {
  kind: 'unsupported';
  layer: 'device' | 'adapter' | 'route';
  reason: string;
} | {
  kind: 'unknown';
  reason: string;
};
export type Availability = {
  kind: 'available';
} | {
  kind: 'blocked';
  reasons: readonly PrinterError[];
} | {
  kind: 'unknown';
  reason: string;
};
export type Reading<T> = {
  kind: 'known';
  value: T;
  freshness: 'fresh' | 'stale';
  sourceRouteId: Id<'route'>;
  observedAtMs: UnixMs | null;
  receivedAtMs: UnixMs;
} | {
  kind: 'unknown';
  reason: 'not-reported' | 'unavailable';
};
export type AtLeastOne<T> = { [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>> }[keyof T];
export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

/** Every independent request identifies its saved printer and route explicitly. */
export interface PrinterTarget {
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
}
/** Optional optimistic check; omission still requires execution-time validation. */
export interface TargetRequest extends PrinterTarget {
  expectedConfigurationRevision?: Revision;
}
/** Opaque position in a target/topic event feed, not a connection/session identity. */
export type ObservationCursor = string & { readonly __cursorKind: 'printer-observation' };
