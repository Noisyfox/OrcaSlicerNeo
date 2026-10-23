import { savedBambuPrinter } from '../../../shared/bambuPrinters';
import { expect, it, vi } from 'vitest';
import { createBambuProvider } from './bambuProvider';
import type { BambuBridge, BambuChange, BambuPrinterCommand, BambuRead } from '../../../shared/bambu';
import type { BambuDevice, BambuLanCandidate } from '../../../shared/bambuDevices';
function fixture() {
  let devices: readonly BambuDevice[] = [{ deviceId: 'serial-a', name: 'Same name', model: 'X1C', routes: [{ channel: 'cloud', revision: 'r1' }] }];
  let candidates: readonly BambuLanCandidate[] = [];
  const listeners = new Set<(change: BambuChange) => void>();
  const command = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const printerCommand = vi.fn(async (_request: BambuPrinterCommand) => ({ ok: true as const, value: null }));
  const read = vi.fn(async (kind: BambuRead): Promise<unknown> => kind === 'printers.candidates' ? { ok: true, value: candidates } : kind === 'printers.saved' ? { ok: true, value: devices } : kind === 'account.state' ? { status: 'signed-out', error: null } : []);
  const bridge = { read, command, printerCommand, control: async (method: string, target: { printerId: string; routeId: string }) => {
    const printer = devices.map(savedBambuPrinter).find(printer => printer.identity.id === target.printerId);
    const route = printer?.routes.find(route => route.id === target.routeId);
    return method === 'describe' && route ? { ok: true, value: { target, configurationRevision: route.configurationRevision, capabilities: route.capabilities, descriptor: { kind: 'unknown', reason: 'unavailable' } } } : { ok: false, error: { code: 'invalid-target', message: 'Unavailable' } };
  }, onChanged: (listener: (change: BambuChange) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as BambuBridge;
  return { provider: createBambuProvider(bridge), second: createBambuProvider(bridge), read, command, printerCommand, listeners, candidates: (next: readonly BambuLanCandidate[]) => { candidates = next; },
    update: (next: readonly BambuDevice[]) => { devices = next; listeners.forEach(listener => listener('printers')); } };
}
it('projects stable provider/printer/route identities and exposes monitoring capabilities with controls still unsupported', async () => {
  const f = fixture(); const result = await f.provider.printers.listSaved(); if (!result.ok) throw new Error('Missing catalogue');
  const printer = result.value[0]; expect(printer.identity.id).toBe('bambu:serial-a'); expect(printer.routes[0].providerId).toBe(f.provider.id);
  expect(printer.routes[0].configuration).toMatchObject({ channel: 'cloud', address: null, credentialRef: null, webInterfaceUrl: null });
  expect(printer.routes[0].management).toEqual({ rename: false, configure: false, forget: false });
  expect(Object.values(printer.routes[0].capabilities.commands).every(capability => capability.kind === 'unsupported')).toBe(true);
  expect(printer.routes[0].capabilities.files.upload.kind).toBe('unsupported');
  const target = { printerId: printer.identity.id, routeId: printer.routes[0].id };
  expect(await f.provider.printers.describe(target)).toMatchObject({ ok: true, value: { descriptor: { kind: 'unknown' } } });
  expect(await f.provider.printers.forget(target)).toMatchObject({ ok: false, error: { code: 'unsupported' } }); expect(f.command).not.toHaveBeenCalled();
  f.update([]); expect(await f.provider.printers.describe(target)).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
});
it('invalidates multiple consumers and keeps account capability notifications separate', async () => {
  const f = fixture(); const first = vi.fn(); const second = vi.fn(); const account = vi.fn();
  const stop = f.provider.printers.onSavedChanged(first); const stopSecond = f.second.printers.onSavedChanged(second); const stopAccount = f.provider.account.onStateChanged(account);
  f.update([{ deviceId: 'serial-a', name: 'Renamed', model: 'X1C', routes: [{ channel: 'cloud', revision: 'r2' }] }, { deviceId: 'serial-b', name: 'Renamed', model: 'P1S', routes: [{ channel: 'cloud', revision: 'r2' }] }]);
  expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce(); expect(account).not.toHaveBeenCalled();
  expect(await f.provider.printers.listSaved()).toEqual(await f.second.printers.listSaved());
  f.listeners.forEach(listener => listener('account')); expect(account).toHaveBeenCalledOnce(); expect(first).toHaveBeenCalledOnce();
  stop(); stopSecond(); stopAccount(); expect(f.listeners.size).toBe(0);
});
it('lists locally and refreshes only through an explicit account discovery call', async () => {
  const f = fixture(); await f.provider.printers.listSaved(); await f.provider.printers.listProviders(); expect(f.command).not.toHaveBeenCalled();
  const events = []; for await (const event of f.provider.printers.discover(f.provider.id, { kind: 'account', hostId: 'desktop' as never })) events.push(event);
  expect(events).toEqual([{ type: 'completed' }]); expect(f.command).toHaveBeenCalledWith({ action: 'printers.refresh' });
});

it('discovers LAN candidates, authorizes only the same physical identity, and forgets LAN while retaining Cloud', async () => {
  const f = fixture(); const controller = new AbortController();
  f.candidates([{ candidateId: 'candidate', deviceId: 'serial-a', name: 'LAN name', model: 'X1C', address: '192.0.2.1', expiresAtMs: Date.now() + 60_000 }]);
  const discovery = f.provider.printers.discover(f.provider.id, { kind: 'lan', hostId: 'desktop' as never }, { signal: controller.signal })[Symbol.asyncIterator]();
  const first = await discovery.next(); if (first.done || first.value.type !== 'upsert') throw new Error('No candidate');
  const request = { requestId: 'request' as never, candidate: first.value.candidate, accessCode: 'ABCDEFGH' };
  expect(await f.provider.printers.authorize({ ...request, existingPrinterId: 'wrong-printer' as never })).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
  expect(f.printerCommand).not.toHaveBeenCalled();
  f.printerCommand.mockImplementation(async command => {
    f.update([{ deviceId: 'serial-a', name: 'Same name', model: 'X1C', routes: command.action === 'authorize'
      ? [{ channel: 'cloud', revision: 'r1' }, { channel: 'lan', revision: 'lan-r1', address: '192.0.2.1' }] : [{ channel: 'cloud', revision: 'r1' }] }]);
    return { ok: true, value: null };
  });
  const authorized = await f.provider.printers.authorize(request); if (!authorized.ok) throw new Error('Not authorized');
  const route = authorized.value.routes.find(route => route.configuration.channel === 'lan')!;
  expect(route.management.forget).toBe(true); expect(route.configuration.credentialRef).not.toBeNull(); expect(JSON.stringify(authorized)).not.toContain('ABCDEFGH');
  expect(await f.provider.printers.forget({ printerId: route.printerId, routeId: route.id, expectedConfigurationRevision: route.configurationRevision })).toMatchObject({ ok: true });
  expect(f.printerCommand).toHaveBeenLastCalledWith({ action: 'forget', deviceId: 'serial-a', expectedRevision: 'lan-r1' });
  expect(await f.provider.printers.listSaved()).toMatchObject({ ok: true, value: [{ routes: [{ configuration: { channel: 'cloud' } }] }] });
  controller.abort(); await discovery.return?.(); expect(f.listeners.size).toBe(0);
});
