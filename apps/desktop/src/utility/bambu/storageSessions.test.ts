import { describe, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import type { BambuLocalState } from './repository';
import type { BambuDevice } from '../../shared/bambuDevices';
import type { BambuHostConfig } from '../../shared/bambu';
import { savedBambuPrinter } from '../../shared/bambuPrinters';
import { BambuStorageSessions, storageNative } from './storageSessions';

const config: BambuHostConfig = { addonPath: '/runtime/bambu.node', pluginPath: '/runtime/plugin/lib.dylib',
  directory: '/user/bambu', certificateDirectory: '/runtime/cert', osType: 'macos', osVersion: 'test' };
const unwrap = <T>(value: D.Result<T>): T => { if (!value.ok) throw new Error(value.error.message); return value.value; };
function fixture() {
  const state: BambuLocalState = { version: 1, region: 'Others', clientId: 'client', lan: ['a', 'b'].map(deviceId => ({
    deviceId, name: deviceId, model: 'H2D', ip: '192.0.2.1', accessCode: 'private-secret', revision: 'lan-1',
  })) };
  const devices: BambuDevice[] = ['a', 'b'].map(deviceId => ({ deviceId, name: deviceId, model: 'H2D', routes: [
    { channel: 'cloud', revision: 'cloud-1' }, { channel: 'lan', revision: 'lan-1', address: '192.0.2.1' },
  ] }));
  const native = { installDeviceCertificate: vi.fn(async () => undefined) };
  const returned = vi.fn(async () => ({ done: true as const, value: undefined }));
  const io: typeof storageNative = { discover: vi.fn(async () => ['sdcard']), list: vi.fn(async () => []), resource: vi.fn(async () => null), remove: vi.fn(async () => undefined),
    download: vi.fn(async () => ({ totalBytes: 3, chunks: { [Symbol.asyncIterator]: () => ({
      next: vi.fn(async () => ({ done: false as const, value: new Uint8Array([1, 2, 3]) })), return: returned,
    }) } })),
  };
  const sessions = new BambuStorageSessions(config, native, { list: async () => structuredClone(devices) }, { read: async () => structuredClone(state) }, io);
  const target = (index = 0): D.PrinterTarget => {
    const saved = savedBambuPrinter(devices[index]); return { printerId: saved.identity.id, routeId: saved.routes[0].id };
  };
  return { sessions, native, io, returned, devices, state, target };
}

describe('Bambu storage session ownership', () => {
  it('does not probe while resolving and reuses only same-device authorized LAN credentials', async () => {
    const f = fixture(), source = unwrap(await f.sessions.resolve(f.target()));
    expect(f.native.installDeviceCertificate).not.toHaveBeenCalled(); expect(f.io.discover).not.toHaveBeenCalled();
    expect(await source.discover()).toEqual(['sdcard']);
    expect(f.native.installDeviceCertificate).toHaveBeenCalledWith('a', true);
    const call = vi.mocked(f.io.discover).mock.calls[0];
    expect(call[2]).toContain('passwd=private-secret'); expect(call[2]).toContain('device=a');
    expect(source).not.toHaveProperty('privateUrl');
    f.state.lan = f.state.lan.filter(record => record.deviceId !== 'a');
    expect(await f.sessions.resolve(f.target())).toMatchObject({ ok: false, error: { code: 'authentication-required' } });
    await expect(source.discover()).rejects.toMatchObject({ detail: { code: 'authentication-required' } });
    expect(f.io.discover).toHaveBeenCalledTimes(1); await f.sessions.close();
  });

  it('does not share the currently selected monitor lease across different printers', async () => {
    const f = fixture();
    const first = unwrap(await f.sessions.resolve(f.target(0))), second = unwrap(await f.sessions.resolve(f.target(1)));
    const a = await first.download({ path: '/a.3mf' }), b = await second.download({ path: '/b.3mf' });
    expect(vi.mocked(f.io.download).mock.calls.map(call => new URL(call[2]).searchParams.get('device'))).toEqual(['a', 'b']);
    await a.chunks[Symbol.asyncIterator]().return?.(); await b.chunks[Symbol.asyncIterator]().return?.();
    expect(f.returned).toHaveBeenCalledTimes(2); await f.sessions.close();
  });

  it('revalidates configuration before I/O and cancels active streams when authorization changes', async () => {
    const f = fixture(), source = unwrap(await f.sessions.resolve(f.target()));
    const value = await source.download({ path: '/a.3mf' });
    const iterator = value.chunks[Symbol.asyncIterator](); await iterator.next();
    f.devices[0].routes = [{ channel: 'cloud', revision: 'cloud-2' }];
    await f.sessions.reconcile();
    await expect(iterator.next()).rejects.toMatchObject({ detail: { code: 'cancelled' } });
    expect(f.returned).toHaveBeenCalledTimes(1);
    await expect(source.discover()).rejects.toMatchObject({ detail: { code: 'authentication-required' } });
    expect(f.io.discover).not.toHaveBeenCalled(); await f.sessions.close();
  });

  it('cancels unread streams and waits for native resource return before shutdown finishes', async () => {
    const f = fixture(); let finish!: () => void;
    vi.mocked(f.returned).mockImplementation(async () => { await new Promise<void>(resolve => { finish = resolve; }); return { done: true, value: undefined }; });
    const source = unwrap(await f.sessions.resolve(f.target()));
    await source.download({ path: '/a.3mf' });
    let stopped = false; const stopping = f.sessions.close().then(() => { stopped = true; });
    await Promise.resolve(); expect(f.returned).toHaveBeenCalledTimes(1); expect(stopped).toBe(false);
    expect(await f.sessions.resolve(f.target())).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    finish(); await stopping; expect(stopped).toBe(true);
  });

  it('releases failed query ownership and cancels a consumer paused between chunks', async () => {
    const f = fixture(), source = unwrap(await f.sessions.resolve(f.target()));
    vi.mocked(f.io.list).mockRejectedValueOnce(new Error('private details'));
    await expect(source.list('sdcard', 'model')).rejects.toThrow();
    const abort = new AbortController();
    const value = await source.download({ path: '/a.3mf' }, abort.signal), iterator = value.chunks[Symbol.asyncIterator]();
    await iterator.next(); abort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ detail: { code: 'cancelled' } });
    expect(f.returned).toHaveBeenCalledTimes(1); await f.sessions.close();
  });
});
