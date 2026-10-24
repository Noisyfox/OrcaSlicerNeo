import { bambuMedia } from './bambuMedia';
import { bambuControls, bambuOperations } from './bambuControls';
import { bambuObservations } from './bambuObservations';
import { bambuCapabilities, savedBambuPrinter } from '../../../shared/bambuPrinters';
import type { AccountProvider } from '@orca/service-provider';
import type * as D from '@orca/printer-control/domain';
import type { BambuBridge } from '../../../shared/bambu';
import type { BambuLanCandidate } from '../../../shared/bambuDevices';

const providerId = 'bambu' as D.Id<'provider'>;
const hostId = 'desktop' as D.Id<'agent-host'>;
const typeId = 'bambu-network' as D.Id<'printer-type'>;
const unsupported = { kind: 'unsupported', layer: 'adapter', reason: 'This operation is not included in Bambu control.' } as const;
const reject = async (): Promise<D.Result<never>> => ({ ok: false, error: { code: 'unsupported', message: unsupported.reason } });
const stream = async function* (): AsyncIterable<never> { throw new Error(unsupported.reason); };
const submission = async (): Promise<D.Submission> => ({ kind: 'rejected', error: { code: 'unsupported', message: unsupported.reason } });
function candidate(value: BambuLanCandidate): D.DiscoveryCandidate {
  return { id: value.candidateId as D.Id<'candidate'>, providerId,
    configuration: { typeId, hostId, channel: 'lan', address: value.address, webInterfaceUrl: null, credentialRef: null },
    capabilities: bambuCapabilities(), displayName: value.name, externalRefs: [{ namespace: 'bambu', value: value.deviceId }],
    expiresAtMs: value.expiresAtMs, access: 'access-code',
  };
}
/** A single provider implements independent account and printer capabilities. */
export function createBambuProvider(bridge: BambuBridge): AccountProvider & D.PrinterProvider {
  const listSaved: D.PrinterService['listSaved'] = async () => {
    try { const result = await bridge.read('printers.saved'); return result.ok ? { ok: true, value: result.value.map(savedBambuPrinter) } : result; }
    catch { return { ok: false, error: { code: 'transport', message: 'The Bambu device catalogue is unavailable.' } }; }
  };
  const printers: D.PrinterService = {
    listProviders: async () => ({ ok: true, value: [{ id: providerId, name: 'Bambu Lab', hosts: [{ id: hostId, name: 'Desktop', execution: 'desktop', discovery: { kind: 'supported', constraints: { kinds: ['account', 'lan'] } } }] }] }),
    listTypes: async () => ({ ok: true, value: [{ id: typeId, providerId, name: 'Bambu Lab', description: 'Bambu printer monitoring and control' }] }),
    listSaved, onSavedChanged: listener => bridge.onChanged(change => { if (change === 'printers') listener(); }),
    describe: async target => {
      try { return await bridge.control('describe', target); }
      catch { return { ok: false, error: { code: 'transport', message: 'The printer description is unavailable.' } }; }
    },
    discover: async function* (id, scope, options) {
      if (id !== providerId || scope.hostId !== hostId) { yield { type: 'failed', error: { code: 'unsupported', message: 'This discovery scope is unavailable.' } }; return; }
      if (scope.kind === 'account') {
        try {
          const result = await bridge.command({ action: 'printers.refresh' });
          if (result.ok) yield { type: 'completed' };
          else yield { type: 'failed', error: { code: 'transport', message: result.error.message } };
        } catch { yield { type: 'failed', error: { code: 'transport', message: 'The cloud device list could not be refreshed.' } }; }
        return;
      }
      let version = 0; let wake: (() => void) | null = null;
      const stop = bridge.onChanged(change => { if (change === 'printers') { ++version; wake?.(); } });
      const abort = () => wake?.(); options?.signal?.addEventListener('abort', abort);
      let previous = new Set<string>();
      try {
        while (!options?.signal?.aborted) {
          const current = version; const result = await bridge.read('printers.candidates');
          if (options?.signal?.aborted) return;
          if (version !== current) continue;
          if (!result.ok) { yield { type: 'failed', error: result.error }; return; }
          const next = new Set(result.value.map(value => value.candidateId));
          for (const id of previous) if (!next.has(id)) yield { type: 'expired', candidateId: id as D.Id<'candidate'> };
          for (const value of result.value) yield { type: 'upsert', candidate: candidate(value) };
          previous = next;
          if (version === current && !options?.signal?.aborted) await new Promise<void>(resolve => { wake = resolve; if (version !== current || options?.signal?.aborted) resolve(); });
          wake = null;
        }
      } catch { yield { type: 'failed', error: { code: 'transport', message: 'LAN discovery is unavailable.' } }; }
      finally { stop(); options?.signal?.removeEventListener('abort', abort); }
    },
    add: reject, updateRoute: reject, adopt: reject, rename: reject,
    authorize: async request => {
      if (request.candidate.providerId !== providerId) return { ok: false, error: { code: 'invalid-target', message: 'This candidate belongs to another provider.' } };
      try {
        const available = await bridge.read('printers.candidates'); if (!available.ok) return available;
        const current = available.value.find(value => value.candidateId === request.candidate.id);
        if (!current || current.expiresAtMs <= Date.now()) return { ok: false, error: { code: 'stale-context', message: 'This discovery candidate has expired.' } };
        const printerId = `bambu:${encodeURIComponent(current.deviceId)}` as D.Id<'printer'>;
        if (request.existingPrinterId && request.existingPrinterId !== printerId) return { ok: false, error: { code: 'invalid-target', message: 'The candidate is a different physical printer.' } };
        const result = await bridge.printerCommand({ action: 'authorize', candidateId: current.candidateId, accessCode: request.accessCode });
        if (!result.ok) return result;
        const devices = await listSaved(); if (!devices.ok) return devices;
        const printer = devices.value.find(printer => printer.identity.id === printerId);
        return printer ? { ok: true, value: printer } : { ok: false, error: { code: 'transport', message: 'The authorized printer is unavailable.' } };
      } catch { return { ok: false, error: { code: 'transport', message: 'LAN access could not be established.' } }; }
    },
    forget: async target => {
      try {
        const devices = await bridge.read('printers.saved'); if (!devices.ok) return devices;
        const device = devices.value.find(device => `bambu:${encodeURIComponent(device.deviceId)}` === target.printerId);
        const printer = device && savedBambuPrinter(device);
        const route = printer?.routes.find(route => route.id === target.routeId);
        const lan = device?.routes.find(route => route.channel === 'lan');
        if (!route || !lan) return reject();
        if (target.expectedConfigurationRevision !== undefined && target.expectedConfigurationRevision !== route.configurationRevision) return { ok: false, error: { code: 'stale-context', message: 'Printer configuration changed.' } };
        return await bridge.printerCommand({ action: 'forget', deviceId: device!.deviceId, expectedRevision: lan.revision });
      }
      catch { return { ok: false, error: { code: 'transport', message: 'The LAN connection could not be forgotten.' } }; }
    },
    observations: bambuObservations(bridge), controls: bambuControls(bridge),
    operations: bambuOperations(bridge),
    files: { listStorages: reject, list: reject, stat: reject, listPreviews: reject, download: reject, upload: submission, watchChanges: stream },
    media: bambuMedia(bridge),
    webInterfaces: { describe: reject, resolve: reject },
  };
  return { id: providerId, name: 'Bambu Lab', printers, account: {
    getState: () => bridge.read('account.state'), onStateChanged: listener => bridge.onChanged(change => { if (change === 'account') listener(); }),
    login: () => bridge.command({ action: 'login' }), logout: () => bridge.command({ action: 'logout' }),
    getSettings: () => bridge.read('account.settings'), setSetting: (key, value) => bridge.command({ action: 'setting', key, value }),
  } };
}
