import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { createPrinterTransportIpcHandlers, encodePrinterTransportBody, type NativeHttpClient, type NativeHttpRequestHandle } from './printerHttpTransport';

function response(statusCode: number, text: string) {
  return {
    statusCode,
    onData(listener: (chunk: Uint8Array) => void) { queueMicrotask(() => listener(new TextEncoder().encode(text))); },
    onEnd(listener: () => void) { queueMicrotask(listener); },
    onError() {},
  };
}

class FakeClient implements NativeHttpClient {
  options?: Parameters<NativeHttpClient['request']>[0];
  handlers?: Parameters<NativeHttpClient['request']>[1];
  aborted = false;
  writes: Uint8Array[] = [];
  callbacks: Array<NonNullable<Parameters<NativeHttpRequestHandle['write']>[1]>> = [];
  deferWrites = false;
  ended = false;
  request(options: Parameters<NativeHttpClient['request']>[0], handlers: Parameters<NativeHttpClient['request']>[1]): NativeHttpRequestHandle {
    this.options = options; this.handlers = handlers;
    return {
      write: (bytes, onAccepted) => {
        this.writes.push(bytes);
        if (onAccepted) {
          if (this.deferWrites) this.callbacks.push(onAccepted);
          else onAccepted();
        }
      },
      end: () => { this.ended = true; },
      abort: () => { this.aborted = true; handlers.error(new Error('aborted')); },
    };
  }
  complete(statusCode = 200, text = '{}') { this.handlers?.response(response(statusCode, text)); }
}

