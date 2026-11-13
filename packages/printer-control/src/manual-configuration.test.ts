import { expect, it, vi } from 'vitest';
import { createMoonrakerService } from './service';
import { createSnapmakerService } from './snapmaker/service';
import { createPrinterService } from './providers';
import type { PrinterConfigurationDocument } from '@orca/platform-contract';
import type * as D from '@orca/platform-contract';

const id = <K extends string>(value: string) => value as D.Id<K>;

function fixture() {
  let document: PrinterConfigurationDocument = { version: 1, printers: [{ id: 'existing', driverId: 'moonraker',
    displayName: 'Original', apiBaseUrl: 'http://printer.local/', consoleUrl: '', apiKey: 'original-secret' }],
    printPreferences: { bambu: { timelapse: false } }, allowAbnormalStorage: true };
  const configuration = { load: async () => structuredClone(document),
    save: vi.fn(async (next: PrinterConfigurationDocument) => { document = structuredClone(next); }) };
  const request = vi.fn(async () => { throw new Error('Configuration must not access a printer'); });
  const options = { configuration, transport: { request }, host: { id: id<'agent-host'>('host'), name: 'Test', execution: 'browser' as const } };
  const service = createPrinterService([
    { id: id<'provider'>('moonraker'), name: 'Moonraker', printers: createMoonrakerService(options) },
    { id: id<'provider'>('snapmaker'), name: 'Snapmaker', printers: createSnapmakerService(options) },
  ]);
  const draft = (values: Partial<D.SavePrinterConfigurationRequest> = {}): D.SavePrinterConfigurationRequest => ({
    requestId: id<'request'>('add'), target: null, typeId: id<'printer-type'>('snapmaker'), hostId: options.host.id,
    displayName: ' New printer ', values: { apiBaseUrl: 'http://new-printer.local', consoleUrl: '', apiKey: 'new-secret' },
    printerModel: { vendorId: 'Snapmaker', model: 'Snapmaker U1' }, ...values,
  });
  async function printers() {
    const result = await service.listSaved();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Printer fixture failed');
    return result.value;
  }
  return { service, configuration, request, draft, printers };
}

it('reports configuration fields and persists a normalized, retry-safe addition locally', async () => {
  const f = fixture();
  const types = await f.service.listTypes();
  expect(types.ok && types.value.map(type => type.manualConfiguration)).toEqual(['moonraker', 'snapmaker'].map(() => ({
    kind: 'supported', constraints: { hostId: 'host', supportsModelSelection: true, fields: [
      { key: 'apiBaseUrl', label: 'API base URL', type: 'url', required: true, placeholder: 'http://printer.local:7125/', defaultValue: '' },
      { key: 'consoleUrl', label: 'Console URL', type: 'url', required: false, placeholder: 'Uses API base URL when blank', defaultValue: '' },
      { key: 'apiKey', label: 'API key', type: 'password', required: false, placeholder: '', defaultValue: '' },
    ] },
  })));
  const draft = f.draft();
  expect(await f.service.configurations.save(draft)).toEqual({ ok: true, value: null });
  expect(await f.service.configurations.save(draft)).toEqual({ ok: true, value: null });
  expect(f.configuration.save).toHaveBeenCalledOnce();
  const document = await f.configuration.load();
  expect(document.printers).toHaveLength(2);
  expect(document.printers[1]).toMatchObject({ displayName: 'New printer', driverId: 'snapmaker', apiBaseUrl: 'http://new-printer.local/',
    apiKey: 'new-secret', printerModel: draft.printerModel });
  expect(document).toMatchObject({ printPreferences: { bambu: { timelapse: false } }, allowAbnormalStorage: true });
  expect(document).not.toHaveProperty('selectedPrinterId');
  expect((await f.service.configurations.save({ ...draft, displayName: 'Different' })).ok).toBe(false);
  expect(f.request).not.toHaveBeenCalled();
});

it('reads existing settings, changes adapter atomically, and retains the physical ID and preferences', async () => {
  const f = fixture();
  const printer = (await f.printers())[0], route = printer.routes[0];
  const target = { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision };
  expect(await f.service.configurations.read(target)).toEqual({ ok: true, value: { typeId: 'moonraker', displayName: 'Original',
    values: { apiBaseUrl: 'http://printer.local/', consoleUrl: '', apiKey: 'original-secret' }, printerModel: null } });
  const changed = f.draft({ requestId: id<'request'>('edit'), target, displayName: 'Changed' });
  expect((await f.service.configurations.save(changed)).ok).toBe(true);
  expect((await f.service.configurations.save(changed)).ok).toBe(true);
  const next = (await f.printers())[0], nextRoute = next.routes[0];
  expect(next.identity.id).toBe(printer.identity.id);
  expect(nextRoute.providerId).toBe('snapmaker');
  expect(next.configuredModel).toEqual(changed.printerModel);
  expect((await f.service.configurations.read(target)).ok).toBe(false);
  const clearing = { printerId: next.identity.id, routeId: nextRoute.id, expectedConfigurationRevision: nextRoute.configurationRevision };
  expect((await f.service.configurations.save(f.draft({ requestId: id<'request'>('clear'), target: clearing, printerModel: null }))).ok).toBe(true);
  expect((await f.configuration.load()).printers[0]).not.toHaveProperty('printerModel');
  expect((await f.configuration.load()).printPreferences).toEqual({ bambu: { timelapse: false } });
  expect(f.request).not.toHaveBeenCalled();
});

it('serializes independent additions and rejects unknown fields, hosts, types and stale edits', async () => {
  const f = fixture();
  const original = await f.configuration.load();
  for (const change of [
    { values: { apiBaseUrl: 'http://printer.local/', unrecognized: 'secret-value' } },
    { hostId: id<'agent-host'>('wrong-host') },
    { typeId: id<'printer-type'>('unknown') },
  ]) {
    const result = await f.service.configurations.save(f.draft(change));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-value');
  }
  const printer = (await f.printers())[0];
  expect((await f.service.configurations.save(f.draft({ target: { printerId: printer.identity.id, routeId: printer.routes[0].id,
    expectedConfigurationRevision: 'stale' } }))).ok).toBe(false);
  expect(await f.configuration.load()).toEqual(original);
  expect((await Promise.all(['first', 'second'].map(name => f.service.configurations.save(f.draft({
    requestId: id<'request'>(name), displayName: name,
  }))))).every(result => result.ok)).toBe(true);
  expect((await f.configuration.load()).printers.map(value => value.displayName)).toEqual(['Original', 'first', 'second']);
  expect(f.request).not.toHaveBeenCalled();
});
