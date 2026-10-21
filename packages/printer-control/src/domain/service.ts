/** Local SDK contracts for discovery and sessions. Methods, signals and streams require an explicit IPC/network binding. */
import type { Id, UnixMs, ExternalRef, PrinterError, Result, ReadOptions, Capability, AtLeastOne, SessionCursor } from './common';
import type { AgentHost, SavedPrinter, PrinterDescriptor, PrinterState, PrinterCapabilities, StateTopic } from './printer';
import type { PrinterFiles } from './files';
import type { PrinterMedia } from './media';
import type { PrinterOperations, PrinterControls } from './control';
import type { PrinterWebInterfaces } from './web-interface';
export interface PrinterSnapshot {
  cursor: SessionCursor;
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
  descriptor: PrinterDescriptor;
  capabilities: PrinterCapabilities;
  state: PrinterState;
}
export type SnapshotSections = Pick<PrinterSnapshot, 'descriptor' | 'capabilities' | 'state'>;
export type PrinterEvent = {
  type: 'snapshot';
  snapshot: PrinterSnapshot;
} | {
  type: 'replace';
  cursor: SessionCursor;
  sections: AtLeastOne<SnapshotSections>;
};
export interface PrinterSession {
  readonly id: Id<'session'>;
  readonly printerId: Id<'printer'>;
  readonly routeId: Id<'route'>;
  readonly controls: PrinterControls;
  readonly files: PrinterFiles;
  readonly media: PrinterMedia;
  /**
   * Initial snapshot then ordered section replacements, without a subscription gap.
   * New epochs and recovered gaps begin with a snapshot; do not replay stale deltas.
   */
  watch(options?: ReadOptions): AsyncIterable<PrinterEvent>;
  getSnapshot(options?: ReadOptions): Promise<Result<PrinterSnapshot>>;
  /** Firmware refresh updates descriptor.firmware; it never checks for or installs updates. */
  refresh(topics: readonly StateTopic[], options?: ReadOptions): Promise<Result<PrinterSnapshot>>;
  /** Idempotent; closes child media/subscriptions, not jobs or operation tracking. */
  close(): Promise<void>;
}
export type DiscoveryScope = {
  kind: 'lan';
  hostId: Id<'agent-host'>;
} | {
  kind: 'account';
  hostId: Id<'agent-host'>;
  accountRef: Id<'account'>;
} | {
  kind: 'manual';
  hostId: Id<'agent-host'>;
  address: string;
};
export interface ProviderDescriptor {
  id: Id<'provider'>;
  name: string;
  hosts: readonly AgentHost[];
  discovery: Capability<{
    kinds: readonly DiscoveryScope['kind'][];
  }>;
}
export interface DiscoveryCandidate {
  id: Id<'candidate'>;
  providerId: Id<'provider'>;
  hostId: Id<'agent-host'>;
  displayName: string;
  externalRefs: readonly ExternalRef[];
  expiresAtMs: UnixMs;
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
export interface PrinterService {
  readonly operations: PrinterOperations;
  /** Native UI access is service-scoped so it does not depend on connect() succeeding. */
  readonly webInterfaces: PrinterWebInterfaces;
  listProviders(options?: ReadOptions): Promise<Result<readonly ProviderDescriptor[]>>;
  listSaved(options?: ReadOptions): Promise<Result<readonly SavedPrinter[]>>;
  discover(providerId: Id<'provider'>, scope: DiscoveryScope, options?: ReadOptions): AsyncIterable<DiscoveryEvent>;
  adopt(request: {
    candidateId: Id<'candidate'>;
    existingPrinterId?: Id<'printer'>;
  }): Promise<Result<SavedPrinter>>;
  rename(printerId: Id<'printer'>, displayName: string): Promise<Result<SavedPrinter>>;
  /** Remove local saved configuration only; no account unbinding or printer mutation. */
  forget(printerId: Id<'printer'>): Promise<Result<null>>;
  connect(routeId: Id<'route'>, options?: ReadOptions): Promise<Result<PrinterSession>>;
}
