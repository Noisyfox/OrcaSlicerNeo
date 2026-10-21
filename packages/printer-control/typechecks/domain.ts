// Compile-only consumers of the public entrypoint. Never imported by runtime code.
import type { CommandCapabilities, CommandOf, CommandRequest, FileSelection, Id, MaterialMetadataPatch, PrinterCommand, PrinterDescriptor, PrinterEvent, PrinterOperation, PrinterState, SensorDefinition, SensorState } from '@orca/printer-control/domain';
import type { PrinterCapabilities, PrinterService, PrinterSession, WebInterfaceDescription, WebInterfaceLaunch } from '@orca/printer-control/domain';

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
const basis = {
  sessionId: id<'session'>('session'),
  epoch: id<'connection-epoch'>('connection'),
  capabilityRevision: 'caps-1',
  topologyRevision: 'topology-1'
};
declare function submit(request: CommandRequest): void;
submit({
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
// @ts-expect-error Material commands need inventory context, not just a topology revision.
submit({
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
  const min: number | undefined = caps['thermal.setTarget'].constraints[0]?.targetC.min;
  // @ts-expect-error Heater capability constraints do not contain material paths.
  caps['thermal.setTarget'].constraints[0]?.pathId;
}
const remoteFile = {
  printerId: id<'printer'>('manual'),
  routeId: id<'route'>('lan'),
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
  cursor: {
    sessionId: basis.sessionId,
    epoch: basis.epoch,
    sequence: 1
  },
  // @ts-expect-error Replacement events must include a changed section.
  sections: {}
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

// Native Web UI access is available directly from the service, without connect().
declare const service: PrinterService;
const routeId = id<'route'>('lan');
const interfaceId = id<'web-interface'>('native-console');
service.webInterfaces.describe(routeId);
service.webInterfaces.resolve({ routeId, interfaceId });
// @ts-expect-error A control session ID is not a route ID.
service.webInterfaces.describe(id<'session'>('session'));
// @ts-expect-error Resolve identifies the expected entry, not an arbitrary URL supplied by UI.
service.webInterfaces.resolve({ routeId, url: 'https://printer.example/' });

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
declare const session: PrinterSession;
session.refresh(['firmware']);
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
