/** Typed commands, capability constraints and asynchronous outcomes. This module defines no executor. */
import type { Id, Revision, UnixMs, Axis, Range, PrinterError, Result, ReadOptions, Capability, Availability, NonEmptyReadonlyArray } from './common';
import type { MaterialMetadata, MaterialMetadataPatch, PrintMaterialBinding } from './materials';
import type { PrintFormatId, FileSelection, VersionCheck, RemoteFile, UploadProgress } from './files';
import type { TimelapseSetting } from './media';
export interface CommandSpec<P, C, R = null> {
  params: P;
  constraints: C;
  result: R;
}

/** One source for command parameters, support constraints and confirmed results. */
export interface PrinterCommandSpecs {
  'jobs.start': CommandSpec<{
    source: FileSelection;
    bindings: readonly PrintMaterialBinding[];
    options?: {
      timelapse?: readonly TimelapseSetting[];
    };
  }, {
    sources: readonly {
      storageId: Id<'storage'>;
      versionCheck: VersionCheck;
    }[];
    formats: readonly PrintFormatId[];
    materialMapping: 'none' | 'optional' | 'required';
    jobTimelapse: readonly TimelapseSetting[];
  }, {
    jobId: Id<'job'>;
  }>;
  'jobs.pause': CommandSpec<{
    jobId: Id<'job'>;
  }, null>;
  'jobs.resume': CommandSpec<{
    jobId: Id<'job'>;
  }, null>;
  'jobs.cancel': CommandSpec<{
    jobId: Id<'job'>;
  }, null>;
  'thermal.setTarget': CommandSpec<{
    heaterId: Id<'heater'>;
    targetC: number;
  }, readonly {
    heaterId: Id<'heater'>;
    targetC: Range;
  }[]>;
  'fans.setSpeed': CommandSpec<{
    fanId: Id<'fan'>;
    speedFraction: number;
  }, readonly {
    fanId: Id<'fan'>;
    speedFraction: Range;
  }[]>;
  'lights.set': CommandSpec<{
    lightId: Id<'light'>;
    on: boolean;
  }, {
    lightIds: readonly Id<'light'>[];
  }>;
  'motion.home': CommandSpec<{
    motionGroupId: Id<'motion'>;
    axes: NonEmptyReadonlyArray<Axis>;
  }, readonly {
    motionGroupId: Id<'motion'>;
    axes: readonly Axis[];
  }[]>;
  'motion.jog': CommandSpec<{
    motionGroupId: Id<'motion'>;
    axis: Axis;
    distanceMm: number;
    speedMmPerSecond: number;
  }, readonly {
    motionGroupId: Id<'motion'>;
    axis: Axis;
    distanceMm: Range;
    speedMmPerSecond: Range;
  }[]>;
  'extrusion.move': CommandSpec<{
    extruderId: Id<'extruder'>;
    distanceMm: number;
    speedMmPerSecond: number;
  }, readonly {
    extruderId: Id<'extruder'>;
    distanceMm: Range;
    speedMmPerSecond: Range;
  }[]>;
  'tools.select': CommandSpec<{
    toolId: Id<'tool'>;
  }, {
    toolIds: readonly Id<'tool'>[];
  }>;
  'materials.load': CommandSpec<{
    pathId: Id<'path'>;
  }, {
    pathIds: readonly Id<'path'>[];
  }>;
  'materials.unload': CommandSpec<{
    toolId: Id<'tool'>;
  }, {
    toolIds: readonly Id<'tool'>[];
  }>;
  'materials.switch': CommandSpec<{
    pathId: Id<'path'>;
  }, {
    pathIds: readonly Id<'path'>[];
  }>;
  'materials.writeMetadata': CommandSpec<{
    slotId: Id<'slot'>;
    patch: MaterialMetadataPatch;
  }, readonly {
    slotId: Id<'slot'>;
    writableFields: readonly (keyof MaterialMetadata)[];
  }[]>;
  'materials.refreshTag': CommandSpec<{
    slotId: Id<'slot'>;
  }, {
    slotIds: readonly Id<'slot'>[];
  }>;
  'drying.start': CommandSpec<{
    dryerId: Id<'dryer'>;
    targetC: number;
    durationSeconds: number;
  }, readonly {
    dryerId: Id<'dryer'>;
    targetC: Range;
    durationSeconds: Range;
  }[]>;
  'drying.stop': CommandSpec<{
    dryerId: Id<'dryer'>;
  }, {
    dryerIds: readonly Id<'dryer'>[];
  }>;
  'camera.setEnabled': CommandSpec<{
    cameraId: Id<'camera'>;
    enabled: boolean;
  }, {
    cameraIds: readonly Id<'camera'>[];
  }>;
  'camera.setDeviceTimelapse': CommandSpec<TimelapseSetting, readonly TimelapseSetting[]>;
  'files.delete': CommandSpec<{
    target: FileSelection;
  }, readonly {
    storageId: Id<'storage'>;
    versionCheck: VersionCheck;
  }[]>;
}
export type CommandName = keyof PrinterCommandSpecs;
export type CommandOf<K extends CommandName = CommandName> = { [N in K]: {
  type: N;
  params: PrinterCommandSpecs[N]['params'];
} }[K];
export type PrinterCommand = { [K in CommandName]: CommandOf<K> }[CommandName];
export type CommandCapabilities = { [K in CommandName]: Capability<PrinterCommandSpecs[K]['constraints']> };

