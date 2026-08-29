import { describe, expect, it, vi } from 'vitest';
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
  request(options: Parameters<NativeHttpClient['request']>[0], handlers: Parameters<NativeHttpClient['request']>[1]): NativeHttpRequestHandle {
    this.options = options; this.handlers = handlers;
    return {
      write: (_bytes, onAccepted) => onAccepted?.(),
      end: () => {},
      abort: () => { this.aborted = true; handlers.error(new Error('aborted')); },
    };
  }
  complete(statusCode = 200, text = '{}') { this.handlers?.response(response(statusCode, text)); }
}

describe('Electron printer HTTP main transport', () => {
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
