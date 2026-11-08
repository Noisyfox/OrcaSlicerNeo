import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPrinterTransport } from './browserPrinterTransport';

class FakeXHR extends EventTarget {
  static latest: FakeXHR;
  readonly upload = new EventTarget();
  readonly headers: Record<string, string> = {};
  method = '';
  url = '';
  status = 200;
  responseText = '';
  responseType = '';
  response: ArrayBuffer | null = null;
  body: unknown;
  constructor() { super(); FakeXHR.latest = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body?: unknown) { this.body = body; }
  abort() { this.dispatchEvent(new Event('abort')); }
  complete(status: number, body: string | Uint8Array) {
    this.status = status;
    if (typeof body === 'string') this.responseText = body;
    else this.response = body.slice().buffer;
    this.dispatchEvent(new Event('load'));
  }
  fail() { this.dispatchEvent(new Event('error')); }
}

describe('BrowserPrinterTransport', () => {
  beforeEach(() => vi.stubGlobal('XMLHttpRequest', FakeXHR));

  it('sends GET headers and parses JSON', async () => {
    const promise = new BrowserPrinterTransport().request({ method: 'GET', url: 'http://printer.local/server/info', headers: { 'X-Api-Key': 'secret-key' } });
    expect(FakeXHR.latest.method).toBe('GET');
    expect(FakeXHR.latest.headers).toEqual({ 'X-Api-Key': 'secret-key' });
    FakeXHR.latest.complete(200, '{"result":{"ok":true}}');
    const response = await promise;
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: { ok: true } });
  });

  it('sends serialized JSON without changing caller headers', async () => {
    const promise = new BrowserPrinterTransport().request({
      method: 'POST', url: 'http://printer.local/printer/print/start',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'key' },
      body: { kind: 'json', json: '{"filename":"cube.gcode"}' },
    });
    expect(FakeXHR.latest.body).toBe('{"filename":"cube.gcode"}');
    expect(FakeXHR.latest.headers).toEqual({ 'Content-Type': 'application/json', 'X-Api-Key': 'key' });
    FakeXHR.latest.complete(200, '{}');
    await promise;
  });

  it('receives binary images without decoding them as text or JSON', async () => {
    const promise = new BrowserPrinterTransport().request({ method: 'GET', url: 'http://printer.local/image.png', responseType: 'bytes' });
    expect(FakeXHR.latest.responseType).toBe('arraybuffer');
    const image = new Uint8Array([137, 80, 78, 71, 0, 255]);
    FakeXHR.latest.complete(200, image);
    const response = await promise;
    expect(response.status).toBe(200);
    await expect(response.bytes()).resolves.toEqual(image);
  });

  it.each(['cube.gcode', '测试 café.GCODE', 'cube"<>:?*.custom'])('materializes filename %s unchanged in FormData and forwards upload progress', async (fileName) => {
    const progress = vi.fn();
    const promise = new BrowserPrinterTransport().request({
      method: 'POST', url: 'http://printer.local/server/files/upload',
      headers: { 'X-Api-Key': 'key' }, body: {
        kind: 'multipart', fields: { root: 'gcodes' }, file: { fileName, bytes: new Uint8Array([1, 2, 3]) },
      }, onUploadProgress: progress,
    });
    const form = FakeXHR.latest.body as FormData;
    expect(form.get('root')).toBe('gcodes');
    const file = form.get('file') as File;
    expect(file.name).toBe(fileName);
    expect(file.size).toBe(3);
    const event = new Event('progress') as ProgressEvent;
    Object.defineProperties(event, { loaded: { value: 2 }, total: { value: 3 }, lengthComputable: { value: true } });
    FakeXHR.latest.upload.dispatchEvent(event);
    expect(progress).toHaveBeenCalledWith({ loaded: 2, total: 3 });
    FakeXHR.latest.complete(201, '{"result":{}}');
    await promise;
  });

  it('supports abort/error and never exposes an API key in errors', async () => {
    const controller = new AbortController();
    const cancelled = new BrowserPrinterTransport().request({ method: 'GET', url: 'http://printer.local/status', headers: { 'X-Api-Key': 'top-secret' }, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });

    const failed = new BrowserPrinterTransport().request({ method: 'GET', url: 'http://printer.local/status', headers: { 'X-Api-Key': 'top-secret' } });
    FakeXHR.latest.fail();
    await expect(failed).rejects.toThrow('Printer request failed');
    await expect(failed).rejects.not.toThrow('top-secret');
  });
});
