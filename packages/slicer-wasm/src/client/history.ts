/**
 * Host-neutral, structured-clone/JSON-safe history contracts.
 *
 * These types describe the seam between the shared application and the
 * Worker-owned history implementation.  They intentionally contain no
 * renderer, Electron, Node, or geometry objects.  The Worker can therefore
 * retain a context alongside a model version without making React a second
 * model owner.
 */

/** Stable native identities.  These are IDs, never positional indexes. */
export type StableObjectId = number;
export type StablePartId = number;
export type StableInstanceId = number;
export type StablePlateId = string;

export type HistorySelectionMode = 'object' | 'part' | 'instance';

export interface HistorySelection {
  readonly mode: HistorySelectionMode;
  readonly objectIds: readonly StableObjectId[];
  readonly partIds: readonly StablePartId[];
  readonly instanceIds: readonly StableInstanceId[];
}

/** JSON-compatible values used for small durable context state. */
export type HistoryJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly HistoryJsonValue[]
  | { readonly [key: string]: HistoryJsonValue };
export type HistoryJsonObject = { readonly [key: string]: HistoryJsonValue };

export interface HistoryGizmoContext {
  /** The active gizmo type, for example `move`, `rotate`, or `scale`. */
  readonly type: string;
  /** Small durable UI state; transient renderer objects do not belong here. */
  readonly state?: HistoryJsonObject;
}

/** Context paired with every model history frame. */
export interface HistoryContext {
  readonly selection: HistorySelection;
  readonly activePlateId: StablePlateId | null;
  readonly gizmo: HistoryGizmoContext | null;
  /** Project/object/part/plate overrides, never global preset preferences. */
  readonly projectConfigOverlay: HistoryJsonObject;
}

/** Project entries are navigable; context entries accompany a project frame. */
export type HistoryCategory = 'project' | 'context';
export type HistoryEntryCategory = HistoryCategory;
/** Alias matching the Worker API's `beginHistory(..., kind, ...)` wording. */
export type HistoryKind = HistoryCategory;
export type HistoryLabel = string;
export type HistoryTransactionId = string;
export type HistoryEntryId = string;
export type HistoryJumpDirection = 'undo' | 'redo';

export interface HistoryEntrySummary {
  readonly id: HistoryEntryId;
  readonly label: HistoryLabel;
  readonly category: HistoryCategory;
}

/** JSON-safe status returned by the future Worker history API. */
export interface HistoryStatus {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undoLabel?: HistoryLabel;
  readonly redoLabel?: HistoryLabel;
  readonly undoEntries: readonly HistoryEntrySummary[];
  readonly redoEntries: readonly HistoryEntrySummary[];
  readonly cursor: number;
  readonly savedCheckpoint: number | null;
  readonly savedCheckpointEvicted: boolean;
  readonly dirty: boolean;
  readonly bytesUsed: number;
  readonly byteBudget: number;
  /** Cumulative bytes released from optional/reconstructable history data. */
  readonly optionalBytesReleased: number;
  /** Cumulative whole-entry evictions for this project session. */
  readonly evictedEntryCount: number;
  readonly lastEvictedEntryId: HistoryEntryId | null;
  readonly oldestRetainedEntryId: HistoryEntryId | null;
  /** True only for the intentional single oversized atomic operation case. */
  readonly oversizedEntryRetained: boolean;
  /** True when the session cannot safely accept or restore history. */
  readonly disabled: boolean;
  readonly activeTransactionId: HistoryTransactionId | null;
  readonly revision: number;
}

export type HistoryErrorCode =
  | 'disabled'
  | 'transaction-active'
  | 'transaction-not-found'
  | 'transaction-stale'
  | 'invalid-entry'
  | 'invalid-context'
  | 'no-effective-change'
  | 'restore-failed'
  | 'memory-exhausted'
  | 'unknown';

/** Structured error payload suitable for crossing a Worker boundary. */
export interface HistoryError {
  readonly code: HistoryErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly transactionId?: HistoryTransactionId;
}

export interface RestoreSuccess {
  readonly ok: true;
  readonly context: HistoryContext;
  readonly status: HistoryStatus;
  readonly entryId?: HistoryEntryId;
}

export interface RestoreFailure {
  readonly ok: false;
  readonly error: HistoryError;
  readonly status?: HistoryStatus;
}

export type RestoreResult = RestoreSuccess | RestoreFailure;

/** A transaction callback is given the opaque Worker transaction identity. */
export type HistoryMutation<T> = (transactionId: HistoryTransactionId) => Promise<T>;

/**
 * Dormant foundation for high-frequency operations.  Coalescing is opt-in and
 * has no current UI; a nested begin must name its active parent transaction.
 */
export interface HistoryTransactionOptions {
  readonly coalesce?: boolean;
  readonly parentTransactionId?: HistoryTransactionId;
}

/**
 * Worker-backed history methods.  These are required on the real client;
 * callers cannot construct model patches or maintain a second history stack.
 */
export interface HistoryRuntimeMethods {
  beginHistory: (
    label: HistoryLabel,
    category: HistoryKind,
    beforeContext: HistoryContext,
    options?: HistoryTransactionOptions,
  ) => Promise<HistoryTransactionId>;
  commitHistory: (
    transactionId: HistoryTransactionId,
    afterContext: HistoryContext,
  ) => Promise<HistoryStatus>;
  abortHistory: (transactionId: HistoryTransactionId) => Promise<RestoreResult>;
  undoHistory: () => Promise<RestoreResult>;
  redoHistory: () => Promise<RestoreResult>;
  getHistoryStatus: () => Promise<HistoryStatus>;
  jumpHistory: (entryId: HistoryEntryId, direction?: HistoryJumpDirection) => Promise<RestoreResult>;
  /** Advance the saved checkpoint without releasing history frames. */
  markHistorySaved: (context?: HistoryContext) => Promise<HistoryStatus>;
  /** Record a renderer-projected selection/plate context without a model edit. */
  recordHistoryContext: (label: HistoryLabel, context: HistoryContext) => Promise<HistoryStatus>;
  /** Replace the project session with a clean, one-frame history baseline. */
  resetHistory: (context: HistoryContext) => Promise<HistoryStatus>;
}

/** A small structural type for unit-test runtime doubles. */
export type MockHistoryRuntime = Partial<HistoryRuntimeMethods>;
