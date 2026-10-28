// Compile-only consumers of the public entrypoint. Never imported by runtime code.
import type { PrinterAction, PrinterActionRef, PrintStatus, CommandCapabilities, CommandOf, CommandRequest, FileSelection, Id, MaterialMetadataPatch, PrinterCommand, PrinterDescriptor, PrinterEvent, PrinterOperation, PrinterState, SensorDefinition, SensorState, SensorSnapshot } from '@orca/printer-control/domain';
import type { PrinterCapabilities, PrinterService, WebInterfaceDescription, WebInterfaceLaunch } from '@orca/printer-control/domain';
import type { Capability, DiscoveryCandidate, PrinterRoute, SavedPrinter, PrinterTarget, ObservationCursor, MediaRef, MaterialInventory, CameraMediaCapability, FileCapabilities, ProviderDescriptor, Range, FilePreviewListing, RemoteFileDetails, ObservationRequest, PrinterSnapshot, FirmwareComponent, MaterialImportProposal, Revision } from '@orca/printer-control/domain';

// Brands in fixtures stand in for IDs validated/issued by a future provider.
const id = <K extends string,>(value: string): Id<K> => value as Id<K>;
const toolId = id<'tool'>('tool-0');
const slotId = id<'slot'>('external');
const pathId = id<'path'>('external-to-tool-0');
const heaterId = id<'heater'>('hotend');
const sensorId = id<'sensor'>('hotend-temperature');
const motionId = id<'motion'>('gantry');
const unitId = id<'material-unit'>('holder');
export const manualPrinter = {
  revision: 'descriptor-1',
  technology: 'fdm',
  identity: {
    id: id<'printer'>('manual'),
    displayName: 'Manual single-tool printer',
    manufacturer: null,
    model: null,
    serialNumber: null,
    externalRefs: []
  },
  firmware: { kind: 'unknown', reason: 'not-reported' },
  buildVolume: {
    kind: 'box',
    sizeMm: {
      x: 200,
      y: 200,
      z: 200
    }
  },
  topology: {
    revision: 'topology-1',
    completeness: 'complete',
    motionGroups: [{
      id: motionId,
      name: 'Gantry',
      axes: ['x', 'y', 'z']
    }],
    extruders: [{
      id: id<'extruder'>('extruder-0'),
      name: 'Extruder',
      filamentDiametersMm: [1.75]
    }],
    nozzles: [{
      id: id<'nozzle'>('nozzle-0'),
      diameterMm: 0.4,
      constructionMaterial: 'brass', type: null, flowType: null,
      heaterId
    }],
    tools: [{
      id: toolId,
      name: 'Tool 0',
      extruderId: id<'extruder'>('extruder-0'),
      nozzleId: id<'nozzle'>('nozzle-0'),
      motionGroupId: motionId
    }],
    heaters: [{
      id: heaterId,
      name: 'Hotend',
      role: 'nozzle',
      temperatureSensorId: sensorId
    }],
    fans: [],
    lights: [],
    cameras: [],
    sensors: [{
      id: sensorId,
      name: 'Hotend temperature',
      location: null,
      kind: 'temperature',
      unit: 'celsius'
    }],
    materials: {
      units: [{
        id: unitId,
        name: 'External spool',
        kind: 'manual-holder',
        sensorIds: []
      }],
      slots: [{
        id: slotId,
        unitId,
        name: 'External spool'
      }],
      paths: [{
        id: pathId,
        slotId,
        toolId,
        loading: 'manual'
      }],
      dryers: []
    }
  }
} satisfies PrinterDescriptor;

// A passive chamber probe and door sensor add no chamber heater or control command.
export const enclosedPrinter = {
  ...manualPrinter,
  topology: {
    ...manualPrinter.topology,
    sensors: [...manualPrinter.topology.sensors, {
      id: id<'sensor'>('chamber'),
      name: 'Chamber',
      location: 'Enclosure',
      kind: 'temperature',
      unit: 'celsius'
    }, {
      id: id<'sensor'>('door'),
      name: 'Door',
      location: 'Front',
      kind: 'door',
      unit: null
    }],
    cameras: [{
      id: id<'camera'>('chamber'),
      name: 'Chamber camera',
      role: 'chamber',
      toolId: null,
      lightId: null
    }]
  }
} satisfies PrinterDescriptor;

// Six slots deliberately exercise a feeder without a fixed four-slot AMS layout.
const feederId = id<'material-unit'>('feeder');
export const automaticPrinter = {
  ...enclosedPrinter,
  topology: {
    ...enclosedPrinter.topology,
    materials: {
      units: [{
        id: feederId,
        name: 'Six-slot feeder',
        kind: 'automatic-feeder',
        sensorIds: []
      }],
      slots: Array.from({
        length: 6
      }, (_, n) => ({
        id: id<'slot'>(`feeder-${n}`),
        unitId: feederId,
        name: `Slot ${n}`
      })),
      paths: Array.from({
        length: 6
      }, (_, n) => ({
        id: id<'path'>(`path-${n}`),
        slotId: id<'slot'>(`feeder-${n}`),
        toolId,
        loading: 'automatic' as const
      })),
      dryers: []
    }
  }
} satisfies PrinterDescriptor;