describe('Electron printer HTTP main transport', () => {
  const largeBody = {
    kind: 'multipart' as const, fields: { root: 'gcodes' },
    file: { fileName: 'large.gcode', bytes: new Uint8Array(200_000).fill(42) },
  };

  it('reports real socket progress while a large upload is blocked by a slow receiver', async () => {
    let resumeReceiver = () => {};
    let receiverReady!: () => void;
    const receiving = new Promise<void>(resolve => { receiverReady = resolve; });
    const chunks: Buffer[] = [];
    const server = createServer((request, response) => {
      request.once('data', () => {
        request.pause();
        resumeReceiver = () => request.resume();
        receiverReady();
      });
      request.on('data', chunk => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const sender = {};
    const progress = vi.fn();
    const handlers = createPrinterTransportIpcHandlers({ isCurrentRenderer: () => true, sendProgress: progress });
    const body = { ...largeBody, file: { ...largeBody.file, bytes: new Uint8Array(32 * 1024 * 1024).fill(42) } };
    const encoded = encodePrinterTransportBody(body).bytes;
    const pending = handlers.request(sender, 'slow', { method: 'POST', url: `http://127.0.0.1:${address.port}/upload`, body });
    // Attach a rejection handler immediately, including fixture cleanup paths.
    void pending.catch(() => undefined);
    try {
      await receiving;
      // Give the sender time to fill the socket buffers while the receiver is
      // paused. The upload must not report all 32 MiB as sent at this point.
      await new Promise(resolve => setTimeout(resolve, 100));
      const { loaded, total } = progress.mock.calls.at(-1)![2];
      expect(loaded).toBeGreaterThan(0);
      expect(loaded).toBeLessThan(total);
      expect(total).toBe(encoded.length);
      resumeReceiver();
      await expect(pending).resolves.toEqual({ status: 200, json: {} });
      expect(progress.mock.calls.at(-1)![2]).toEqual({ loaded: encoded.length, total: encoded.length });
      expect(Buffer.concat(chunks).equals(Buffer.from(encoded))).toBe(true);
    } finally {
      handlers.cancel(sender, 'slow');
      resumeReceiver();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 15_000);

  it('reports bounded intermediate writes and preserves the body while awaiting the response', async () => {
    const client = new FakeClient();
    client.deferWrites = true;
    const current = {};
    const progress = vi.fn();
    const handlers = createPrinterTransportIpcHandlers({ isCurrentRenderer: () => true, client, sendProgress: progress });
    const pending = handlers.request(current, 'large', { method: 'POST', url: 'http://printer.local/upload', body: largeBody });
    const resolved = vi.fn();
    void pending.then(resolved);
    const expected = encodePrinterTransportBody(largeBody).bytes;
    expect(client.writes).toHaveLength(1);
    expect(progress.mock.calls.at(-1)?.[2]).toEqual({ loaded: 0, total: expected.length });
    while (!client.ended) {
      const previousCount = client.writes.length;
      client.callbacks.shift()!();
      const { loaded, total } = progress.mock.calls.at(-1)![2];
      expect(loaded).toBe(client.writes.reduce((sum, bytes) => sum + bytes.length, 0));
      expect(total).toBe(expected.length);
      expect(client.writes).toHaveLength(previousCount);
      await Promise.resolve();
    }
    expect(client.writes.every(bytes => bytes.length <= 64 * 1024)).toBe(true);
    expect(Buffer.concat(client.writes)).toEqual(Buffer.from(expected));
    expect(progress.mock.calls.some(call => call[2].loaded > 0 && call[2].loaded < expected.length)).toBe(true);
    expect(resolved).not.toHaveBeenCalled();
    client.complete();
    await expect(pending).resolves.toEqual({ status: 200, json: {} });
  });

  it.each(['cancel', 'error', 'response'] as const)('stops writes and ignores late callbacks after %s', async (ending) => {
    const client = new FakeClient();
    client.deferWrites = true;
    const current = {};
    const progress = vi.fn();
    const handlers = createPrinterTransportIpcHandlers({ isCurrentRenderer: () => true, client, sendProgress: progress });
    const pending = handlers.request(current, 'late', { method: 'POST', url: 'http://printer.local/upload', body: largeBody });
    if (ending === 'cancel') handlers.cancel(current, 'late');
    else if (ending === 'error') client.handlers!.error(new Error('socket failure'));
    else client.complete(413);
    if (ending === 'response') await expect(pending).resolves.toEqual({ status: 413 });
    else await expect(pending).rejects.toThrow('Printer request failed');
    client.callbacks.shift()!();
    await Promise.resolve();
    expect(client.writes).toHaveLength(1);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(client.ended).toBe(false);
  });

  it('rejects a failed write without reporting it as uploaded', async () => {
    const client = new FakeClient();
    client.deferWrites = true;
    const progress = vi.fn();
    const handlers = createPrinterTransportIpcHandlers({ isCurrentRenderer: () => true, client, sendProgress: progress });
    const pending = handlers.request({}, 'failed', { method: 'POST', url: 'http://printer.local/upload', body: largeBody });
    client.callbacks.shift()!(new Error('write failed'));
    await expect(pending).rejects.toThrow('Printer request failed');
    expect(progress).toHaveBeenCalledTimes(1);
    expect(client.aborted).toBe(true);
    expect(client.writes).toHaveLength(1);
  });

  it('encodes JSON and multipart bodies', () => {
    const json = encodePrinterTransportBody({ kind: 'json', json: '{"ok":true}' });
    expect(new TextDecoder().decode(json.bytes)).toBe('{"ok":true}');
    expect(json.contentType).toBe('application/json');
    const multipart = encodePrinterTransportBody({ kind: 'multipart', fields: { root: 'gcodes' }, file: { fileName: 'cube".gcode', bytes: new Uint8Array([1, 2]) } }, 'test-boundary');
    const text = new TextDecoder().decode(multipart.bytes);
    expect(text).toContain('name="root"');
    expect(text).toContain('filename="cube_.gcode"');
    expect(text).toContain('test-boundary');
    expect(text.endsWith('--\r\n')).toBe(true);
  });

  it('keeps headers, parses successful JSON, and forwards safe upload progress', async () => {
    const client = new FakeClient();
    const current = {};
    const progress = vi.fn();
    const handlers = createPrinterTransportIpcHandlers({ isCurrentRenderer: (sender) => sender === current, client, sendProgress: progress });
    const pending = handlers.request(current, 'one', {
      method: 'POST', url: 'http://printer.local/upload', headers: { 'X-Api-Key': 'secret-key' },
      body: { kind: 'multipart', fields: { root: 'gcodes' }, file: { fileName: 'a.gcode', bytes: new Uint8Array([1, 2]) } },
    });
    expect(client.options?.headers).toMatchObject({ 'X-Api-Key': 'secret-key', 'Content-Length': expect.any(String) });
    expect(progress).toHaveBeenNthCalledWith(1, current, 'one', { loaded: 0, total: expect.any(Number) });
    expect(progress).toHaveBeenNthCalledWith(2, current, 'one', { loaded: expect.any(Number), total: expect.any(Number) });
    client.complete(200, '{"result":{"ok":true}}');
    await expect(pending).resolves.toEqual({ status: 200, json: { result: { ok: true } } });
  });

  it('rejects guest senders and supports current-renderer cancellation', async () => {
    const client = new FakeClient();
    const current = {};
    const guest = {};
    const handlers = createPrinterTransportIpcHandlers({ isCurrentRenderer: (sender) => sender === current, client, sendProgress() {} });
    await expect(handlers.request(guest, 'guest', { method: 'GET', url: 'http://printer.local/status' })).rejects.toThrow('sender rejected');
    const pending = handlers.request(current, 'two', { method: 'GET', url: 'http://printer.local/status' });
    handlers.cancel(guest, 'two');
    expect(client.aborted).toBe(false);
    handlers.cancel(current, 'two');
    await expect(pending).rejects.toThrow('Printer request failed');
    expect(client.aborted).toBe(true);
  });

  it('does not return response text when HTTP or JSON parsing fails', async () => {
    const client = new FakeClient();
    const current = {};
    const handlers = createPrinterTransportIpcHandlers({ isCurrentRenderer: () => true, client, sendProgress() {} });
    const http = handlers.request(current, 'http', { method: 'GET', url: 'http://printer.local/status' });
    client.complete(401, 'secret-key leaked by server');
    await expect(http).resolves.toEqual({ status: 401 });
    const invalid = handlers.request(current, 'invalid', { method: 'GET', url: 'http://printer.local/status' });
    client.complete(200, 'secret-key leaked by server');
    await expect(invalid).resolves.toEqual({ status: 200, jsonError: true });
  });
});
