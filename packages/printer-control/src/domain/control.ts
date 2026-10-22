/** Typed commands, capability constraints and asynchronous outcomes. This module defines no executor. */
import type { Id, Revision, UnixMs, Axis, Range, PrinterError, Result, ReadOptions, Capability, Availability, NonEmptyReadonlyArray, NoConstraints, PrinterTarget, TargetRequest } from './common';
import type { MaterialMetadata, MaterialMetadataPatch, PrintMaterialBinding } from './materials';
import type { PrintFormatId, FileSelection, VersionCheck, RemoteFile, UploadProgress } from './files';
import type { TimelapseSetting } from './media';
export interface CommandSpec<P, C extends object, R = null> {
  params: P;
  constraints: C;
  result: R;
}

/** Agent-issued context, independent of a caller session or an application print submission. */
export interface PrinterActionRef extends PrinterTarget {
  configurationRevision: Revision;
  /** Opaque to consumers; the agent validates scope, authenticity and current context on submit. */
  token: Id<'action-context'>;
}
export interface PrinterAction {
  actionRef: PrinterActionRef;
  label: string;
  description: string | null;
  availability: Availability;
  /** Null means no known expiry, not a guarantee of continued validity. */
  expiresAtMs: UnixMs | null;
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
    sources: NonEmptyReadonlyArray<{
      storageId: Id<'storage'>;
      versionCheck: VersionCheck;
    }>;
    formats: NonEmptyReadonlyArray<PrintFormatId>;
    materialMapping: 'none' | 'optional' | 'required';
    /** Empty means no optional job-level timelapse choices, not unknown support. */
    jobTimelapse: readonly TimelapseSetting[];
  }>;
  /** Operate on the printer's current print at execution time, without a prior observation. */
  'jobs.pause': CommandSpec<NoConstraints, NoConstraints>;
  'jobs.resume': CommandSpec<NoConstraints, NoConstraints>;
  'jobs.cancel': CommandSpec<NoConstraints, NoConstraints>;
  'actions.invoke': CommandSpec<{
    actionRef: PrinterActionRef;
  }, {
    /** Supported observation topics that supply actionable references; no prior subscription required. */
    sources: NonEmptyReadonlyArray<'status' | 'alerts'>;
  }>;
  'thermal.setTarget': CommandSpec<{
    heaterId: Id<'heater'>;
    targetC: number;
  }, NonEmptyReadonlyArray<{
    heaterId: Id<'heater'>;
    targetC: Range;
  }>>;
  'fans.setSpeed': CommandSpec<{
    fanId: Id<'fan'>;
    speedFraction: number;
  }, NonEmptyReadonlyArray<{
    fanId: Id<'fan'>;
    speedFraction: Range;
  }>>;
  'lights.set': CommandSpec<{
    lightId: Id<'light'>;
    on: boolean;
  }, {
    lightIds: NonEmptyReadonlyArray<Id<'light'>>;
  }>;
  'motion.home': CommandSpec<{
    motionGroupId: Id<'motion'>;
    axes: NonEmptyReadonlyArray<Axis>;
  }, NonEmptyReadonlyArray<{
    motionGroupId: Id<'motion'>;
    axes: NonEmptyReadonlyArray<Axis>;
  }>>;
  'motion.jog': CommandSpec<{
    motionGroupId: Id<'motion'>;
    axis: Axis;
    distanceMm: number;
    speedMmPerSecond: number;
  }, NonEmptyReadonlyArray<{
    motionGroupId: Id<'motion'>;
    axis: Axis;
    distanceMm: Range;
    speedMmPerSecond: Range;
  }>>;
  'extrusion.move': CommandSpec<{
    extruderId: Id<'extruder'>;
    distanceMm: number;
    speedMmPerSecond: number;
  }, NonEmptyReadonlyArray<{
    extruderId: Id<'extruder'>;
    distanceMm: Range;
    speedMmPerSecond: Range;
  }>>;
  'tools.select': CommandSpec<{
    toolId: Id<'tool'>;
  }, {
    toolIds: NonEmptyReadonlyArray<Id<'tool'>>;
  }>;
  'materials.load': CommandSpec<{
    pathId: Id<'path'>;
  }, {
    pathIds: NonEmptyReadonlyArray<Id<'path'>>;
  }>;
  'materials.unload': CommandSpec<{
    toolId: Id<'tool'>;
  }, {
    toolIds: NonEmptyReadonlyArray<Id<'tool'>>;
  }>;
  'materials.switch': CommandSpec<{
    pathId: Id<'path'>;
  }, {
    pathIds: NonEmptyReadonlyArray<Id<'path'>>;
  }>;
  'materials.writeMetadata': CommandSpec<{
    slotId: Id<'slot'>;
    patch: MaterialMetadataPatch;
  }, NonEmptyReadonlyArray<{
    slotId: Id<'slot'>;
    writableFields: NonEmptyReadonlyArray<keyof MaterialMetadata>;
  }>>;
  'materials.refreshTag': CommandSpec<{
    slotId: Id<'slot'>;
  }, {
    slotIds: NonEmptyReadonlyArray<Id<'slot'>>;
  }>;
  'drying.start': CommandSpec<{
    dryerId: Id<'dryer'>;
    targetC: number;
    durationSeconds: number;
  }, NonEmptyReadonlyArray<{
    dryerId: Id<'dryer'>;
    targetC: Range;
    durationSeconds: Range;
  }>>;
  'drying.stop': CommandSpec<{
    dryerId: Id<'dryer'>;
  }, {
    dryerIds: NonEmptyReadonlyArray<Id<'dryer'>>;
  }>;
  'camera.setEnabled': CommandSpec<{
    cameraId: Id<'camera'>;
    enabled: boolean;
  }, {
    cameraIds: NonEmptyReadonlyArray<Id<'camera'>>;
  }>;
  'camera.setDeviceTimelapse': CommandSpec<TimelapseSetting, NonEmptyReadonlyArray<TimelapseSetting>>;
  'files.delete': CommandSpec<{
    target: FileSelection;
  }, NonEmptyReadonlyArray<{
    storageId: Id<'storage'>;
    versionCheck: VersionCheck;
  }>>;
}
export type CommandName = keyof PrinterCommandSpecs;
export type CommandOf<K extends CommandName = CommandName> = { [N in K]: {
  type: N;
  params: PrinterCommandSpecs[N]['params'];
} }[K];
export type PrinterCommand = { [K in CommandName]: CommandOf<K> }[CommandName];
export type CommandCapabilities = { [K in CommandName]: Capability<PrinterCommandSpecs[K]['constraints']> };