// Independent tools can share a gantry; tool/extruder/nozzle IDs remain distinct.
export const multiToolPrinter = {
  ...manualPrinter,
  topology: {
    ...manualPrinter.topology,
    extruders: [...manualPrinter.topology.extruders, {
      id: id<'extruder'>('extruder-1'),
      name: 'Extruder 1',
      filamentDiametersMm: [1.75]
    }],
    nozzles: [...manualPrinter.topology.nozzles, {
      id: id<'nozzle'>('nozzle-1'),
      diameterMm: 0.6,
      constructionMaterial: null, type: null, flowType: null,
      heaterId: id<'heater'>('hotend-1')
    }],
    tools: [...manualPrinter.topology.tools, {
      id: id<'tool'>('tool-1'),
      name: 'Tool 1',
      extruderId: id<'extruder'>('extruder-1'),
      nozzleId: id<'nozzle'>('nozzle-1'),
      motionGroupId: motionId
    }],
    heaters: [...manualPrinter.topology.heaters, {
      id: id<'heater'>('hotend-1'),
      name: 'Hotend 1',
      role: 'nozzle',
      temperatureSensorId: null
    }],
    materials: {
      ...manualPrinter.topology.materials,
      slots: [...manualPrinter.topology.materials.slots, {
        id: id<'slot'>('external-1'), unitId, name: 'External spool 1'
      }],
      paths: [...manualPrinter.topology.materials.paths, {
        id: id<'path'>('external-to-tool-1'), slotId: id<'slot'>('external-1'),
        toolId: id<'tool'>('tool-1'), loading: 'manual'
      }]
    }
  }
} satisfies PrinterDescriptor;
const door: SensorDefinition = {
  id: id<'sensor'>('door'),
  name: 'Door',
  location: null,
  kind: 'door',
  unit: null
};
// @ts-expect-error Door sensors cannot declare temperature units.
const invalidDoor: SensorDefinition = {
  ...door,
  unit: 'celsius'
};
// @ts-expect-error Generic numeric sensors require semantic identity.
const unnamedSensor: SensorDefinition = {
  id: sensorId,
  name: 'Custom',
  location: null,
  kind: 'numeric',
  unit: 'Pa'
};
declare const sensor: SensorState;
if (sensor.kind === 'door' && sensor.reading.kind === 'known') {
  const value: 'open' | 'closed' = sensor.reading.value;
  // @ts-expect-error The discriminant preserves the reading value type.
  const temperature: number = sensor.reading.value;
}
if (sensor.kind === 'acceleration' && sensor.reading.kind === 'known') {
  const x: number = sensor.reading.value.x;
}
declare function command(value: PrinterCommand): void;
command({
  type: 'materials.load',
  params: {
    pathId
  }
});
command({
  type: 'materials.load',
  params: {
    // @ts-expect-error A slot is not a material path.
    pathId: slotId
  }
});
command({
  type: 'thermal.setTarget',
  params: {
    // @ts-expect-error A sensor cannot be targeted as a heater.
    heaterId: sensorId,
    targetC: 30
  }
});
command({
  // @ts-expect-error There is no writable sensor command.
  type: 'sensors.write',
  params: {
    // @ts-expect-error No command accepts arbitrary sensor writes.
    sensorId,
    // @ts-expect-error No command accepts arbitrary sensor values.
    value: 30
  }
});
command({
  type: 'motion.home',
  params: {
    motionGroupId: motionId,
    // @ts-expect-error Homing must target at least one axis.
    axes: []
  }
});
// @ts-expect-error A union of names must preserve command/parameter correlation.
const mixed: CommandOf<'materials.load' | 'jobs.pause'> = {
  type: 'jobs.pause',
  params: {
    pathId
  }
};
const target: PrinterTarget = { printerId: manualPrinter.identity.id, routeId: id<'route'>('lan') };
const basis = {
  capabilityRevision: 'caps-1',
  topologyRevision: 'topology-1'
};
declare function submit(request: CommandRequest): void;
submit({
  target,
  requestId: id<'request'>('load'),
  command: {
    type: 'materials.load',
    params: {
      pathId
    }
  },
  guard: {
    ...basis,
    inventoryRevision: 'inventory-1'
  }
});
// A standalone command can omit comparison versions; execution still validates current conditions.
submit({
  target,
  requestId: id<'request'>('load'),
  command: {
    type: 'materials.load',
    params: {
      pathId
    }
  },
  guard: basis
});
submit({
  target,
  requestId: id<'request'>('heat'),
  command: {
    type: 'thermal.setTarget',
    params: {
      heaterId,
      targetC: 200
    }
  },
  guard: basis
});
const clearColor: MaterialMetadataPatch = {
  color: null
};
// @ts-expect-error Metadata edits cannot be empty.
const emptyPatch: MaterialMetadataPatch = {};
// @ts-expect-error Undefined is not an explicit clear or a supplied field.
const undefinedPatch: MaterialMetadataPatch = {
  color: undefined
};
declare const caps: CommandCapabilities;
if (caps['thermal.setTarget'].kind === 'supported') {
  const min: number | null = caps['thermal.setTarget'].constraints[0]?.targetC.min;
  // @ts-expect-error Heater capability constraints do not contain material paths.
  caps['thermal.setTarget'].constraints[0]?.pathId;
}
const remoteFile = {
  printerId: id<'printer'>('manual'),
  routeId: id<'route'>('lan'),
  configurationRevision: 'config-1',
  storageId: id<'storage'>('sd'),
  fileId: id<'remote-file'>('part'),
  contentRevision: null
};
const bestEffort: FileSelection = {
  consistency: 'best-effort',
  file: remoteFile
};
const strict: FileSelection = {
  consistency: 'require-version-match',
  file: {
    ...remoteFile,
    contentRevision: 'content-1'
  }
};
// @ts-expect-error Strict access cannot be requested without a known revision.
const unversioned: FileSelection = {
  consistency: 'require-version-match',
  file: remoteFile
};
declare const operation: PrinterOperation;
if (operation.kind === 'command' && operation.commandType === 'jobs.start' && operation.phase.kind === 'completed') {
  const result: null = operation.phase.result;
  // @ts-expect-error Start confirmation does not create a public print-task identity.
  operation.phase.result.jobId;
}
if (operation.kind === 'upload' && operation.phase.kind === 'completed') {
  const fileId: Id<'remote-file'> = operation.phase.result.ref.fileId;
}
declare const state: PrinterState;
// @ts-expect-error Measured temperature has one sensor owner, not a second heater field.
state.heaters[0]?.currentC;
// @ts-expect-error Snapshot collections cannot be mutated by a consumer.
state.sensors.push(sensor);
const emptyEvent: PrinterEvent = {
  type: 'replace',
  target,
  configurationRevision: 'config-1',
  cursor: 'next' as ObservationCursor,
  // @ts-expect-error Replacement events must include a changed section.
  values: {}
};

