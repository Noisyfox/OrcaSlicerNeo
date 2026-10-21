/** Partial support knowledge available during discovery/enumeration, without a session. */
import type { Capability, Revision, UnixMs } from './common';
import type { CommandName } from './control';
import type { FileCapabilities } from './files';
import type { CameraMediaCapability } from './media';
import type { StateTopic } from './printer';

export type CapabilityHintSource = {
  kind: 'inferred';
  basis: 'provider' | 'model' | 'configuration';
  /** Identifies the provider-owned inference rule, never a UI brand-name heuristic. */
  ruleId: string;
  ruleRevision: Revision;
} | {
  kind: 'reported';
  via: 'discovery' | 'probe';
};

export interface CapabilityHintEvidence {
  source: CapabilityHintSource;
  assessedAtMs: UnixMs;
  freshness: 'fresh' | 'stale';
}

/**
 * Support only: no fabricated resource IDs, ranges, URLs or current availability.
 * Inferred support can expose a page, but cannot authorize a device operation.
 */
export type CapabilityHint = (
  { kind: 'supported' }
  | Extract<Capability<never>, { kind: 'unsupported' }>
) & CapabilityHintEvidence
  | { kind: 'unknown'; reason: string };

/**
 * Scoped by its enclosing discovery candidate or saved route, never the whole
 * printer across all routes. Omitted entries mean unknown, not unsupported.
 * Keys reuse the full contract; this is not a separate feature or UI taxonomy.
 * A new revision replaces the hint set atomically, not as an implicit JSON patch.
 */
export interface PrinterCapabilityHints {
  revision: Revision;
  commands?: Partial<Record<CommandName, CapabilityHint>>;
  observations?: Partial<Record<StateTopic, CapabilityHint>>;
  files?: Partial<Record<keyof FileCapabilities, CapabilityHint>>;
  /** Route-wide support for at least one camera; camera identities may be unknown. */
  cameras?: Partial<Record<Exclude<keyof CameraMediaCapability, 'cameraId'>, CapabilityHint>>;
  webInterface?: CapabilityHint;
}
