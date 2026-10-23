import type { AccountProvider } from '@orca/service-provider';
import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';
import type { BambuDevice } from '../../../shared/bambuDevices';

const providerId = 'bambu' as D.Id<'provider'>;
const hostId = 'desktop' as D.Id<'agent-host'>;
const typeId = 'bambu-network' as D.Id<'printer-type'>;
const unsupported = { kind: 'unsupported', layer: 'adapter', reason: 'This Bambu integration provides account and device discovery only.' } as const;
const reject = async (): Promise<D.Result<never>> => ({ ok: false, error: { code: 'unsupported', message: unsupported.reason } });
const stream = async function* (): AsyncIterable<never> { throw new Error(unsupported.reason); };
const submission = async (): Promise<D.Submission> => ({ kind: 'rejected', error: { code: 'unsupported', message: unsupported.reason } });
function capabilities(): D.PrinterCapabilities {
  return {
    revision: 'bambu-discovery-1',
    commands: {
      'jobs.start': unsupported, 'jobs.pause': unsupported, 'jobs.resume': unsupported, 'jobs.cancel': unsupported, 'actions.invoke': unsupported,
      'thermal.setTarget': unsupported, 'fans.setSpeed': unsupported, 'lights.set': unsupported, 'motion.home': unsupported,
      'motion.jog': unsupported, 'extrusion.move': unsupported, 'tools.select': unsupported,
      'materials.load': unsupported, 'materials.unload': unsupported, 'materials.switch': unsupported,
      'materials.writeMetadata': unsupported, 'materials.refreshTag': unsupported, 'drying.start': unsupported, 'drying.stop': unsupported,
      'camera.setEnabled': unsupported, 'camera.setDeviceTimelapse': unsupported, 'files.delete': unsupported,
    },
    cameras: [], webInterface: unsupported,
    files: { upload: unsupported, list: unsupported, stat: unsupported, download: unsupported, preview: unsupported, changes: unsupported },
    observations: { descriptor: unsupported, status: unsupported, firmware: unsupported, thermal: unsupported, motion: unsupported,
      actuators: unsupported, materials: unsupported, cameras: unsupported, sensors: unsupported, alerts: unsupported },
  };
}
function saved(device: BambuDevice): D.SavedPrinter {
  const printerId = `bambu:${encodeURIComponent(device.deviceId)}` as D.Id<'printer'>;
  return {
    identity: { id: printerId, displayName: device.name, manufacturer: 'Bambu Lab', model: device.model, serialNumber: device.deviceId,
      externalRefs: [{ namespace: 'bambu', value: device.deviceId }] },
    routes: device.routes.map(route => ({ id: `${printerId}:${route.channel}` as D.Id<'route'>, printerId, providerId,
      label: route.channel === 'cloud' ? 'Bambu Cloud' : 'Bambu LAN', configurationRevision: route.revision,
      configuration: { typeId, hostId, channel: route.channel, address: route.channel === 'lan' ? route.address : null, webInterfaceUrl: null, credentialRef: null },
      management: { rename: false, configure: false, forget: false }, capabilities: capabilities(),
    })),
  };
}
/** A single provider implements independent account and printer capabilities. */
export function createBambuProvider(bridge: BambuBridge): AccountProvider & D.PrinterProvider {
  const listSaved: D.PrinterService['listSaved'] = async () => {
    try { const result = await bridge.read('printers.saved'); return result.ok ? { ok: true, value: result.value.map(saved) } : result; }
    catch { return { ok: false, error: { code: 'transport', message: 'The Bambu device catalogue is unavailable.' } }; }
  };
  const printers: D.PrinterService = {
    listProviders: async () => ({ ok: true, value: [{ id: providerId, name: 'Bambu Lab', hosts: [{ id: hostId, name: 'Desktop', execution: 'desktop', discovery: { kind: 'supported', constraints: { kinds: ['account'] } } }] }] }),
    listTypes: async () => ({ ok: true, value: [{ id: typeId, providerId, name: 'Bambu Lab', description: 'Plugin-backed account device discovery' }] }),
    listSaved, onSavedChanged: listener => bridge.onChanged(change => { if (change === 'printers') listener(); }),
    describe: async target => {
      const devices = await listSaved(); if (!devices.ok) return devices;
      const route = devices.value.find(device => device.identity.id === target.printerId)?.routes.find(route => route.id === target.routeId);
      return route ? { ok: true, value: { target, configurationRevision: route.configurationRevision, capabilities: route.capabilities, descriptor: { kind: 'unknown', reason: 'unavailable' } } }
        : { ok: false, error: { code: 'invalid-target', message: 'This Bambu route is no longer available.' } };
    },
    discover: async function* (id, scope) {
      if (id !== providerId || scope.hostId !== hostId || scope.kind !== 'account') { yield { type: 'failed', error: { code: 'unsupported', message: 'This discovery scope is unavailable.' } }; return; }
      try {
        const result = await bridge.command({ action: 'printers.refresh' });
        if (result.ok) yield { type: 'completed' };
        else yield { type: 'failed', error: { code: 'transport', message: result.error.message } };
      } catch { yield { type: 'failed', error: { code: 'transport', message: 'The cloud device list could not be refreshed.' } }; }
    },
    add: reject, updateRoute: reject, adopt: reject, authorize: reject, rename: reject, forget: reject,
    observations: { read: reject, watch: stream }, controls: { evaluate: reject, submit: submission },
    operations: { get: reject, find: reject, watch: stream, requestUploadCancellation: reject },
    files: { listStorages: reject, list: reject, stat: reject, listPreviews: reject, download: reject, upload: submission, watchChanges: stream },
    media: { open: reject, watch: stream, renew: reject, sendSignal: reject, readContent: reject, close: reject, captureSnapshot: reject },
    webInterfaces: { describe: reject, resolve: reject },
  };
  return { id: providerId, name: 'Bambu Lab', printers, account: {
    getState: () => bridge.read('account.state'), onStateChanged: listener => bridge.onChanged(change => { if (change === 'account') listener(); }),
    login: () => bridge.command({ action: 'login' }), logout: () => bridge.command({ action: 'logout' }),
    getSettings: () => bridge.read('account.settings'), setSetting: (key, value) => bridge.command({ action: 'setting', key, value }),
  } };
}
