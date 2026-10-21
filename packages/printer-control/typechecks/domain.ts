// Compile-only consumers of the public entrypoint. Never imported by runtime code.
import type { CommandCapabilities, CommandOf, CommandRequest, FileSelection, Id, MaterialMetadataPatch, PrinterCommand, PrinterDescriptor, PrinterEvent, PrinterOperation, PrinterState, SensorDefinition, SensorState } from '@orca/printer-control/domain';
import type { PrinterCapabilities, PrinterService, WebInterfaceDescription, WebInterfaceLaunch } from '@orca/printer-control/domain';
import type { Capability, DiscoveryCandidate, PrinterRoute, SavedPrinter, PrinterTarget, ObservationCursor, MediaRef, MaterialInventory } from '@orca/printer-control/domain';

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
      constructionMaterial: 'brass',
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
      constructionMaterial: null,
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
const mixed: CommandOf<'materials.load' | 'jobs.pause'> = {
  type: 'jobs.pause',
  params: {
    // @ts-expect-error A union of names must preserve command/parameter correlation.
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
if (caps['thermal.setTarget'].kind === 'supported' && caps['thermal.setTarget'].constraints !== null) {
  const min: number | undefined = caps['thermal.setTarget'].constraints[0]?.targetC.min;
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
  const jobId: Id<'job'> = operation.phase.result.jobId;
  // @ts-expect-error Start completion returns a job identity, not an uploaded file.
  operation.phase.result.ref;
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
if (capabilities.observations.firmware.kind === 'supported' && capabilities.observations.firmware.constraints !== null) {
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
  'jobs.start': unknown, 'jobs.pause': unknown, 'jobs.resume': unknown, 'jobs.cancel': unknown,
  'thermal.setTarget': unknown, 'fans.setSpeed': unknown, 'lights.set': unknown,
  'motion.home': unknown, 'motion.jog': unknown, 'extrusion.move': unknown, 'tools.select': unknown,
  'materials.load': unknown, 'materials.unload': unknown, 'materials.switch': unknown,
  'materials.writeMetadata': unknown, 'materials.refreshTag': unknown,
  'drying.start': unknown, 'drying.stop': unknown,
  'camera.setEnabled': unknown, 'camera.setDeviceTimelapse': unknown, 'files.delete': unknown,
} satisfies CommandCapabilities;
export const moonrakerCapabilities: PrinterCapabilities = {
  revision: 'type-1', commands: unknownCommands, cameras: [],
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
    descriptor: unknown, job: unknown, thermal: unknown, motion: unknown,
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
    webInterfaceUrl: 'http://192.0.2.10/', accountRef: null, credentialRef: null,
  },
  capabilities: moonrakerCapabilities,
};
export const enumeratedPrinter: SavedPrinter = {
  identity: manualPrinter.identity, routes: [moonrakerRoute],
};
export const discoveredPrinter: DiscoveryCandidate = {
  id: id<'candidate'>('moonraker-lan'), providerId: moonrakerRoute.providerId,
  configuration: moonrakerRoute.configuration, capabilities: moonrakerCapabilities,
  displayName: 'Discovered printer', externalRefs: [], expiresAtMs: 1000,
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
// Known support can be declared before resource-specific limits have been learned.
const pendingLimits: Capability<{ min: number; max: number }> = { kind: 'supported', constraints: null };
// @ts-expect-error Supported capabilities explicitly distinguish unresolved constraints.
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
service.controls.evaluate({ type: 'jobs.pause', params: { jobId: id<'job'>('print') } });
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
service.observations.watch({ target, topics: ['job', 'sensors'] });

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
