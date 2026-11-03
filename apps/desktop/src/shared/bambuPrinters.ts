import type * as D from '@orca/printer-control/domain';
import type { BambuDevice } from './bambuDevices';
const providerId = 'bambu' as D.Id<'provider'>;
const hostId = 'desktop' as D.Id<'agent-host'>;
const typeId = 'bambu-network' as D.Id<'printer-type'>;
const unsupported = { kind: 'unsupported', layer: 'adapter', reason: 'This operation is not supported by the Bambu adapter.' } as const;
export function bambuCapabilities(): D.PrinterCapabilities {
  return {
    revision: 'bambu-storage-1', submission: { kind: 'supported', constraints: { formats: ['print-3mf'] } },
    commands: {
      'jobs.start': unsupported, 'jobs.pause': unsupported, 'jobs.resume': unsupported, 'jobs.cancel': unsupported, 'jobs.setSpeed': unsupported, 'jobs.skipObjects': unsupported, 'hardware.refreshNozzles': unsupported, 'actions.invoke': unsupported,
      'thermal.setTarget': unsupported, 'fans.setSpeed': unsupported, 'lights.set': unsupported, 'motion.home': unsupported,
      'motion.jog': unsupported, 'extrusion.move': unsupported, 'tools.select': unsupported,
      'materials.load': unsupported, 'materials.unload': unsupported, 'materials.switch': unsupported,
      'materials.writeMetadata': unsupported, 'materials.configure': unsupported, 'materials.refreshTag': unsupported, 'drying.start': unsupported, 'drying.stop': unsupported,
      'camera.setEnabled': unsupported, 'camera.setDeviceTimelapse': unsupported, 'files.delete': unsupported,
    },
    cameras: [], currentPrintPreview: unsupported, webInterface: unsupported,
    files: { upload: unsupported, list: { kind: 'unknown', reason: 'Open Storage to discover available printer storage.' },
      stat: { kind: 'unknown', reason: 'File information requires authorized storage access.' }, download: unsupported, preview: unsupported, changes: unsupported },
    observations: { printObjects: unsupported, descriptor: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, status: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, firmware: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, thermal: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, motion: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } },
      actuators: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, materials: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, cameras: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, sensors: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } }, alerts: { kind: 'supported', constraints: { delivery: ['push', 'on-demand'] } } },
  };
}
export function savedBambuPrinter(device: BambuDevice): D.SavedPrinter {
  const printerId = `bambu:${encodeURIComponent(device.deviceId)}` as D.Id<'printer'>;
  const lan = device.routes.find(route => route.channel === 'lan');
  const revision = JSON.stringify(device.routes.map(route => [route.channel, route.revision]).sort((a, b) => a[0].localeCompare(b[0])));
  return {
    identity: { id: printerId, displayName: device.name, manufacturer: 'Bambu Lab', model: device.model, serialNumber: device.deviceId,
      externalRefs: [{ namespace: 'bambu', value: device.deviceId }] },
    routes: [{ id: `${printerId}:agent` as D.Id<'route'>, printerId, providerId,
      label: 'Bambu Lab', configurationRevision: revision,
      configuration: { typeId, hostId, channel: 'automatic', address: lan?.address ?? null, webInterfaceUrl: null, credentialRef: lan ? `bambu-lan:${encodeURIComponent(device.deviceId)}` as D.Id<'credential'> : null },
      management: { rename: false, configure: false, forget: !!lan }, capabilities: bambuCapabilities(),
    }],
  };
}
