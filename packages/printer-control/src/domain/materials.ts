/** Physical material inventory and routing. Project import is an application-owned proposal, never telemetry side effects. */
import type { Id, Revision, ExternalRef, Reading, AtLeastOne } from './common';
export interface MaterialUnit {
  id: Id<'material-unit'>;
  name: string;
  kind: 'manual-holder' | 'automatic-feeder';
  sensorIds: readonly Id<'sensor'>[];
}
export interface MaterialSlot {
  id: Id<'slot'>;
  unitId: Id<'material-unit'>;
  name: string;
}
export interface MaterialPath {
  id: Id<'path'>;
  slotId: Id<'slot'>;
  toolId: Id<'tool'>;
  loading: 'manual' | 'automatic';
}
export interface Dryer {
  id: Id<'dryer'>;
  name: string;
  unitIds: readonly Id<'material-unit'>[];
  sensorIds: readonly Id<'sensor'>[];
}
export interface MaterialTopology {
  units: readonly MaterialUnit[];
  slots: readonly MaterialSlot[];
  paths: readonly MaterialPath[];
  dryers: readonly Dryer[];
}
export type MaterialColor = {
  kind: 'solid';
  rgba: string;
} | {
  kind: 'multiple';
  rgba: readonly string[];
  appearance: 'gradient' | 'parallel' | 'unknown';
};
export interface MaterialMetadata {
  materialType: string | null;
  manufacturer: string | null;
  color: MaterialColor | null;
  diameterMm: number | null;
  catalogRef: ExternalRef | null;
}
export type MaterialMetadataPatch = AtLeastOne<MaterialMetadata>;
export type RemainingMaterial = {
  unit: 'g' | 'mm' | 'fraction';
  value: number;
  basis: 'measured' | 'estimated' | 'unspecified';
};
export interface MaterialState {
  inventoryRevision: Revision;
  slots: readonly {
    slotId: Id<'slot'>;
    presence: Reading<'present' | 'empty'>;
    material: Reading<MaterialMetadata | null>;
    spoolIdentity: Reading<ExternalRef | null>;
    remaining: Reading<RemainingMaterial>;
  }[];
  tools: readonly {
    toolId: Id<'tool'>;
    selectedPathId: Reading<Id<'path'> | null>;
    loadedPathId: Reading<Id<'path'> | null>;
    activity: Reading<'idle' | 'loading' | 'unloading' | 'switching' | 'blocked' | 'error'>;
  }[];
  dryers: readonly {
    dryerId: Id<'dryer'>;
    phase: Reading<'off' | 'heating' | 'drying' | 'cooling' | 'error'>;
    remainingSeconds: Reading<number>;
  }[];
}
export interface PrintMaterialBinding {
  materialKey: string;
  pathId: Id<'path'>;
}
export interface MaterialImportCandidate {
  sourceSlotId: Id<'slot'>;
  metadata: MaterialMetadata;
  presetMatch: {
    kind: 'exact';
    presetName: string;
  } | {
    kind: 'candidates';
    presetNames: readonly string[];
  } | {
    kind: 'unresolved';
    reason: string;
  };
}

/**
 * Application-owned preview of an explicit project import, not an agent command.
 * Applying it requires native compatibility checks and one project transaction.
 */
export interface MaterialImportProposal {
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
  topologyRevision: Revision;
  inventoryRevision: Revision;
  projectRevision: Revision;
  candidates: readonly MaterialImportCandidate[];
  emptySlotIds: readonly Id<'slot'>[];
  unresolvedSlots: readonly {
    slotId: Id<'slot'>;
    reason: 'presence-unknown' | 'metadata-missing' | 'metadata-unavailable';
  }[];
}