// The public extension point preserves structured reading types after augmentation.
declare module '@orca/printer-control/domain' {
  interface SensorTypeMap {
    'fixture:air-quality': {
      unit: null;
      value: {
        pm25: number;
        grade: 'good' | 'poor';
      };
    };
  }
}
declare const extended: SensorState;
if (extended.kind === 'fixture:air-quality' && extended.reading.kind === 'known') {
  const pm25: number = extended.reading.value.pm25;
  // @ts-expect-error Structured extension readings are not generic strings.
  const value: string = extended.reading.value;
}

// Native Web UI access is available directly from the service, without a preceding request.
declare const service: PrinterService;
const routeId = id<'route'>('lan');
const interfaceId = id<'web-interface'>('native-console');
service.webInterfaces.describe(target);
service.webInterfaces.resolve({ target, interfaceId });
service.webInterfaces.resolve({ target });
// @ts-expect-error A bare ID is not a complete target.
service.webInterfaces.describe(routeId);
// @ts-expect-error Resolve identifies the expected entry, not an arbitrary URL supplied by UI.
service.webInterfaces.resolve({ target, url: 'https://printer.example/' });

export const webOnlyAccess: WebInterfaceDescription = {
  printerId: id<'printer'>('web-only'), routeId,
  capability: { kind: 'supported', constraints: { id: interfaceId, name: 'Native console' } },
  availability: { kind: 'unknown', reason: 'Reachability has not been checked' },
  assessedAtMs: 0, freshness: 'stale',
};
const launch: WebInterfaceLaunch = {
  printerId: webOnlyAccess.printerId, routeId, interfaceId,
  url: 'https://printer.example/', expiresAtMs: null,
};
// @ts-expect-error Web UI launch data cannot carry executable URL schemes.
const executableUrl: WebInterfaceLaunch['url'] = 'javascript:alert(1)';
// @ts-expect-error Embedding compatibility is not promised by the provider's URL.
launch.canEmbed;

declare const capabilities: PrinterCapabilities;
const webCapability: WebInterfaceDescription['capability'] = capabilities.webInterface;
if (capabilities.observations.firmware.kind === 'supported') {
  const delivery: readonly ('push' | 'poll' | 'on-demand')[] = capabilities.observations.firmware.constraints.delivery;
}
service.observations.read({ target, topics: ['firmware'], source: 'device' });
declare const descriptor: PrinterDescriptor;
if (descriptor.firmware.kind === 'known') {
  const version: string | undefined = descriptor.firmware.value[0]?.version;
  const freshness: 'fresh' | 'stale' = descriptor.firmware.freshness;
}
// @ts-expect-error Read support does not introduce a firmware upgrade command.
const upgrade: CommandOf<'firmware.upgrade'> = {};
// @ts-expect-error Firmware inventory has a single owner in the descriptor.
state.firmware;
// @ts-expect-error UI page visibility is not an agent-controlled capability flag.
capabilities.showMonitorTab;

// Compile-only type profiles, not concrete agents or claims of device qualification.
const unknown = { kind: 'unknown', reason: 'Not established by this type or device' } as const;
const unknownCommands = {
  'jobs.start': unknown, 'jobs.pause': unknown, 'jobs.resume': unknown, 'jobs.cancel': unknown, 'jobs.setSpeed': unknown, 'hardware.refreshNozzles': unknown, 'actions.invoke': unknown,
  'thermal.setTarget': unknown, 'fans.setSpeed': unknown, 'lights.set': unknown,
  'motion.home': unknown, 'motion.jog': unknown, 'extrusion.move': unknown, 'tools.select': unknown,
  'materials.load': unknown, 'materials.unload': unknown, 'materials.switch': unknown,
  'materials.writeMetadata': unknown, 'materials.refreshTag': unknown,
  'drying.start': unknown, 'drying.stop': unknown,
  'camera.setEnabled': unknown, 'camera.setDeviceTimelapse': unknown, 'files.delete': unknown,
} satisfies CommandCapabilities;
export const moonrakerCapabilities: PrinterCapabilities = {
  submission: unknown, revision: 'type-1', commands: unknownCommands, cameras: [], currentPrintPreview: unknown,
  files: {
    list: { kind: 'unsupported', layer: 'adapter', reason: 'Upload-only type' },
    stat: unknown, download: unknown, preview: unknown, changes: unknown,
    upload: { kind: 'supported', constraints: [{
      destination: { kind: 'default' }, formats: ['gcode'], maxBytes: null,
      collisionPolicies: ['reject'],
    }] },
  },
  webInterface: { kind: 'supported', constraints: { id: interfaceId, name: 'Native console' } },
  observations: {
    descriptor: unknown, status: unknown, thermal: unknown, motion: unknown,
    actuators: unknown, materials: unknown, cameras: unknown, sensors: unknown,
    alerts: unknown, firmware: unknown,
  },
};
export const moonrakerRoute: PrinterRoute = {
  id: routeId, printerId: target.printerId, providerId: id<'provider'>('moonraker'),
  label: 'LAN', configurationRevision: 'config-1',
  configuration: {
    typeId: id<'printer-type'>('generic-moonraker'), hostId: id<'agent-host'>('browser'),
    channel: 'lan', address: 'http://192.0.2.10:7125/',
    webInterfaceUrl: 'http://192.0.2.10/', credentialRef: null,
  },
  capabilities: moonrakerCapabilities,
  management: { rename: true, configure: true, forget: true },
};
export const enumeratedPrinter: SavedPrinter = {
  identity: manualPrinter.identity, routes: [moonrakerRoute],
};
// The endpoint belongs to the agent, whose internal transports are not selected by callers.
export const automaticAgentRoute: PrinterRoute = {
  ...moonrakerRoute, id: id<'route'>('printer-agent'), providerId: id<'provider'>('bambu'),
  configuration: { ...moonrakerRoute.configuration, channel: 'automatic', address: null },
};
export const discoveredPrinter: DiscoveryCandidate = {
  id: id<'candidate'>('moonraker-lan'), providerId: moonrakerRoute.providerId,
  configuration: moonrakerRoute.configuration, capabilities: moonrakerCapabilities,
  displayName: 'Discovered printer', externalRefs: [], expiresAtMs: 1000, access: 'none',
};
export const manualSyncCapabilities: PrinterCapabilities = {
  ...moonrakerCapabilities,
  observations: {
    ...moonrakerCapabilities.observations,
    materials: { kind: 'supported', constraints: { delivery: ['on-demand'] } },
  },
};
export const u1Route: PrinterRoute = {
  ...moonrakerRoute, id: id<'route'>('u1-lan'),
  configuration: { ...moonrakerRoute.configuration, typeId: id<'printer-type'>('snapmaker-u1') },
  capabilities: manualSyncCapabilities,
};
// Support supplies usable request information; only individual limits may be unknown.
const pendingLimits: Capability<Range> = { kind: 'supported', constraints: { min: 0, max: null, step: null } };
// @ts-expect-error Supported capabilities cannot omit their request description.
const missingLimits: Capability<{ min: number }> = { kind: 'supported' };
// @ts-expect-error Capability identifiers are semantic, never UI visibility flags.
moonrakerCapabilities.showMonitorTab;
// @ts-expect-error No public connection lifecycle is available.
service.connect(routeId);
// @ts-expect-error Transport/session state is not a printer observation.
state.connection;

