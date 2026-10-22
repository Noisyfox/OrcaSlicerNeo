/** Printer description and observations. No host, firmware protocol or slicer dependency. */
import type { Id, Revision, Axis, ExternalRef, Capability, Reading, NonEmptyReadonlyArray } from './common';
import type { MaterialTopology, MaterialState, MaterialInventory } from './materials';
import type { SensorDefinition, SensorState, SensorSnapshot } from './sensors';
import type { FileCapabilities } from './files';
import type { TimelapseMode, CameraMediaCapability } from './media';
import type { CommandCapabilities, PrinterAction } from './control';
import type { WebInterfaceCapability } from './web-interface';
export interface PrinterIdentity {
  id: Id<'printer'>;
  displayName: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  externalRefs: readonly ExternalRef[];
}
export interface AgentHost {
  id: Id<'agent-host'>;
  name: string;
  execution: 'browser' | 'desktop' | 'service';
}
/** Saved type/address settings. Validate locally; credentials remain host-owned. */
export interface PrinterRouteConfiguration {
  typeId: Id<'printer-type'>;
  hostId: Id<'agent-host'>;
  channel: 'lan' | 'cloud';
  /** Type-specific address: IP, hostname or endpoint URL, including port/path as needed. */
  address: string | null;
  webInterfaceUrl: `http://${string}` | `https://${string}` | null;
  credentialRef: Id<'credential'> | null;
}
export interface PrinterRoute {
  id: Id<'route'>;
  printerId: Id<'printer'>;
  providerId: Id<'provider'>;
  label: string;
  configurationRevision: Revision;
  configuration: PrinterRouteConfiguration;
  /** Local configuration actions. Providers must also enforce these at execution. */
  management: { rename: boolean; configure: boolean; forget: boolean };
  /** Normal capabilities derived locally from type/configuration and retained observations. */
  capabilities: PrinterCapabilities;
}
export interface SavedPrinter {
  identity: PrinterIdentity;
  routes: readonly PrinterRoute[];
}
export type BuildVolume = {
  kind: 'box';
  sizeMm: {
    x: number;
    y: number;
    z: number;
  };
} | {
  kind: 'cylinder';
  diameterMm: number;
  heightMm: number;
} | {
  kind: 'custom';
  description: string;
};
export interface MotionGroup {
  id: Id<'motion'>;
  name: string;
  axes: readonly Axis[];
}
export interface Extruder {
  id: Id<'extruder'>;
  name: string;
  filamentDiametersMm: readonly number[] | null;
}
export interface Nozzle {
  id: Id<'nozzle'>;
  diameterMm: number | null;
  constructionMaterial: string | null;
  heaterId: Id<'heater'> | null;
}
export interface Tool {
  id: Id<'tool'>;
  name: string;
  extruderId: Id<'extruder'>;
  nozzleId: Id<'nozzle'>;
  motionGroupId: Id<'motion'>;
}
export interface Heater {
  id: Id<'heater'>;
  name: string;
  role: 'nozzle' | 'bed' | 'chamber' | 'other';
  /** References a temperature sensor; null when feedback is not exposed. */
  temperatureSensorId: Id<'sensor'> | null;
}
export interface Fan {
  id: Id<'fan'>;
  name: string;
  role: 'part' | 'hotend' | 'chamber' | 'auxiliary' | 'other';
}
export interface Light {
  id: Id<'light'>;
  name: string;
}
export interface Camera {
  id: Id<'camera'>;
  name: string;
  role: 'chamber' | 'nozzle' | 'bed' | 'overview' | 'other';
  toolId: Id<'tool'> | null;
  lightId: Id<'light'> | null;
}
export interface PrinterTopology {
  revision: Revision;
  completeness: 'partial' | 'complete';
  motionGroups: readonly MotionGroup[];
  extruders: readonly Extruder[];
  nozzles: readonly Nozzle[];
  tools: readonly Tool[];
  heaters: readonly Heater[];
  fans: readonly Fan[];
  lights: readonly Light[];
  cameras: readonly Camera[];
  sensors: readonly SensorDefinition[];
  materials: MaterialTopology;
}
export interface FirmwareComponent {
  name: string;
  version: string;
}

