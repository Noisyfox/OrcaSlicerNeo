import { expect, it, vi } from 'vitest';
import type { MdnsEvent, MdnsService } from '@orca/network-discovery';
import type * as D from '../domain';
import { createSnapmakerService } from './service';
import { normalizePrinterConfigurationDocument, type PrinterConfiguration } from '../configuration';

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> { const values: T[] = []; for await (const value of stream) values.push(value); return values; }
const id = <T extends string>(value: string) => value as D.Id<T>;
const host = { id: id<'agent-host'>('test'), name: 'Test host', execution: 'browser' as const };
const scope: D.DiscoveryScope = { kind: 'lan', hostId: host.id };
function announcement(values: Partial<MdnsService> = {}): MdnsService {
  return { id: 'u1._snapmaker._tcp.local.', serviceType: '_snapmaker._tcp.local.', name: 'U1', host: 'u1-SN.local.', port: 1884,
    addresses: ['192.168.1.20'], txt: { machine_type: 'Snapmaker U1', sn: 'SN', device_name: 'Workshop U1', link_mode: 'wan', ip: '10.0.0.99', userid: 'private-account', region: 'cn' },
    expiresAtMs: Date.now() + 120_000, ...values };
}
function fixture(printers: PrinterConfiguration[] = []) {
  let document = normalizePrinterConfigurationDocument({ version: 1, printers, printPreferences: { existing: { timelapse: false } } });
  const configuration = { load: vi.fn(async () => structuredClone(document)), save: vi.fn(async (next) => { document = normalizePrinterConfigurationDocument(next); }) };
  const request = vi.fn(async () => { throw new Error('Unexpected printer I/O'); });
  const events: MdnsEvent[] = [{ type: 'upsert', service: announcement() }];
  const mdns = { browse: vi.fn(async function* () { yield* events; }) };
  const create = (network = true) => createSnapmakerService({ configuration, host, transport: { request }, ...(network ? { mdns } : {}) });
  return { create, configuration, request, mdns, events, document: () => document };
}
async function candidates(service: D.PrinterService) {
  const events = await collect(service.discover(id('snapmaker'), scope));
  return events.filter((e): e is Extract<D.DiscoveryEvent, { type: 'upsert' }> => e.type === 'upsert').map(e => e.candidate);
}
const unwrap = <T>(result: D.Result<T>): T => { expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.error.message); return result.value; };