// Manual configuration and catalogue reads are independent local operations.
service.listTypes();
service.add({ requestId: id<'request'>('add'), displayName: 'Moonraker', routes: [moonrakerRoute.configuration] });
service.updateRoute({ target, configuration: moonrakerRoute.configuration });
service.describe(target);
service.adopt({ requestId: id<'request'>('adopt'), candidate: discoveredPrinter });
// @ts-expect-error Adding a printer requires at least one configured route.
service.add({ requestId: id<'request'>('empty-add'), displayName: 'Invalid', routes: [] });

// Upload does not require listing storage, retrieving topology or opening a connection.
declare const chunks: AsyncIterable<Uint8Array>;
service.files.upload({
  target, requestId: id<'request'>('upload'), destination: { kind: 'default' },
  fileName: 'part.gcode', format: 'gcode', sizeBytes: 100, collisionPolicy: 'reject',
}, { chunks });
service.files.listStorages(target);
service.files.list({ target, storageId: remoteFile.storageId, directoryId: null });
service.files.watchChanges(target);
// @ts-expect-error Listing is not implicitly bound to a selected printer.
service.files.list({ storageId: remoteFile.storageId, directoryId: null });
// @ts-expect-error Explicit target is required for independent control evaluation.
service.controls.evaluate({ type: 'jobs.pause', params: {} });
service.controls.submit({ target, requestId: id<'request'>('start'), command: {
  type: 'jobs.start', params: { source: bestEffort, bindings: [] },
} });
// @ts-expect-error A command cannot use an implicit current printer.
service.controls.submit({ requestId: id<'request'>('missing-target'), command: { type: 'jobs.start', params: { source: bestEffort, bindings: [] } } });

async function manualMaterialsSync() {
  const result = await service.observations.read({ target, topics: ['materials'], source: 'device' });
  if (result.ok && result.value.values.materials.kind === 'known') {
    const inventory: MaterialInventory = result.value.values.materials.value;
    // @ts-expect-error A material-only read does not manufacture unrelated state.
    result.value.values.firmware;
    return inventory.state.inventoryRevision;
  }
}
service.observations.read({ target, topics: ['materials'], source: 'cache' });
// @ts-expect-error The caller must choose cached access or explicit device I/O.
service.observations.read({ target, topics: ['materials'] });
// @ts-expect-error An empty read cannot trigger an implicit full device discovery.
service.observations.read({ target, topics: [], source: 'device' });
service.observations.watch({ target, topics: ['status', 'sensors'] });

// Media resources are usable through an independent service reference and explicit ID.
declare const otherService: PrinterService;
declare const mediaRef: MediaRef;
service.media.open({ target, requestId: id<'request'>('view'), source: { kind: 'camera', cameraId: id<'camera'>('chamber') }, client: { video: [], imageMimeTypes: ['image/jpeg'], contentFormats: [] } });
otherService.media.watch(mediaRef);
otherService.media.renew(mediaRef);
otherService.media.close(mediaRef);
otherService.media.captureSnapshot(target, id<'camera'>('chamber'));
// @ts-expect-error A media operation requires its explicit resource reference.
otherService.media.close();
// @ts-expect-error Operations have configuration provenance, not a connection epoch.
operation.originEpoch;