export interface PrinterDescriptor {
  revision: Revision;
  identity: PrinterIdentity;
  technology: 'fdm';
  /** Single version inventory. Unknown/stale data does not imply lack of read support. */
  firmware: Reading<readonly FirmwareComponent[]>;
  buildVolume: BuildVolume | null;
  topology: PrinterTopology;
}
export type PrintPhase = 'idle' | 'preparing' | 'printing' | 'paused' | 'completed' | 'cancelled' | 'failed';
/** Display observations, including prints started elsewhere; no application task correlation. */
export interface PrintStatus {
  phase: Reading<PrintPhase>;
  /** Known null means no print name, distinct from an unreported name. */
  name: Reading<string | null>;
  progressFraction: Reading<number>;
  remainingSeconds: Reading<number>;
}
export interface PrinterState {
  operationalState: Reading<'ready' | 'busy' | 'shutdown' | 'error'>;
  activeToolIds: Reading<readonly Id<'tool'>[]>;
  printStatus: PrintStatus;
  /** Contextual actions not owned by an individual alert; an empty list is valid. */
  actions: Reading<readonly PrinterAction[]>;
  heaters: readonly {
    heaterId: Id<'heater'>;
    targetC: Reading<number>;
  }[];
  fans: readonly {
    fanId: Id<'fan'>;
    speedFraction: Reading<number>;
  }[];
  lights: readonly {
    lightId: Id<'light'>;
    on: Reading<boolean>;
  }[];
  motion: readonly {
    motionGroupId: Id<'motion'>;
    /** Only reported axes are included; absence is not a zero coordinate. */
    positionMm: Reading<Partial<Record<Axis, number>>>;
    homedAxes: Reading<readonly Axis[]>;
  }[];
  materials: MaterialState;
  sensors: readonly SensorState[];
  cameras: readonly {
    cameraId: Id<'camera'>;
    enabled: Reading<boolean>;
    health: Reading<'ready' | 'disabled' | 'busy' | 'unavailable' | 'error'>;
    deviceTimelapseMode: Reading<TimelapseMode>;
    capture: Reading<{
      kind: 'idle' | 'recording' | 'timelapse';
    }>;
  }[];
  alerts: Reading<readonly {
    id: Id<'alert'>;
    severity: 'info' | 'warning' | 'error';
    code: string;
    message: string;
    actions: readonly PrinterAction[];
  }[]>;
}
export interface PrinterCapabilities {
  revision: Revision;
  commands: CommandCapabilities;
  cameras: readonly CameraMediaCapability[];
  files: FileCapabilities;
  /** Original printer UI, independently resolvable through PrinterService.webInterfaces. */
  webInterface: WebInterfaceCapability;
  /** Firmware read support is observations.firmware; no update capability is implied. */
  observations: { [K in StateTopic]: Capability<{
    delivery: NonEmptyReadonlyArray<'push' | 'poll' | 'on-demand'>;
  }> };
}
/** Topic-scoped data avoids requiring a complete printer snapshot for a single read. */
export interface PrinterObservationMap {
  descriptor: PrinterDescriptor;
  status: Pick<PrinterState, 'operationalState' | 'activeToolIds' | 'printStatus' | 'actions'>;
  thermal: PrinterState['heaters'];
  motion: PrinterState['motion'];
  actuators: Pick<PrinterState, 'fans' | 'lights'>;
  materials: MaterialInventory;
  cameras: PrinterState['cameras'];
  sensors: SensorSnapshot;
  alerts: Extract<PrinterState['alerts'], { kind: 'known' }>['value'];
  firmware: readonly FirmwareComponent[];
}
export type StateTopic = keyof PrinterObservationMap;
