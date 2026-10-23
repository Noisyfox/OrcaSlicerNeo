import { describe, expect, it, vi } from 'vitest';
import { createPrinterService } from './providers';
import { createMoonrakerService } from './service';
import type { Id, PrinterProvider, SavedPrinter, TargetRequest } from './domain';

async function fixture(id = 'moonraker', printerId = 'moon') {
  const request = vi.fn(async () => { throw new Error('Listing must not probe devices'); });
  const service = createMoonrakerService({
    configuration: {
      load: async () => ({ version: 1, printers: [{ id: printerId, displayName: 'Shared name', driverId: 'moonraker', apiBaseUrl: 'http://printer.local/', consoleUrl: '', apiKey: '' }] }),
      save: async () => {},
    },
    host: { id: 'test' as Id<'agent-host'>, name: 'Test', execution: 'desktop' }, transport: { request },
  });
  const result = await service.listSaved();
  if (!result.ok) throw new Error('Fixture failed');
  let printers = structuredClone(result.value) as SavedPrinter[];
  for (const printer of printers) for (const route of printer.routes) route.providerId = id as Id<'provider'>;
  const listeners = new Set<() => void>();
  const provider: PrinterProvider = { id: id as Id<'provider'>, name: id, printers: {
    ...service,
    listSaved: vi.fn(async () => ({ ok: true as const, value: structuredClone(printers) })),
    onSavedChanged: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    describe: vi.fn(service.describe),
    forget: vi.fn(async (target: TargetRequest) => {
      printers = printers.flatMap(printer => {
        const routes = printer.routes.filter(route => route.id !== target.routeId);
        return routes.length ? [{ ...printer, routes }] : [];
      });
      for (const listener of listeners) listener();
      return { ok: true as const, value: null };
    }),
  } };
  return { provider, request, listeners, set: (next: SavedPrinter[]) => { printers = next; for (const listener of listeners) listener(); }, get: () => printers };
}

describe('provider composition', () => {
  it('keeps identical names/addresses distinct and dispatches by route owner without probing', async () => {
    const moon = await fixture();
    const bambu = await fixture('bambu', 'bambu-device');
    const service = createPrinterService([moon.provider, bambu.provider]);
    const result = await service.listSaved();
    expect(result.ok && result.value.map(p => p.identity.id)).toEqual(['moon', 'bambu-device']);
    const device = bambu.get()[0];
    const target = { printerId: device.identity.id, routeId: device.routes[0].id };
    await service.describe(target);
    expect(bambu.provider.printers.describe).toHaveBeenCalledWith(target, undefined);
    expect(moon.provider.printers.describe).not.toHaveBeenCalled();
    expect(moon.request).not.toHaveBeenCalled();
    expect(bambu.request).not.toHaveBeenCalled();
    expect(await service.describe({ ...target, routeId: 'unknown' as Id<'route'> })).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
  });

  it('retains Cloud after LAN forgetting and broadcasts catalogue invalidations to every consumer', async () => {
    const bambu = await fixture('bambu', 'device');
    const device = bambu.get()[0];
    const lan = device.routes[0];
    const cloud = { ...lan, id: 'cloud' as Id<'route'>, management: { rename: false, configure: false, forget: false }, configuration: { ...lan.configuration, channel: 'cloud' as const } };
    bambu.set([{ ...device, routes: [lan, cloud] }]);
    const service = createPrinterService([bambu.provider]);
    const first = vi.fn(); const second = vi.fn();
    const stopFirst = service.onSavedChanged(first); const stopSecond = service.onSavedChanged(second);
    const target: TargetRequest = { printerId: device.identity.id, routeId: lan.id, expectedConfigurationRevision: lan.configurationRevision };
    expect(await service.forget(target)).toEqual({ ok: true, value: null });
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce();
    const saved = await service.listSaved();
    expect(saved.ok && saved.value[0].routes.map(route => route.id)).toEqual(['cloud']);
    expect(bambu.provider.printers.forget).toHaveBeenCalledWith(target);
    stopFirst(); stopSecond(); expect(bambu.listeners.size).toBe(0);
  });

  it('rejects identity collisions and invalid ownership instead of merging unrelated providers', async () => {
    const moon = await fixture(); const bambu = await fixture('bambu', 'moon');
    expect((await createPrinterService([moon.provider, bambu.provider]).listSaved()).ok).toBe(false);
    const bad = structuredClone(bambu.get()[0]); bad.routes[0].providerId = 'other' as Id<'provider'>;
    bambu.set([bad]);
    expect((await createPrinterService([bambu.provider]).listSaved()).ok).toBe(false);
    expect(() => createPrinterService([moon.provider, moon.provider])).toThrow('Duplicate');
  });

  it('continues routing outstanding operations after removal and preserves provider errors', async () => {
    const bambu = await fixture('bambu', 'device');
    const device = bambu.get()[0]; const route = device.routes[0];
    const service = createPrinterService([bambu.provider]);
    await service.listSaved(); bambu.set([]); await service.listSaved();
    const failure = { ok: false as const, error: { code: 'invalid-target' as const, message: 'Operation expired' } };
    const get = vi.spyOn(bambu.provider.printers.operations, 'get').mockResolvedValue(failure);
    const operation = { printerId: device.identity.id, routeId: route.id, id: 'op' as Id<'operation'> };
    expect(await service.operations.get(operation)).toEqual(failure);
    expect(get).toHaveBeenCalledWith(operation, undefined);
    vi.mocked(bambu.provider.printers.listSaved).mockResolvedValueOnce({ ok: false, error: { code: 'transport', message: 'Unavailable' } });
    expect(await service.listSaved()).toMatchObject({ ok: false, error: { code: 'transport' } });
  });
});