// No capability can erase its entire request description, including parameter-free controls.
// @ts-expect-error Null cannot be used as the capability constraint type.
type NullCapability = Capability<null>;
// @ts-expect-error Supported temperature control needs resource IDs and range descriptors.
const nullHeaters: CommandCapabilities['thermal.setTarget'] = { kind: 'supported', constraints: null };
const pauseCapability: CommandCapabilities['jobs.pause'] = { kind: 'supported', constraints: {} };
const resumeCapability: CommandCapabilities['jobs.resume'] = { kind: 'supported', constraints: {} };
const cancelCapability: CommandCapabilities['jobs.cancel'] = { kind: 'supported', constraints: {} };
// @ts-expect-error No extra constraints means an explicit empty object, not null.
const nullPause: CommandCapabilities['jobs.pause'] = { kind: 'supported', constraints: null };
// @ts-expect-error The empty descriptor does not allow invented options.
const extraPause: CommandCapabilities['jobs.pause'] = { kind: 'supported', constraints: { mode: 'fast' } };
const heaterCapability: CommandCapabilities['thermal.setTarget'] = {
  kind: 'supported', constraints: [{ heaterId, targetC: { min: 0, max: null, step: null } }],
};
if (heaterCapability.kind === 'supported') {
  const heater = heaterCapability.constraints[0];
  const maximum: number | null = heater.targetC.max;
  service.controls.submit({ target, requestId: id<'request'>('set-temperature'), command: {
    type: 'thermal.setTarget', params: { heaterId: heater.heaterId, targetC: 200 },
  } });
}
// @ts-expect-error A supported resource-scoped command must provide at least one target.
const emptyHeaters: CommandCapabilities['thermal.setTarget'] = { kind: 'supported', constraints: [] };
// @ts-expect-error Unknown limits cannot erase the containing range descriptor.
const nullRange: CommandCapabilities['thermal.setTarget'] = { kind: 'supported', constraints: [{ heaterId, targetC: null }] };
// @ts-expect-error Writable metadata capability needs at least one writable field.
const emptyWrites: CommandCapabilities['materials.writeMetadata'] = { kind: 'supported', constraints: [{ slotId, writableFields: [] }] };
// @ts-expect-error Supported upload must name a destination and its request choices.
const emptyUpload: FileCapabilities['upload'] = { kind: 'supported', constraints: [] };
// @ts-expect-error No supported format leaves no usable upload request.
const emptyFormats: FileCapabilities['upload'] = { kind: 'supported', constraints: [{ destination: { kind: 'default' }, formats: [], maxBytes: null, collisionPolicies: ['reject'] }] };
// @ts-expect-error Collision policy is required request information, not an unknown limit.
const nullPolicies: FileCapabilities['upload'] = { kind: 'supported', constraints: [{ destination: { kind: 'default' }, formats: ['gcode'], maxBytes: null, collisionPolicies: null }] };
// @ts-expect-error File-list support must identify at least one storage scope.
const emptyStorages: FileCapabilities['list'] = { kind: 'supported', constraints: { storageIds: [], kinds: ['print-file'] } };
// @ts-expect-error Snapshot support must describe at least one image format.
const emptySnapshotFormats: CameraMediaCapability['snapshot'] = { kind: 'supported', constraints: { mimeTypes: [] } };
const defaultCamera: CameraMediaCapability['liveView'] = {
  kind: 'supported', constraints: { transports: ['mjpeg'], profiles: [], maxConcurrentViews: null, requestIdRetentionMs: 300_000 },
};
// @ts-expect-error A live-view capability must provide a delivery transport.
const emptyTransports: CameraMediaCapability['liveView'] = { kind: 'supported', constraints: { transports: [], profiles: [], maxConcurrentViews: null, requestIdRetentionMs: 300_000 } };
// @ts-expect-error Observation support must specify a usable delivery mode.
const emptyDelivery: PrinterCapabilities['observations']['materials'] = { kind: 'supported', constraints: { delivery: [] } };
// @ts-expect-error Discovery support must identify at least one supported scope kind.
const emptyDiscovery: ProviderDescriptor['hosts'][number]['discovery'] = { kind: 'supported', constraints: { kinds: [] } };
// @ts-expect-error Web support needs a resolvable entry identity, not an empty descriptor.
const missingWebEntry: PrinterCapabilities['webInterface'] = { kind: 'supported', constraints: {} };

// Construct Moonraker's upload entirely from its locally declared request choices.
if (moonrakerCapabilities.files.upload.kind === 'supported') {
  const choice = moonrakerCapabilities.files.upload.constraints[0];
  service.files.upload({ target, requestId: id<'request'>('declared-upload'),
    destination: choice.destination, format: choice.formats[0],
    collisionPolicy: choice.collisionPolicies[0], fileName: 'part.gcode', sizeBytes: 100,
  }, { chunks });
}