it('advertises LAN support only with the injected capability and keeps local catalogues network-free', async () => {
  const f = fixture(), service = f.create();
  expect(unwrap(await service.listProviders())[0].hosts[0].discovery).toEqual({ kind: 'supported', constraints: { kinds: ['lan'] } });
  await service.listTypes(); await service.listSaved(); expect(f.mdns.browse).not.toHaveBeenCalled();
  const web = f.create(false);
  expect(unwrap(await web.listProviders())[0].hosts[0].discovery.kind).toBe('unsupported');
  expect(unwrap(await web.listTypes())[0].manualConfiguration.kind).toBe('supported');
  expect((await collect(web.discover(id('snapmaker'), scope)))[0]).toMatchObject({ type: 'failed', error: { code: 'unsupported' } });
  expect((await collect(service.discover(id('snapmaker'), { kind: 'account', hostId: host.id })))[0].type).toBe('failed');
  expect(f.mdns.browse).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
});
it('maps U1 announcements in either link mode to HTTP 7125 using resolved addresses and drops invalid announcements', async () => {
  const f = fixture();
  const bad = [announcement({ txt: { machine_type: 'Other', sn: 'SN' } }), announcement({ txt: { machine_type: 'Snapmaker U1', sn: '' } }),
    announcement({ addresses: ['evil.example/path'] }), announcement({ expiresAtMs: 0 }), announcement({ serviceType: '_moonraker._tcp.local.' })];
  f.events.splice(0, 1, ...bad.map(service => ({ type: 'upsert' as const, service })), { type: 'upsert', service: announcement() });
  const values = await candidates(f.create()); expect(values).toHaveLength(1);
  expect(values[0]).toMatchObject({ id: 'snapmaker:SN', displayName: 'Workshop U1', access: 'none',
    configuration: { address: 'http://192.168.1.20:7125/', webInterfaceUrl: 'http://192.168.1.20/', hostId: host.id, typeId: 'snapmaker', credentialRef: null } });
  expect(JSON.stringify(values[0])).not.toContain('private-account');
  f.events.splice(0, f.events.length, { type: 'upsert', service: announcement({ addresses: ['2001:db8::123'], txt: { machine_type: 'Snapmaker U1', sn: 'SN', link_mode: 'lan' } }) });
  expect((await candidates(f.create()))[0].configuration).toMatchObject({ address: 'http://[2001:db8::123]:7125/', webInterfaceUrl: 'http://[2001:db8::123]/' });
  expect(f.request).not.toHaveBeenCalled();
});
it('deduplicates by serial across instances, handles identity changes and withdraws the last announcement', async () => {
  const f = fixture(), first = announcement(), second = announcement({ id: 'renamed', expiresAtMs: first.expiresAtMs + 1000 });
  f.events.splice(0, 1, { type: 'upsert', service: first }, { type: 'upsert', service: second }, { type: 'removed', id: first.id },
    { type: 'upsert', service: { ...second, txt: { ...second.txt, sn: 'newSN' } } }, { type: 'removed', id: second.id });
  const events = await collect(f.create().discover(id('snapmaker'), scope));
  expect(events.map(e => e.type === 'upsert' ? `up:${e.candidate.id}` : e.type === 'expired' ? `down:${e.candidateId}` : e.type))
    .toEqual(['up:snapmaker:SN', 'up:snapmaker:SN', 'down:snapmaker:SN', 'up:snapmaker:newSN', 'down:snapmaker:newSN', 'completed']);
});
it('adopts self-contained candidates locally, persists identity and rejects forged routing, expired or mismatched candidates', async () => {
  const f = fixture(), candidate = (await candidates(f.create()))[0];
  const service = f.create(); // No preceding discovery on this facade.
  const invalid = [
    { ...candidate, expiresAtMs: 0 }, { ...candidate, providerId: id<'provider'>('other') },
    { ...candidate, configuration: { ...candidate.configuration, hostId: id<'agent-host'>('other') } },
    { ...candidate, configuration: { ...candidate.configuration, address: 'http://192.168.1.20:1884/' } },
    { ...candidate, configuration: { ...candidate.configuration, address: 'http://user:secret@192.168.1.20:7125/' } },
    { ...candidate, configuration: { ...candidate.configuration, webInterfaceUrl: 'http://other-host/' as const } },
    { ...candidate, externalRefs: [{ namespace: 'snapmaker', value: 'different' }] },
  ];
  for (const value of invalid) expect((await service.adopt({ requestId: id('bad'), candidate: value })).ok).toBe(false);
  expect(f.configuration.save).not.toHaveBeenCalled();
  const request = { requestId: id<'request'>('adopt'), candidate };
  const saved = unwrap(await service.adopt(request));
  expect(saved.identity).toMatchObject({ id: 'snapmaker:SN', model: 'Snapmaker U1', serialNumber: 'SN', externalRefs: [{ namespace: 'snapmaker', value: 'SN' }] });
  expect(saved.configuredModel).toEqual({ vendorId: 'Snapmaker', model: 'Snapmaker U1' });
  expect(saved.routes[0].configuration.address).toBe('http://192.168.1.20:7125/');
  expect(saved.routes[0].configuration.webInterfaceUrl).toBe('http://192.168.1.20/');
  expect(unwrap(await service.adopt(request)).identity.id).toBe(saved.identity.id); expect(f.configuration.save).toHaveBeenCalledOnce();
  const restored = unwrap(await f.create(false).listSaved())[0];
  expect(restored.identity).toEqual(saved.identity);
  expect(restored.configuredModel).toEqual(saved.configuredModel);
  expect(unwrap(await f.create(false).configurations.read({ printerId: restored.identity.id, routeId: restored.routes[0].id })))
    .toMatchObject({ printerModel: saved.configuredModel, values: { consoleUrl: 'http://192.168.1.20/' } });
  expect(f.document().printPreferences).toEqual({ existing: { timelapse: false } });
  expect(f.request).not.toHaveBeenCalled();
});
it('fills discovery defaults when merging an existing endpoint without a model or console', async () => {
  const f = fixture([{ id: 'manual', displayName: 'My U1', driverId: 'snapmaker', apiBaseUrl: 'http://192.168.1.20:7125/', apiKey: 'key', consoleUrl: '' }]);
  const service = f.create(), candidate = (await candidates(service))[0];
  const saved = unwrap(await service.adopt({ requestId: id('merge'), candidate }));
  expect(saved.identity.id).toBe('manual');
  expect(saved.configuredModel).toEqual({ vendorId: 'Snapmaker', model: 'Snapmaker U1' });
  expect(f.document().printers[0]).toMatchObject({ apiKey: 'key', consoleUrl: 'http://192.168.1.20/' });
});
it('merges a manually configured endpoint without changing its ID, name, profile or credentials, and retains identity while editing', async () => {
  const f = fixture([{ id: 'manual', displayName: 'My printer', driverId: 'snapmaker', apiBaseUrl: 'http://192.168.1.20:7125/', apiKey: 'key', consoleUrl: 'http://console/',
    printerModel: { vendorId: 'Custom', model: 'User choice' } }]);
  const service = f.create(), candidate = (await candidates(service))[0];
  const saved = unwrap(await service.adopt({ requestId: id('adopt'), candidate }));
  expect(saved.identity).toMatchObject({ id: 'manual', displayName: 'My printer', serialNumber: 'SN' });
  expect(saved.configuredModel).toEqual({ vendorId: 'Custom', model: 'User choice' });
  expect(f.document().printers[0]).toMatchObject({ apiKey: 'key', consoleUrl: 'http://console/' });
  const route = saved.routes[0];
  const edit = { requestId: id<'request'>('edit'), target: { printerId: saved.identity.id, routeId: route.id }, typeId: id<'printer-type'>('snapmaker'), hostId: host.id,
    displayName: 'Renamed', values: { apiBaseUrl: 'http://192.168.1.20:7125/', apiKey: 'key', consoleUrl: '' }, printerModel: saved.configuredModel! };
  unwrap(await service.configurations.save(edit));
  expect(unwrap(await service.listSaved())[0].identity.serialNumber).toBe('SN');
  const candidate2 = { ...candidate, id: id<'candidate'>('snapmaker:other'), externalRefs: [{ namespace: 'snapmaker', value: 'other' }] };
  expect((await service.adopt({ requestId: id('wrong'), candidate: candidate2, existingPrinterId: saved.identity.id })).ok).toBe(false);
  expect(f.document().printers).toHaveLength(1); expect(f.request).not.toHaveBeenCalled();
});
