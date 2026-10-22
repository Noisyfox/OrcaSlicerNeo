import type { ServiceProvider } from '@orca/service-provider';
/** Stateless local SDK contracts. Streams/signals require an explicit IPC/network binding. */
import type { Id, UnixMs, ExternalRef, PrinterError, Result, ReadOptions, Capability, AtLeastOne, ObservationCursor, PrinterTarget, TargetRequest, Reading, NonEmptyReadonlyArray, Revision } from './common';
import type { AgentHost, SavedPrinter, PrinterDescriptor, PrinterCapabilities, PrinterRoute, PrinterRouteConfiguration, StateTopic, PrinterObservationMap } from './printer';
import type { PrinterFiles } from './files';
import type { PrinterMedia } from './media';
import type { PrinterOperations, PrinterControls } from './control';
import type { PrinterWebInterfaces } from './web-interface';

/**
 * K bounds possible keys, not the actual requested set. A widened/dynamic topic
 * list may contain only one member of K, so multiple possible keys need presence
 * checks. A single-topic K still has one required key. Empty payloads are invalid.
 */
export type ObservationValues<K extends StateTopic> = AtLeastOne<{
  [T in K]: Reading<PrinterObservationMap[T]>;
}>;
export interface PrinterSnapshot<K extends StateTopic = StateTopic> {
  target: PrinterTarget;
  configurationRevision: Revision;
  /** All actually requested topics, including unknown readings; no unrequested keys. */
  values: ObservationValues<K>;
}
export type PrinterEvent<K extends StateTopic = StateTopic> = {
  type: 'snapshot';
  cursor: ObservationCursor;
  snapshot: PrinterSnapshot<K>;
} | {
  type: 'replace';
  target: PrinterTarget;
  configurationRevision: Revision;
  cursor: ObservationCursor;
  /** One or more changed topics from the subscription, not necessarily all of them. */
  values: ObservationValues<K>;
};
export interface ObservationRequest<K extends StateTopic = StateTopic> {
  target: PrinterTarget;
  /** Non-empty actual selection; K alone does not prove every possible member occurs. */
  topics: readonly [K, ...K[]];
}
export interface PrinterObservations {
  /**
   * Cache never initiates device I/O. Device reads only the requested topics once;
   * failure preserves earlier cached readings and never starts background polling.
   * Materials reads inventory, not an RFID refresh command or project mutation.
   */
  read<K extends StateTopic>(request: ObservationRequest<K> & {
    source: 'cache' | 'device';
  }, options?: ReadOptions): Promise<Result<PrinterSnapshot<K>>>;
  /**
   * Explicit subscription; on-demand-only topics reject watch as unsupported rather
   * than silently starting polling. Without a cursor start
   * with a snapshot; replay after a valid cursor without gaps, or reset with a new
   * snapshot. Cursors are scoped to target/topics/configuration, never sessions.
   * Cancellation releases only this subscription, not operations or media resources.
   */
  watch<K extends StateTopic>(request: ObservationRequest<K> & {
    after?: ObservationCursor;
  }, options?: ReadOptions): AsyncIterable<PrinterEvent<K>>;
}
export type DiscoveryScope = {
  kind: 'lan';
  hostId: Id<'agent-host'>;
} | {
  kind: 'account';
  hostId: Id<'agent-host'>;
};
/** Provider-specific support on this execution host, not a cross-host union. */
export interface ProviderHost extends AgentHost {
  discovery: Capability<{
    kinds: NonEmptyReadonlyArray<DiscoveryScope['kind']>;
  }>;
}
export interface ProviderDescriptor extends ServiceProvider {
  /** Each supported discovery entry supplies its own host ID and non-empty scope choices. */
  hosts: readonly ProviderHost[];
}
export interface PrinterTypeDescriptor {
  id: Id<'printer-type'>;
  providerId: Id<'provider'>;
  name: string;
  description: string;
}
export interface DiscoveryCandidate {
  id: Id<'candidate'>;
  providerId: Id<'provider'>;
  configuration: PrinterRouteConfiguration;
  /** Same normal capability model as saved routes; not a separate support taxonomy. */
  capabilities: PrinterCapabilities;
  displayName: string;
  externalRefs: readonly ExternalRef[];
  expiresAtMs: UnixMs;
  /** Access-code candidates use authorize; adopt is local configuration only. */
  access: 'none' | 'access-code';
}
export type DiscoveryEvent = {
  type: 'upsert';
  candidate: DiscoveryCandidate;
} | {
  type: 'expired';
  candidateId: Id<'candidate'>;
} | {
  type: 'completed';
} | {
  type: 'failed';
  error: PrinterError;
};
export interface PrinterDescription {
  target: PrinterTarget;
  configurationRevision: Revision;
  capabilities: PrinterCapabilities;
  /** Unknown is valid before any device read; no fabricated topology is required. */
  descriptor: Reading<PrinterDescriptor>;
}
/** A provider may implement this and AccountProvider without coupling the capabilities. */
export interface PrinterProvider extends ServiceProvider {
  readonly printers: PrinterService;
}
export interface PrinterService {
  readonly operations: PrinterOperations;
  readonly controls: PrinterControls;
  readonly files: PrinterFiles;
  readonly media: PrinterMedia;
  readonly observations: PrinterObservations;
  readonly webInterfaces: PrinterWebInterfaces;
  /** Local provider/type catalogues; no network discovery. */
  listProviders(options?: ReadOptions): Promise<Result<readonly ProviderDescriptor[]>>;
  listTypes(options?: ReadOptions): Promise<Result<readonly PrinterTypeDescriptor[]>>;
  /** Local configuration plus normal type-derived/cached capabilities; never probes. */
  listSaved(options?: ReadOptions): Promise<Result<readonly SavedPrinter[]>>;
  /** Local saved-catalogue invalidation. Subscribe before listSaved; never starts discovery. */
  onSavedChanged(listener: () => void): () => void;
  /** Local-only description; never refreshes a device or initiates authentication. */
  describe(target: PrinterTarget, options?: ReadOptions): Promise<Result<PrinterDescription>>;
  /** Local validation/persistence only; an unreachable printer can be saved. */
  add(request: {
    requestId: Id<'request'>;
    displayName: string;
    routes: NonEmptyReadonlyArray<PrinterRouteConfiguration>;
  }): Promise<Result<SavedPrinter>>;
  /** Local validation/persistence only; invalidates dependent cached observations. */
  updateRoute(request: {
    target: TargetRequest;
    configuration: PrinterRouteConfiguration;
  }): Promise<Result<PrinterRoute>>;
  /** Explicit discovery is optional and never a prerequisite for manual addition. */
  discover(providerId: Id<'provider'>, scope: DiscoveryScope, options?: ReadOptions): AsyncIterable<DiscoveryEvent>;
  /**
   * Local adoption of self-contained candidate data; no preceding discovery is required.
   * Validate type/configuration and derive capabilities locally, not from caller authority.
   */
  adopt(request: {
    requestId: Id<'request'>;
    candidate: DiscoveryCandidate;
    existingPrinterId?: Id<'printer'>;
  }): Promise<Result<SavedPrinter>>;
  /** Authenticate a LAN candidate through its provider, then save the authorized route. */
  authorize(request: {
    requestId: Id<'request'>;
    candidate: DiscoveryCandidate;
    accessCode: string;
    existingPrinterId?: Id<'printer'>;
  }): Promise<Result<SavedPrinter>>;
  rename(target: TargetRequest, displayName: string): Promise<Result<SavedPrinter>>;
  /** Forget only this route and its credential; remove identity only when no routes remain. */
  forget(target: TargetRequest): Promise<Result<null>>;
}