// Sensor-only adapters can return interpretable data without a full descriptor.
const sensorOnlyObservations = {
  sensors: { kind: 'supported', constraints: { delivery: ['on-demand'] } },
  descriptor: { kind: 'unsupported', layer: 'adapter', reason: 'Sensor-only adapter' },
} satisfies Pick<PrinterCapabilities['observations'], 'sensors' | 'descriptor'>;
const particleSensorId = id<'sensor'>('chamber-pm25');
const airQualitySensorId = id<'sensor'>('air-quality');
export const sensorSnapshot: SensorSnapshot = {
  definitionRevision: 'sensor-definitions-1',
  definitions: [...enclosedPrinter.topology.sensors, {
    id: particleSensorId, name: 'Chamber particles', location: 'Chamber',
    kind: 'numeric', unit: 'µg/m³', semanticType: 'air:pm2.5',
  }, {
    id: airQualitySensorId, name: 'Air quality', location: 'Chamber',
    kind: 'fixture:air-quality', unit: null,
  }],
  readings: [{
    sensorId: id<'sensor'>('chamber'), kind: 'temperature',
    reading: { kind: 'unknown', reason: 'not-reported' },
  }, {
    sensorId: id<'sensor'>('door'), kind: 'door',
    reading: { kind: 'known', value: 'closed', sourceRouteId: routeId,
      freshness: 'fresh', observedAtMs: null, receivedAtMs: 100 },
  }, {
    sensorId: particleSensorId, kind: 'numeric',
    reading: { kind: 'known', value: 42, sourceRouteId: routeId,
      freshness: 'fresh', observedAtMs: null, receivedAtMs: 100 },
  }, {
    sensorId: airQualitySensorId, kind: 'fixture:air-quality',
    reading: { kind: 'known', value: { pm25: 42, grade: 'poor' }, sourceRouteId: routeId,
      freshness: 'fresh', observedAtMs: null, receivedAtMs: 100 },
  }],
};
async function readSensorsWithoutDescriptor() {
  const result = await service.observations.read({ target, topics: ['sensors'], source: 'device' });
  if (!result.ok || result.value.values.sensors.kind !== 'known') return;
  const snapshot = result.value.values.sensors.value;
  const definitions = new Map(snapshot.definitions.map(definition => [definition.id, definition]));
  const definitionRevision: string = snapshot.definitionRevision;
  for (const state of snapshot.readings) {
    const definition = definitions.get(state.sensorId);
    if (definition?.kind === 'numeric' && state.kind === 'numeric' && state.reading.kind === 'known') {
      const semanticType: string = definition.semanticType;
      const unit: string | null = definition.unit;
      const value: number = state.reading.value;
    }
    if (state.kind === 'fixture:air-quality' && state.reading.kind === 'known') {
      const grade: 'good' | 'poor' = state.reading.value.grade;
    }
  }
  // @ts-expect-error Sensor-only reads do not require or manufacture a descriptor topic.
  result.value.values.descriptor;
}
const sensorUpdate: PrinterEvent<'sensors'> = {
  type: 'replace', target, configurationRevision: 'config-1',
  cursor: 'sensor-next' as ObservationCursor,
  values: { sensors: { kind: 'known', value: sensorSnapshot, sourceRouteId: routeId,
    freshness: 'fresh', observedAtMs: null, receivedAtMs: 100 } },
};
// @ts-expect-error A bare reading list is no longer a valid sensor-topic payload.
const bareSensorReadings: SensorSnapshot = sensorSnapshot.readings;
// @ts-expect-error Readings without their definitions cannot form a snapshot.
const missingSensorDefinitions: SensorSnapshot = { definitionRevision: '1', readings: [] };
// @ts-expect-error The definition revision is required even when readings are unavailable.
const missingSensorRevision: SensorSnapshot = { definitions: [], readings: [] };
// @ts-expect-error Consumers cannot mutate a snapshot's definition collection.
sensorSnapshot.definitions.push(door);
// @ts-expect-error Consumers cannot mutate a snapshot's reading collection.
sensorSnapshot.readings.push(sensor);
const bareSensorEvent: PrinterEvent<'sensors'> = {
  ...sensorUpdate,
  values: { sensors: { kind: 'known', sourceRouteId: routeId,
    freshness: 'fresh', observedAtMs: null, receivedAtMs: 100,
    // @ts-expect-error Replacement events must include the complete sensor snapshot too.
    value: sensorSnapshot.readings,
  } },
};

// Preview enumeration and opening work even when general file stat is unsupported.
const previewWithoutStat = {
  preview: { kind: 'supported', constraints: [{
    storageId: remoteFile.storageId, kinds: ['thumbnail', 'video', 'toolpath'],
    versionCheck: 'best-effort',
  }] },
  stat: { kind: 'unsupported', layer: 'adapter', reason: 'No general file metadata endpoint' },
} satisfies Pick<FileCapabilities, 'preview' | 'stat'>;
async function openRemotePreviewWithoutStat() {
  if (previewWithoutStat.preview.kind !== 'supported') return;
  const result = await service.files.listPreviews(bestEffort);
  if (!result.ok) return result.error;
  const listing = result.value;
  const option = listing.options[0];
  if (!option) return; // No preview for this file is a valid result.
  return otherService.media.open({
    target: { printerId: listing.file.printerId, routeId: listing.file.routeId,
      expectedConfigurationRevision: listing.file.configurationRevision },
    requestId: id<'request'>('remote-preview'),
    source: { kind: 'file-preview', previewId: option.id,
      target: { consistency: 'best-effort', file: listing.file } },
    client: { video: [{ transport: 'progressive-http', codecIds: ['h264'] }],
      imageMimeTypes: ['image/jpeg'], contentFormats: ['gcode'] },
  });
}
const noPreviews: FilePreviewListing = { file: remoteFile, options: [] };
// @ts-expect-error Preview options require the assessed file identity/version.
const unboundPreviews: FilePreviewListing = { options: [] };
// @ts-expect-error Option enumeration requires an explicit file selection and consistency policy.
service.files.listPreviews({ file: remoteFile });
// @ts-expect-error Strict option queries require a known content revision.
service.files.listPreviews({ consistency: 'require-version-match', file: remoteFile });
declare const fileDetails: RemoteFileDetails;
// @ts-expect-error Preview options have a single owner, independent of stat.
fileDetails.previews;

