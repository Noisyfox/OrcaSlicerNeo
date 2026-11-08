import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { U1CameraMedia, U1_CAMERA_ID } from '../index';
import type * as D from '../domain';
import type { PrinterConfiguration } from '../configuration';
import type { PrinterTransport } from '../transport';

const id = <K extends string>(value: string) => value as D.Id<K>;
const target = { printerId: id<'printer'>('u1'), routeId: id<'route'>('u1-route') };
const jpeg = () => new Uint8Array([255, 216, 1, 2, 255, 217]);
class Socket extends EventTarget {
  readyState: 0 | 1 | 2 | 3 = 1;
  sent: { id: number; method: string; params: Record<string, unknown> }[] = [];
  url = '/files/camera/monitor.jpg';
  reply = true;
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send(text: string) {
    const message = JSON.parse(text); this.sent.push(message);
    if (this.reply) void Promise.resolve().then(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: message.method === 'camera.start_monitor' ? { state: 'success', url: this.url } : { state: 'success' } }) })));
  }
}
const owners: U1CameraMedia[] = [];
function fixture() {
  const printer: PrinterConfiguration = { id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer', apiKey: '', consoleUrl: '' };
  const sockets: Socket[] = [];
  const create = vi.fn(() => { const socket = new Socket(); sockets.push(socket); return socket; });
  const request = vi.fn<PrinterTransport['request']>(async () => ({ status: 200, json: async () => ({}), bytes: async () => jpeg() }));
  const resolve = vi.fn(async (_target: D.TargetRequest) => ({ printer, revision: 'revision-1' }));
  const owner = new U1CameraMedia({ http: { request }, sockets: { create }, resolve }); owners.push(owner);
  const openRequest: D.OpenMediaRequest = { target, requestId: id<'request'>('first'), source: { kind: 'camera', cameraId: U1_CAMERA_ID },
    client: { video: [{ transport: 'jpeg-frames', codecIds: ['jpeg'] }], imageMimeTypes: ['image/jpeg'], contentFormats: [] } };
  async function open(overrides: Partial<D.OpenMediaRequest> = {}) {
    const result = await owner.api.open({ ...openRequest, ...overrides });
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  }
  function reader(descriptor: D.MediaDescriptor, signal?: AbortSignal) {
    const presentation = descriptor.presentation;
    if (presentation.kind !== 'video' || presentation.delivery.transport !== 'jpeg-frames') throw new Error('Invalid fixture descriptor');
    return owner.api.readStream({ media: descriptor.ref, streamId: presentation.delivery.streamId }, { signal })[Symbol.asyncIterator]();
  }
  const starts = () => sockets.flatMap(socket => socket.sent).filter(message => message.method === 'camera.start_monitor');
  const stops = () => sockets.flatMap(socket => socket.sent).filter(message => message.method === 'camera.stop_monitor');
  return { owner, request, resolve, printer, sockets, create, openRequest, open, reader, starts, stops };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.dispose())); vi.useRealTimers(); });