/** Inventory revision changes on routing/metadata changes, not every sensor sample. */
export type InventoryCommand = 'jobs.start' | 'materials.load' | 'materials.unload' | 'materials.switch' | 'materials.writeMetadata' | 'materials.refreshTag';
export interface ControlBasis {
  sessionId: Id<'session'>;
  epoch: Id<'connection-epoch'>;
  capabilityRevision: Revision;
}
export type CommandGuard<K extends CommandName> = ControlBasis & (K extends 'files.delete' ? {} : {
  topologyRevision: Revision;
}) & (K extends InventoryCommand ? {
  inventoryRevision: Revision;
} : {});
export type CommandRequest = { [K in CommandName]: {
  requestId: Id<'request'>;
  command: CommandOf<K>;
  guard: CommandGuard<K>;
} }[CommandName];
export interface CommandEvaluation {
  availability: Availability;
  basis: ControlBasis & {
    topologyRevision: Revision;
    inventoryRevision: Revision;
  };
}
export interface OperationRef {
  id: Id<'operation'>;
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
}
export interface RequestLookup {
  requestId: Id<'request'>;
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
}

/** Recorded is not completed. Unknown outcomes require reconciliation, not blind retry. */
export type Submission = {
  kind: 'recorded';
  operation: OperationRef;
} | {
  kind: 'rejected';
  error: PrinterError;
} | {
  kind: 'outcome-unknown';
  lookup: RequestLookup;
};
export type OperationPhase<R> = {
  kind: 'queued' | 'sent' | 'acknowledged' | 'running';
} | {
  kind: 'completed';
  result: R;
  confirmation: 'device-result' | 'observed-state';
} | {
  kind: 'failed';
  error: PrinterError;
} | {
  kind: 'outcome-unknown';
  reason: string;
};
export interface OperationBase {
  ref: OperationRef;
  requestId: Id<'request'>;
  originSessionId: Id<'session'>;
  originEpoch: Id<'connection-epoch'>;
  revision: number;
  updatedAtMs: UnixMs;
}
export type CommandOperation = { [K in CommandName]: OperationBase & {
  kind: 'command';
  commandType: K;
  phase: OperationPhase<PrinterCommandSpecs[K]['result']>;
} }[CommandName];
export type UploadOperation = OperationBase & {
  kind: 'upload';
  progress: UploadProgress | null;
  remoteFileMayExist: boolean;
  phase: OperationPhase<RemoteFile> | {
    kind: 'cancelled';
  };
};
export type PrinterOperation = CommandOperation | UploadOperation;
export type OperationLookup = {
  kind: 'found';
  operation: PrinterOperation;
} | {
  kind: 'unknown';
  reason: 'not-found' | 'expired' | 'authority-unavailable';
};
export interface PrinterOperations {
  get(ref: OperationRef, options?: ReadOptions): Promise<Result<OperationLookup>>;
  find(request: RequestLookup, options?: ReadOptions): Promise<Result<OperationLookup>>;
  /** Current full operation first, then full records with increasing revisions. */
  watch(ref: OperationRef, options?: ReadOptions): AsyncIterable<PrinterOperation>;
  /** Only upload operations are cancellable here; remote bytes may remain. */
  requestUploadCancellation(ref: OperationRef): Promise<Result<{
    kind: 'requested' | 'already-finished';
  }>>;
}
export interface PrinterControls {
  /** Advisory assessment; submit must revalidate the guard and current conditions. */
  evaluate(command: PrinterCommand, options?: ReadOptions): Promise<Result<CommandEvaluation>>;
  /** An interrupted response after dispatch must preserve an unknown outcome. */
  submit(request: CommandRequest): Promise<Submission>;
}