// A union of possible topics does not prove every member appears in the request.
async function readDynamicTopics() {
  const request: ObservationRequest<'materials' | 'firmware'> = {
    target, topics: ['materials'],
  };
  const result = await service.observations.read({ ...request, source: 'device' });
  if (!result.ok) return;
  // @ts-expect-error Firmware was only a possible topic, not a guaranteed selection.
  result.value.values.firmware.kind;
  const firmware = result.value.values.firmware;
  if (firmware?.kind === 'known') {
    const components: readonly FirmwareComponent[] = firmware.value;
  }
  const materials = result.value.values.materials;
  if (materials?.kind === 'known') {
    const inventory: MaterialInventory = materials.value;
  }
  // @ts-expect-error Topics outside the possible selection remain inaccessible.
  result.value.values.sensors;

  const explicit = await service.observations.read<'materials' | 'firmware'>({
    target, topics: ['materials'], source: 'cache',
  });
  if (explicit.ok) {
    // @ts-expect-error Explicitly widening the generic cannot manufacture firmware data.
    explicit.value.values.firmware.kind;
  }
}
async function readWidenedRequest(request: ObservationRequest) {
  const result = await service.observations.read({ ...request, source: 'cache' });
  if (result.ok) {
    // @ts-expect-error A default-typed request does not select all printer topics.
    result.value.values.descriptor.kind;
  }
}
async function watchDynamicTopics(request: ObservationRequest<'materials' | 'firmware'>) {
  for await (const event of service.observations.watch(request)) {
    if (event.type === 'snapshot') {
      // @ts-expect-error Initial/reset snapshots do not promise every possible topic.
      event.snapshot.values.firmware.kind;
      const firmware = event.snapshot.values.firmware;
      if (firmware?.kind === 'known') {
        const components: readonly FirmwareComponent[] = firmware.value;
      }
    } else {
      // @ts-expect-error A replacement may update only materials.
      event.values.firmware.kind;
    }
  }
}
const materialOnlySnapshot: PrinterSnapshot<'materials' | 'firmware'> = {
  target, configurationRevision: 'config-1',
  values: { materials: { kind: 'unknown', reason: 'unavailable' } },
};
const emptySnapshot: PrinterSnapshot = {
  target, configurationRevision: 'config-1',
  // @ts-expect-error Even a dynamically selected snapshot must have at least one topic.
  values: {},
};
const materialOnlyEvent: PrinterEvent<'materials' | 'firmware'> = {
  type: 'snapshot', cursor: 'material-next' as ObservationCursor,
  snapshot: materialOnlySnapshot,
};
async function readLiteralTopics() {
  const result = await service.observations.read({ target, topics: ['materials', 'firmware'], source: 'cache' });
  if (!result.ok) return;
  // The public contract is conservative even for a literal multi-topic list.
  const firmware = result.value.values.firmware;
  if (firmware?.kind === 'known') {
    const components: readonly FirmwareComponent[] = firmware.value;
  }
}

// Discovery choices belong to their execution host; there is no provider-wide cross product.
const discoveryProvider = {
  id: id<'provider'>('multi-host'), name: 'Multiple execution hosts',
  hosts: [{
    id: id<'agent-host'>('desktop-lan'), name: 'Desktop LAN', execution: 'desktop',
    discovery: { kind: 'supported', constraints: { kinds: ['lan'] } },
  }, {
    id: id<'agent-host'>('service-account'), name: 'Account service', execution: 'service',
    discovery: { kind: 'supported', constraints: { kinds: ['account'] } },
  }, {
    id: id<'agent-host'>('manual-browser'), name: 'Manual browser', execution: 'browser',
    discovery: { kind: 'unsupported', layer: 'adapter', reason: 'Manual configuration only' },
  }],
} satisfies ProviderDescriptor;
function discoverOnSupportedHosts(provider: ProviderDescriptor) {
  for (const host of provider.hosts) {
    if (host.discovery.kind !== 'supported') continue;
    for (const kind of host.discovery.constraints.kinds) {
      if (kind === 'lan') {
        service.discover(provider.id, { kind, hostId: host.id });
      } else {
        service.discover(provider.id, { kind, hostId: host.id });
      }
    }
  }
}
const providerWithoutHosts: ProviderDescriptor = {
  id: id<'provider'>('unhosted'), name: 'Unhosted provider', hosts: [],
};
// @ts-expect-error Supported discovery cannot omit its execution-host identity.
const supportedWithoutHostId: ProviderDescriptor['hosts'][number] = {
  name: 'Missing identity', execution: 'desktop',
  discovery: { kind: 'supported', constraints: { kinds: ['lan'] } },
};
const providerWideDiscovery: ProviderDescriptor = {
  id: id<'provider'>('invalid'), name: 'No host', hosts: [],
  // @ts-expect-error Discovery support belongs to a host; no top-level support escape hatch remains.
  discovery: { kind: 'supported', constraints: { kinds: ['lan'] } },
};
// @ts-expect-error Even a LAN discovery call needs an explicit host identity.
service.discover(discoveryProvider.id, { kind: 'lan' });
// Account-scoped discovery uses the provider-owned current account.
service.discover(discoveryProvider.id, { kind: 'account', hostId: id<'agent-host'>('service-account') });

// Proposal provenance is captured with the inventory, not refreshed from route configuration.
function prepareImportFixture(snapshot: PrinterSnapshot<'materials'>, projectRevision: Revision): MaterialImportProposal | null {
  const reading = snapshot.values.materials;
  if (reading.kind !== 'known') return null;
  return {
    printerId: snapshot.target.printerId,
    routeId: snapshot.target.routeId,
    configurationRevision: snapshot.configurationRevision,
    topologyRevision: reading.value.topologyRevision,
    inventoryRevision: reading.value.state.inventoryRevision,
    projectRevision,
    candidates: [], emptySlotIds: [], unresolvedSlots: [],
  };
}
declare const importProposal: MaterialImportProposal;
const importConfiguration: Revision = importProposal.configurationRevision;
const { configurationRevision: sourceConfiguration, ...unversionedImportProposal } = importProposal;
// @ts-expect-error Device/project revision tokens do not replace source configuration provenance.
const missingImportConfiguration: MaterialImportProposal = unversionedImportProposal;
// @ts-expect-error Unknown configuration provenance cannot form an applicable proposal.
const nullImportConfiguration: MaterialImportProposal = { ...importProposal, configurationRevision: null };

// Display state does not depend on a start command, source file or native job identity.
const printStatus: PrintStatus = state.printStatus;
// @ts-expect-error Print observations are not app task records.
printStatus.id;
// @ts-expect-error No legacy job snapshot alias.
state.job;
// @ts-expect-error Ordinary controls accept no job selector.
command({ type: 'jobs.pause', params: { jobId: id<'job'>('native') } });
command({ type: 'jobs.pause', params: {} });
command({ type: 'jobs.resume', params: {} });
command({ type: 'jobs.cancel', params: {} });

