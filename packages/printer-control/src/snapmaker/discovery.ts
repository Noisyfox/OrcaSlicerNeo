/** U1 DNS-SD interpretation; the injected host owns all multicast networking. */
import type { MdnsDiscovery, MdnsService } from '@orca/network-discovery';
import type * as D from '../domain';
import type { HttpServiceBehavior } from '../http-service';
import { fail } from '../moonraker-http';

const serviceType = '_snapmaker._tcp.local.';
const providerId = 'snapmaker' as D.Id<'provider'>;
const candidateId = (serial: string) => `snapmaker:${encodeURIComponent(serial)}` as D.Id<'candidate'>;
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
function endpoint(addresses: readonly string[]): string | undefined {
  // Prefer resolved IPv4. Firmware's TXT ip is a redundant, potentially stale single address.
  for (const address of [...addresses].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')) || a.localeCompare(b))) {
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(address) && address.split('.').every(n => Number(n) <= 255);
    if (!ipv4 && !address.includes(':')) continue;
    try { return new URL(`http://${ipv4 ? address : `[${address}]`}:7125/`).href; } catch { /* Try another resolved address. */ }
  }
}

export function u1Discovery(mdns: MdnsDiscovery, host: D.AgentHost, capabilities: () => D.PrinterCapabilities): NonNullable<HttpServiceBehavior['discovery']> {
  function candidate(service: MdnsService): D.DiscoveryCandidate | undefined {
    const sn = service.txt.sn;
    if (service.serviceType !== serviceType || service.txt.machine_type !== 'Snapmaker U1' || !text(sn)
      || !Number.isFinite(service.expiresAtMs) || service.expiresAtMs <= Date.now()) return;
    const address = endpoint(service.addresses);
    if (!address) return;
    return { id: candidateId(sn.trim()), providerId, displayName: text(service.txt.device_name) ? service.txt.device_name.trim() : 'Snapmaker U1',
      configuration: { typeId: 'snapmaker' as D.Id<'printer-type'>, hostId: host.id, channel: 'lan', address, credentialRef: null, webInterfaceUrl: null },
      capabilities: capabilities(), externalRefs: [{ namespace: 'snapmaker', value: sn.trim() }], expiresAtMs: service.expiresAtMs, access: 'none' };
  }
  return {
    async *browse(options) {
      const instances = new Map<string, D.DiscoveryCandidate>();
      const published = new Map<string, string>();
      try {
        for await (const event of mdns.browse(serviceType, options)) {
          if (options?.signal?.aborted) return;
          const id = event.type === 'upsert' ? event.service.id : event.id;
          const old = instances.get(id), next = event.type === 'upsert' ? candidate(event.service) : undefined;
          if (next) instances.set(id, next); else instances.delete(id);
          for (const key of new Set([old?.id, next?.id])) {
            if (!key) continue;
            const current = [...instances.values()].filter(value => value.id === key && value.expiresAtMs > Date.now())
              .sort((a, b) => b.expiresAtMs - a.expiresAtMs)[0];
            if (!current) {
              if (published.delete(key)) yield { type: 'expired', candidateId: key };
            } else if (published.get(key) !== JSON.stringify(current)) {
              published.set(key, JSON.stringify(current)); yield { type: 'upsert', candidate: current };
            }
          }
        }
        if (!options?.signal?.aborted) yield { type: 'completed' };
      } catch {
        if (!options?.signal?.aborted) yield { type: 'failed', error: { code: 'transport', message: 'LAN discovery is unavailable. Check local network permissions and try again.' } };
      }
    },
    validate(value) {
      const config = value.configuration, reference = value.externalRefs?.[0];
      if (value.providerId !== providerId || value.access !== 'none' || config.typeId !== 'snapmaker' || config.hostId !== host.id
        || config.channel !== 'lan' || config.credentialRef !== null || config.webInterfaceUrl !== null
        || value.externalRefs.length !== 1 || reference?.namespace !== 'snapmaker' || !text(reference.value)
        || value.id !== candidateId(reference.value) || !text(value.displayName)) fail('invalid-request', 'Invalid U1 discovery candidate');
      if (!Number.isFinite(value.expiresAtMs) || value.expiresAtMs <= Date.now()) fail('stale-context', 'This discovery candidate has expired');
      let url: URL;
      try { url = new URL(config.address ?? ''); } catch { fail('invalid-request', 'Invalid U1 discovery address'); }
      const canonical = endpoint([url!.hostname.replace(/^\[|\]$/g, '')]);
      if (!canonical || config.address !== canonical) fail('invalid-request', 'Invalid U1 discovery address');
      return { id: candidateId(reference!.value), driverId: 'snapmaker', displayName: value.displayName.trim(), apiBaseUrl: canonical!, apiKey: '', consoleUrl: '',
        discoveredIdentity: { manufacturer: 'Snapmaker', model: 'Snapmaker U1', serialNumber: reference!.value } };
    },
  };
}