/** Optional comparison conditions, never authorization obtained from a previous call. */
export interface ControlBasis {
  capabilityRevision?: Revision;
}
export type InventoryCommand = 'jobs.start' | 'materials.load' | 'materials.unload' | 'materials.switch' | 'materials.writeMetadata' | 'materials.refreshTag';
export type CommandGuard<K extends CommandName> = ControlBasis & (K extends 'files.delete' | 'jobs.pause' | 'jobs.resume' | 'jobs.cancel' | 'actions.invoke' ? {} : {
  topologyRevision?: Revision;
}) & (K extends InventoryCommand ? {
  inventoryRevision?: Revision;
} : {});
export type CommandRequest = { [K in CommandName]: {
  target: TargetRequest;
  requestId: Id<'request'>;
  command: CommandOf<K>;
  guard?: CommandGuard<K>;
} }[CommandName];
export interface CommandEvaluation {
  availability: Availability;
  /** Only known, relevant conditions are supplied. Submit never requires evaluate first. */
  basis: ControlBasis & {
    topologyRevision?: Revision;
    inventoryRevision?: Revision;
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
  /** Configuration snapshot used by this operation; subsequent edits do not retarget it. */
  configurationRevision: Revision;
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
  /** Advisory assessment; submit independently validates parameters, supplied guards and current conditions. */
  evaluate(target: PrinterTarget, command: PrinterCommand, options?: ReadOptions): Promise<Result<CommandEvaluation>>;
  /** An interrupted response after dispatch must preserve an unknown outcome. */
  submit(request: CommandRequest): Promise<Submission>;
}
