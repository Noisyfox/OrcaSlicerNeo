import type * as D from './index';

export type SynchronizationKind = 'printer' | 'filament';
export interface SynchronizationSource {
  kind: SynchronizationKind;
  target: D.PrinterTarget;
  configurationRevision: D.Revision;
  topologyRevision: D.Revision;
  inventoryRevision: D.Revision;
  identity: D.PrinterIdentity;
  /** Normalized descriptor/tool order, never parsed from opaque device IDs. */
  tools: readonly {
    id: D.Id<'tool'>;
    name: string;
    diameterMm: number | null;
    flowType: string | null;
    flowReporting: D.Nozzle['flowReporting'];
    capacity: number;
  }[];
  materials: readonly {
    slotId: D.Id<'slot'>;
    label: string;
    unitKind: D.MaterialUnit['kind'];
    toolIndices: readonly number[];
    presence: 'present' | 'empty' | 'unknown';
    metadata: D.MaterialMetadata | null;
  }[];
}

/** Advisory raw device materials. Project Sync deliberately uses a stricter source policy. */
export interface DeviceGroupingContext {
  identity: D.PrinterIdentity;
  toolCount: number;
  materials: {
    slotId: string; toolIndex: number; external: boolean; materialType: string;
    colour: string | null; catalogRefs: readonly D.ExternalRef[];
  }[];
}
