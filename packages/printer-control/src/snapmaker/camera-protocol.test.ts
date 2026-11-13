import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { U1CameraControl } from '../index';
import type { PrinterTransport } from '@orca/platform-contract';
import { readU1TimelapsePage, u1TimelapseVideoUrl } from './timelapse';

class Socket extends EventTarget {
  readyState: 0 | 1 | 2 | 3 = 0;
  sent: { jsonrpc: string; id: number; method: string; params: Record<string, unknown> }[] = [];
  close = vi.fn(() => { this.readyState = 3; this.dispatchEvent(new Event('close')); });
  send(text: string) { this.sent.push(JSON.parse(text)); }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  result(index: number, result: unknown = { state: 'success', url: '/files/camera/monitor.jpg' }) {
    this.receive({ jsonrpc: '2.0', id: this.sent[index].id, result });
  }
}
function fixture(apiBaseUrl = 'http://printer/proxy', apiKey = '') {
  const socket = new Socket();
  const create = vi.fn(() => socket);
  const request = vi.fn<PrinterTransport['request']>(async () => ({ status: 200,
    json: async () => ({ result: 'one-shot-secret' }), bytes: async () => new Uint8Array() }));
  const options = { http: { request }, sockets: { create }, clientId: 'neo-view-unique' };
  const printer = { apiBaseUrl, apiKey };
  async function connect() {
    const pending = U1CameraControl.connect(printer, options);
    await vi.advanceTimersByTimeAsync(0);
    socket.open();
    return pending;
  }
  return { socket, create, request, printer, options, connect };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('U1 camera control', () => {
  it('reads one timelapse page and closes the independent socket without starting live view', async () => {
    const f = fixture();
    const pending = readU1TimelapsePage(f.printer, 2, 20, f.options, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    f.socket.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.socket.sent).toMatchObject([{ method: 'camera.get_timelapse_instance', params: {
      req_id: expect.any(Number), page_index: 2, page_rows: 20, thumbnail_direct: false,
    } }]);
    f.socket.result(0, { state: 'success', page_index: 2, total_count: 22, instances: [
      { date_index: '20261109131725', gcode_name: 'Test job', video_local_url_suffix: '/files/camera/打印 #%.mp4',
        cover_local_url_suffix: '/files/camera/cover.jpg', video_duration: '00:01', unix_timestamp_s: 1794230792, video_file_size: 777007 },
      { date_index: 'next', gcode_name: 'Pending or invalid', video_local_url_suffix: '/files/camera/../../other.mp4' },
    ] });
    const result = await pending;
    expect(result).toEqual({ total: 22, entries: [{ dateIndex: '20261109131725', name: 'Test job', video: '/files/camera/打印 #%.mp4',
      cover: '/files/camera/cover.jpg', duration: 1, modified: 1794230792000, bytes: 777007 }] });
    expect(f.socket.close).toHaveBeenCalledOnce();
    expect(u1TimelapseVideoUrl(f.printer, result.entries[0].video)).toBe('http://printer/proxy/server/files/camera/%E6%89%93%E5%8D%B0%20%23%25.mp4');
    expect(() => u1TimelapseVideoUrl(f.printer, 'https://other/files/camera/test.mp4')).toThrow('Invalid U1 timelapse asset');
  });

  it('opens lazily and uses the same client identity for start, renewal and stop', async () => {
    const f = fixture(), control = await f.connect();
    expect(f.create).toHaveBeenCalledWith('ws://printer/proxy/websocket');
    expect(f.request).not.toHaveBeenCalled();
    expect(f.socket.sent).toEqual([]);
    const start = control.start(); f.socket.result(0, { state: 'success', url: '/files/camera/monitor.jpg', pw: 'secret', salt: 'salt', iterations: 654 });
    expect(await start).toBe('http://printer/proxy/server/files/camera/monitor.jpg');
    const renew = control.start(); f.socket.result(1); await renew;
    const stop = control.stop(); f.socket.result(2, { state: 'success' }); await stop;
    expect(f.socket.sent).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'camera.start_monitor', params: { domain: 'lan', interval: 0, expect_pw: true, clientid: 'neo-view-unique' } },
      { jsonrpc: '2.0', id: 2, method: 'camera.start_monitor', params: { domain: 'lan', interval: 0, expect_pw: true, clientid: 'neo-view-unique' } },
      { jsonrpc: '2.0', id: 3, method: 'camera.stop_monitor', params: { domain: 'lan', clientid: 'neo-view-unique' } },
    ]);
    control.close(); control.close(); expect(f.socket.close).toHaveBeenCalledTimes(1);
  });

  it('authenticates a secure IPv6 proxy with an ephemeral token', async () => {
    const f = fixture('https://[::1]:8443/proxy/', 'api-secret'), control = await f.connect();
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://[::1]:8443/proxy/access/oneshot_token', headers: { 'X-Api-Key': 'api-secret' } }));
    expect(f.create).toHaveBeenCalledWith('wss://[::1]:8443/proxy/websocket?token=one-shot-secret');
    const start = control.start(); f.socket.result(0, { state: 'success', url: '/files/camera/monitor.jpg?value=a?b' });
    expect(await start).toBe('https://[::1]:8443/proxy/server/files/camera/monitor.jpg?value=a?b');
    control.close();
  });

  it('correlates out-of-order responses and ignores notifications and unknown request IDs', async () => {
    const f = fixture(), control = await f.connect();
    const first = control.start(), second = control.stop();
    f.socket.receive({ jsonrpc: '2.0', method: 'notify_status_update', params: [] });
    f.socket.receive({ jsonrpc: '2.0', id: 999, result: { state: 'success' } });
    f.socket.result(1, { state: 'success' }); await second;
    f.socket.result(0); await expect(first).resolves.toContain('/monitor.jpg');
    control.close();
  });

  it.each([
    ['/files/camera/monitor.jpg.enc', 'no-compatible-media'],
    ['/files/camera/monitor.jpg%2eenc', 'no-compatible-media'],
    ['http://other/server/files/camera/monitor.jpg', 'device-failed'],
    ['http://user:secret@printer/proxy/server/files/camera/monitor.jpg', 'device-failed'],
    ['http://printer/server/files/camera/monitor.jpg', 'device-failed'],
    ['/files/../../elsewhere', 'device-failed'],
    ['/files/camera/%2e%2e%2f..%2fsecret', 'device-failed'],
    ['//other/files/camera/monitor.jpg', 'device-failed'],
    ['', 'device-failed'],
    [null, 'device-failed'],
  ])('rejects unsafe or unsupported acquisition location %s', async (url, code) => {
    const f = fixture(), control = await f.connect();
    const start = control.start(); f.socket.result(0, { state: 'success', url });
    await expect(start).rejects.toMatchObject({ detail: { code } });
    control.close();
  });

  it('accepts a same-origin absolute URL within the configured proxy', async () => {
    const f = fixture(), control = await f.connect();
    const start = control.start(); f.socket.result(0, { state: 'success', url: 'http://printer/proxy/server/files/camera/monitor.jpg?q=1' });
    await expect(start).resolves.toBe('http://printer/proxy/server/files/camera/monitor.jpg?q=1'); control.close();
  });

  it.each([[-32601, 'unsupported'], [401, 'authentication-required'], [403, 'permission-denied'], [-32602, 'device-rejected']])('maps RPC error %s without exposing vendor text', async (code, expected) => {
    const f = fixture(), control = await f.connect();
    const start = control.start(); f.socket.receive({ jsonrpc: '2.0', id: 1, error: { code, message: 'private-secret' } });
    await expect(start).rejects.toMatchObject({ detail: { code: expected } });
    await expect(start).rejects.not.toThrow('private-secret'); control.close();
  });

  it('rejects unsuccessful results and invalid JSON-RPC envelopes', async () => {
    const f = fixture(), control = await f.connect();
    const first = control.start(); f.socket.result(0, { state: 'failed', message: 'private-secret' });
    await expect(first).rejects.toMatchObject({ detail: { code: 'device-rejected' } });
    const second = control.start(); f.socket.receive({ id: 2, result: { state: 'success' } });
    await expect(second).rejects.toMatchObject({ detail: { code: 'device-failed' } }); control.close();
  });

  it('retires all pending requests on connection loss', async () => {
    const f = fixture(), control = await f.connect();
    const pending = Array.from({ length: 8 }, () => control.start());
    const settled = Promise.allSettled(pending);
    f.socket.dispatchEvent(new Event('error'));
    expect((await settled).every(result => result.status === 'rejected')).toBe(true);
    await control.closed;
    await expect(control.stop()).rejects.toMatchObject({ detail: { code: 'transport' } });
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });

  it('times out a request and ignores its late response', async () => {
    const f = fixture(), control = await f.connect();
    const first = control.start(); const rejected = expect(first).rejects.toMatchObject({ detail: { code: 'transport' } });
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    f.socket.result(0);
    const next = control.start(); f.socket.result(1); await next; control.close();
  });

  it('cancels one request without retiring the connection', async () => {
    const f = fixture(), control = await f.connect(), abort = new AbortController();
    const first = control.start(abort.signal); abort.abort();
    await expect(first).rejects.toMatchObject({ detail: { code: 'cancelled' } });
    f.socket.result(0);
    const stop = control.stop(); f.socket.result(1); await stop; control.close();
  });

  it('cancels an opening connection and closes its socket', async () => {
    const f = fixture(), abort = new AbortController();
    const opening = U1CameraControl.connect(f.printer, { ...f.options, signal: abort.signal }); abort.abort();
    await expect(opening).rejects.toMatchObject({ detail: { code: 'cancelled' } });
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });

  it('bounds connection opening and rejects malformed control messages', async () => {
    const f = fixture(), opening = U1CameraControl.connect(f.printer, f.options);
    const rejected = expect(opening).rejects.toMatchObject({ detail: { code: 'transport' } });
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    const g = fixture(), control = await g.connect(), start = control.start();
    g.socket.dispatchEvent(new MessageEvent('message', { data: '{' }));
    await expect(start).rejects.toMatchObject({ detail: { code: 'device-failed' } }); control.close();
  });

  it.each([[401, 'authentication-required'], [403, 'permission-denied'], [500, 'transport']])('handles token HTTP status %s before opening a socket', async (status, code) => {
    const f = fixture('http://printer', 'secret');
    f.request.mockResolvedValue({ status, json: async () => ({}), bytes: async () => new Uint8Array() });
    await expect(U1CameraControl.connect(f.printer, f.options)).rejects.toMatchObject({ detail: { code } });
    expect(f.create).not.toHaveBeenCalled();
  });

  it('bounds a token body read even when a transport ignores abort', async () => {
    const f = fixture('http://printer', 'secret');
    f.request.mockResolvedValue({ status: 200, json: () => new Promise(() => {}), bytes: async () => new Uint8Array() });
    const opening = U1CameraControl.connect(f.printer, f.options);
    const rejected = expect(opening).rejects.toMatchObject({ detail: { code: 'transport' } });
    await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(f.create).not.toHaveBeenCalled();
  });
});