// Fixtures stand in for agent-issued context; applications only pass it through.
const actionRef: PrinterActionRef = { ...target, configurationRevision: 'config-1', token: id<'action-context'>('opaque-agent-data') };
const action: PrinterAction = { actionRef, label: 'Resume after resolving warning', description: null, availability: { kind: 'available' }, expiresAtMs: null };
const actionCapability: CommandCapabilities['actions.invoke'] = { kind: 'supported', constraints: { sources: ['status', 'alerts'] } };
// @ts-expect-error Supported actions must identify at least one source for references.
const noActionSource: CommandCapabilities['actions.invoke'] = { kind: 'supported', constraints: { sources: [] } };
// @ts-expect-error Context must carry configuration provenance.
const unscopedAction: PrinterActionRef = { ...target, token: actionRef.token };
// @ts-expect-error Native job IDs are not actionable references.
const nativeAction: PrinterActionRef = { ...actionRef, token: id<'job'>('native') };
// @ts-expect-error Actions cannot introduce arbitrary vendor request parameters.
command({ type: 'actions.invoke', params: { actionRef, jobId: 'native', errorCode: 'error' } });
otherService.controls.submit({ target, requestId: id<'request'>('action'), command: { type: 'actions.invoke', params: { actionRef: action.actionRef } } });
async function invokeObservedAction() {
  const result = await service.observations.read({ target, topics: ['status', 'alerts'], source: 'device' });
  if (!result.ok) return;
  const { status, alerts } = result.value.values;
  const general = status?.kind === 'known' && status.value.actions.kind === 'known' ? status.value.actions.value : [];
  const contextual = alerts?.kind === 'known' ? alerts.value.flatMap(alert => alert.actions) : [];
  for (const action of [...general, ...contextual]) {
    if (action.availability.kind === 'available') {
      // No subscription/evaluation token or app-submitted task correlation is required.
      await otherService.controls.submit({ target, requestId: id<'request'>(crypto.randomUUID()), command: { type: 'actions.invoke', params: { actionRef: action.actionRef } } });
    }
  }
}

// Common provider identity composes independent capability interfaces.
import type { AccountProvider } from '@orca/service-provider';
import type { PrinterProvider } from '../src/domain';
interface CombinedProvider extends AccountProvider, PrinterProvider {}
declare const combinedProvider: CombinedProvider;
void combinedProvider.account.login();
void combinedProvider.printers.listSaved();
declare const printerOnly: PrinterProvider;
// @ts-expect-error Printer-only providers do not require accounts.
printerOnly.account;
// @ts-expect-error Printer callers never supply account identity.
service.discover(discoveryProvider.id, { kind: 'account', hostId: id<'agent-host'>('desktop'), accountRef: 'private' });
// @ts-expect-error Forgetting must identify a route, not remove a whole multi-route device.
service.forget(target.printerId);
void service.forget(target);
void service.authorize({ requestId: id<'request'>('authorize'), candidate: { ...discoveredPrinter, access: 'access-code' }, accessCode: 'transient-input' });

// Current-task media and controls require no previous observation or Neo job.
service.media.readCurrentPrintPreview(target).then(result => {
  if (result.ok) {
    const task: Id<'device-task'> = result.value.taskId;
    const bytes: Uint8Array = result.value.bytes;
  }
});
const speedCapability: CommandCapabilities['jobs.setSpeed'] = {
  kind: 'supported', constraints: { modes: [{ id: 'standard', label: 'Standard' }] },
};
if (speedCapability.kind === 'supported') {
  service.controls.submit({ target, requestId: id<'request'>('speed'), command: {
    type: 'jobs.setSpeed', params: { modeId: speedCapability.constraints.modes[0].id },
  } });
}
// @ts-expect-error Supported speed control requires selectable modes.
const emptySpeedModes: CommandCapabilities['jobs.setSpeed'] = { kind: 'supported', constraints: { modes: [] } };
command({ type: 'hardware.refreshNozzles', params: {} });
service.controls.submit({ target, requestId: id<'request'>('cancel-current'),
  command: { type: 'jobs.cancel', params: {} }, guard: { expectedTaskId: id<'device-task'>('observed-task') } });

// Firmware steps do not claim a physical distance or a caller-controlled speed.
const stepJog: CommandOf<'motion.jog'> = { type: 'motion.jog', params: { motionGroupId: 'gantry' as Id<'motion'>, axis: 'x', kind: 'step', stepId: 'small', direction: 'positive' } };
const firmwareExtrusion: CommandOf<'extrusion.move'> = { type: 'extrusion.move', params: { extruderId: 'extruder' as Id<'extruder'>, distanceMm: 10, speed: { kind: 'device-controlled' } } };
void stepJog; void firmwareExtrusion;

// Media descriptors alone construct playback; no observation/session preflight.
async function consumeCamera(descriptor: import('@orca/printer-control/domain').MediaDescriptor) {
  if (descriptor.presentation.kind !== 'video') return;
  const delivery = descriptor.presentation.delivery;
  if ('streamId' in delivery) {
    for await (const packet of otherService.media.readStream({ media: descriptor.ref, streamId: delivery.streamId })) {
      const bytes: Uint8Array = packet.bytes;
      if (packet.kind === 'init') { const mime: string = packet.mimeType; }
      // @ts-expect-error All packets do not carry decoder configuration.
      packet.mimeType;
    }
  } else if ('url' in delivery) {
    const credentials: 'same-origin' | 'include' = delivery.credentials;
  }
}
// @ts-expect-error Raw strings cannot invent host-issued stream identities.
service.media.readStream({ media: mediaRef, streamId: 'stream' });
// @ts-expect-error A binary stream has no remote URL.
const invalidBinary: import('@orca/printer-control/domain').VideoDelivery = { transport: 'jpeg-frames', url: 'https://example.org' };
