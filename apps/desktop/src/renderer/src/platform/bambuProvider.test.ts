import { expect, it, vi } from 'vitest';
import { createBambuProvider } from './bambuProvider';
import type { BambuBridge, BambuChange, BambuRead } from '../../../shared/bambu';
import type { BambuDevice } from '../../../shared/bambuDevices';
function fixture() {
  let devices: readonly BambuDevice[] = [{ deviceId: 'serial-a', name: 'Same name', model: 'X1C', routes: [{ channel: 'cloud', revision: 'r1' }] }];
  const listeners = new Set<(change: BambuChange) => void>();
  const command = vi.fn(async () => ({ ok: true as const, value: undefined }));
  const read = vi.fn(async (kind: BambuRead) => kind === 'printers.saved' ? { ok: true, value: devices } : kind === 'account.state' ? { status: 'signed-out', error: null } : []);
  const bridge = { read, command, onChanged: (listener: (change: BambuChange) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } as unknown as BambuBridge;
  return { provider: createBambuProvider(bridge), second: createBambuProvider(bridge), read, command, listeners,
    update: (next: readonly BambuDevice[]) => { devices = next; listeners.forEach(listener => listener('printers')); } };
}
it('projects stable provider/printer/route identities and exposes discovery-only capabilities', async () => {
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