describe('U1 camera media resources', () => {
  it('opens, emits complete JPEGs and releases the same monitor identity idempotently', async () => {
    const f = fixture(), descriptor = await f.open(), reader = f.reader(descriptor);
    expect(descriptor.presentation).toMatchObject({ live: true, seekable: false, delivery: { transport: 'jpeg-frames' } });
    expect((await reader.next()).value).toMatchObject({ kind: 'jpeg', generation: 1, sequence: 0, bytes: jpeg() });
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ maxResponseBytes: 16 * 1024 * 1024, responseType: 'bytes' }));
    await f.owner.api.close(descriptor.ref); await f.owner.api.close(descriptor.ref);
    expect(f.stops()).toHaveLength(1);
    expect(f.stops()[0].params.clientid).toBe(f.starts()[0].params.clientid);
    expect(f.sockets[0].readyState).toBe(3); await reader.return?.();
  });

  it('reserves admission before configuration reads and coalesces identical request IDs', async () => {
    const f = fixture();
    const first = f.owner.api.open(f.openRequest), duplicate = f.owner.api.open(f.openRequest);
    await expect(f.owner.api.open({ ...f.openRequest, requestId: id<'request'>('competing') })).resolves.toMatchObject({ ok: false, error: { code: 'busy' } });
    const [a, b] = await Promise.all([first, duplicate]); expect(a).toEqual(b);
    expect(f.starts()).toHaveLength(1);
    await expect(f.owner.api.open({ ...f.openRequest, source: { kind: 'camera', cameraId: U1_CAMERA_ID, profileId: 'changed' } })).resolves.toMatchObject({ ok: false });
  });

  it('caps image request starts at 5 Hz and keeps only the latest pending JPEG', async () => {
    const f = fixture(), descriptor = await f.open();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.request).toHaveBeenCalledTimes(5);
    const reader = f.reader(descriptor); expect((await reader.next()).value?.sequence).toBe(0);
    await vi.advanceTimersByTimeAsync(201);
    expect((await reader.next()).value?.sequence).toBe(1);
    await reader.return?.();
  });

  it('serializes slow acquisition without catch-up bursts', async () => {
    const f = fixture(); let complete!: () => void;
    f.request.mockImplementation(async () => { await new Promise<void>(resolve => { complete = resolve; }); return { status: 200, json: async () => ({}), bytes: async () => jpeg() }; });
    const descriptor = await f.open(), reader = f.reader(descriptor); const first = reader.next();
    await vi.advanceTimersByTimeAsync(900); expect(f.request).toHaveBeenCalledTimes(1);
    complete(); await first; await vi.advanceTimersByTimeAsync(0);
    expect(f.request).toHaveBeenCalledTimes(2);
    await f.owner.api.close(descriptor.ref); await reader.return?.();
  });

  it('renews media leases independently and throttles interaction-triggered monitor renewal', async () => {
    const f = fixture(), descriptor = await f.open(), reader = f.reader(descriptor); await reader.next();
    await vi.advanceTimersByTimeAsync(1000);
    const renewed = await f.owner.api.renew(descriptor.ref); expect(renewed).toMatchObject({ ok: true, value: { expiresAtMs: 301000 } });
    expect(f.starts()).toHaveLength(1);
    f.owner.interact(descriptor.ref); f.owner.interact(descriptor.ref);
    await vi.advanceTimersByTimeAsync(200); expect(f.starts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_000); f.owner.interact(descriptor.ref);
    await vi.advanceTimersByTimeAsync(200); expect(f.starts()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000); f.owner.interact(descriptor.ref);
    await vi.advanceTimersByTimeAsync(200); expect(f.starts()).toHaveLength(3);
    await reader.return?.();
  });

  it('renews the device at 300 seconds with the same client identity', async () => {
    const f = fixture(), descriptor = await f.open(), reader = f.reader(descriptor); await reader.next();
    await vi.advanceTimersByTimeAsync(240_000); await f.owner.api.renew(descriptor.ref);
    await vi.advanceTimersByTimeAsync(60_200);
    expect(f.starts()).toHaveLength(2);
    expect(new Set(f.starts().map(message => message.params.clientid)).size).toBe(1);
    await reader.return?.();
  });

  it('drops truncated frames, reports recovery and resumes valid delivery', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ status: 200, json: async () => ({}), bytes: async () => new Uint8Array([255, 216, 1]) });
    const descriptor = await f.open(), reader = f.reader(descriptor), events = f.owner.api.watch(descriptor.ref)[Symbol.asyncIterator]();
    await vi.advanceTimersByTimeAsync(0); await events.next(); await events.next();
    expect((await events.next()).value).toMatchObject({ payload: { type: 'state', state: 'connecting' } });
    const next = reader.next(); await vi.advanceTimersByTimeAsync(1000);
    expect((await next).value?.kind).toBe('jpeg');
    await events.return?.(); await reader.return?.();
  });

  it('ends recovery after 30 seconds despite repeated failed images', async () => {
    const f = fixture(); f.request.mockRejectedValue(new Error('private transport detail'));
    const descriptor = await f.open(), reader = f.reader(descriptor);
    const next = reader.next(); const rejected = expect(next).rejects.toMatchObject({ detail: { code: 'transport', message: 'Camera recovery timed out.' } });
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(f.stops()).toHaveLength(1);
  });

  it('fails authorization directly and closes the monitor without retrying images', async () => {
    const f = fixture(); f.request.mockResolvedValue({ status: 403, json: async () => ({}), bytes: async () => jpeg() });
    const descriptor = await f.open(); await vi.advanceTimersByTimeAsync(0);
    const reader = f.reader(descriptor);
    await expect(reader.next()).rejects.toMatchObject({ detail: { code: 'permission-denied' } });
    expect(f.request).toHaveBeenCalledTimes(1); expect(f.stops()).toHaveLength(1);
  });

  it('invalidates changed configurations while cleanup retains the original connection', async () => {
    const f = fixture(), descriptor = await f.open(), reader = f.reader(descriptor); await reader.next();
    f.resolve.mockResolvedValue({ printer: { ...f.printer, apiBaseUrl: 'http://different-printer' }, revision: 'revision-2' });
    const next = reader.next(), rejected = expect(next).rejects.toMatchObject({ detail: { code: 'stale-context' } });
    await vi.advanceTimersByTimeAsync(200); await rejected;
    expect(f.create).toHaveBeenCalledTimes(1); expect(f.stops()).toHaveLength(1);
  });

  it('starts a new stream generation when the control connection is replaced', async () => {
    const f = fixture(), descriptor = await f.open(), reader = f.reader(descriptor); const first = (await reader.next()).value!;
    f.sockets[0].close(); await vi.advanceTimersByTimeAsync(200);
    expect((await reader.next()).value).toMatchObject({ generation: first.generation + 1, sequence: 0 });
    expect(f.starts()[0].params.clientid).toBe(f.starts()[1].params.clientid);
    await reader.return?.();
  });

  it('releases unattached and expired resources', async () => {
    const f = fixture(), descriptor = await f.open();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.stops()).toHaveLength(1);
    await expect(f.owner.api.renew(descriptor.ref)).resolves.toMatchObject({ ok: false, error: { code: 'lease-expired' } });
    expect((await f.open({ requestId: id<'request'>('new') })).ref.id).not.toBe(descriptor.ref.id);
  });

  it('completes local cleanup even when stop never receives an acknowledgement', async () => {
    const f = fixture(), descriptor = await f.open(); f.sockets[0].reply = false;
    const closed = f.owner.api.close(descriptor.ref);
    await vi.advanceTimersByTimeAsync(5000); await expect(closed).resolves.toEqual({ ok: true, value: null });
    expect(f.sockets[0].readyState).toBe(3);
  });

  it('cancels an unresolved configuration read without holding admission', async () => {
    const f = fixture(), abort = new AbortController();
    f.resolve.mockImplementationOnce(() => new Promise(() => {}));
    const opening = f.owner.api.open(f.openRequest, { signal: abort.signal }); abort.abort();
    await expect(opening).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(f.create).not.toHaveBeenCalled();
    await expect(f.open({ requestId: id<'request'>('replacement') })).resolves.toBeDefined();
  });

  it('stops a cancelled start and ignores its late acknowledgement', async () => {
    const f = fixture(), abort = new AbortController();
    f.create.mockImplementation(() => { const socket = new Socket(); socket.reply = false; f.sockets.push(socket); return socket; });
    const opening = f.owner.api.open(f.openRequest, { signal: abort.signal });
    await vi.advanceTimersByTimeAsync(0); expect(f.starts()).toHaveLength(1);
    f.sockets[0].reply = true; abort.abort();
    await expect(opening).resolves.toMatchObject({ ok: false, error: { code: 'cancelled' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stops()).toHaveLength(1); expect(f.sockets[0].readyState).toBe(3);
    f.sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { state: 'success', url: '/files/camera/monitor.jpg' } }) }));
    expect(f.request).not.toHaveBeenCalled();
  });

  it('preserves pacing after a slow monitor renewal', async () => {
    const f = fixture(), descriptor = await f.open(), reader = f.reader(descriptor); await reader.next();
    f.sockets[0].reply = false; f.owner.interact(descriptor.ref);
    await vi.advanceTimersByTimeAsync(1200); expect(f.request).toHaveBeenCalledTimes(1);
    const id = f.sockets[0].sent.at(-1)!.id;
    f.sockets[0].reply = true;
    f.sockets[0].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ jsonrpc: '2.0', id, result: { state: 'success', url: '/files/camera/monitor.jpg' } }) }));
    await vi.advanceTimersByTimeAsync(199); expect(f.request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(f.request).toHaveBeenCalledTimes(3);
    await reader.return?.();
  });

  it('rejects a stale expected configuration before camera startup', async () => {
    const f = fixture();
    await expect(f.owner.api.open({ ...f.openRequest, target: { ...target, expectedConfigurationRevision: 'old' } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('rejects conflicting reuse of an open request and retains closed identities', async () => {
    const f = fixture(), descriptor = await f.open();
    await expect(f.owner.api.open({ ...f.openRequest, client: { ...f.openRequest.client, contentFormats: ['changed'] } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'invalid-request' } });
    await f.owner.api.close(descriptor.ref);
    await expect(f.open()).resolves.toEqual(descriptor);
    expect(f.starts()).toHaveLength(1);
  });
});
