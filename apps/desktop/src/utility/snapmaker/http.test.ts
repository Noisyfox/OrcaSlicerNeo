import { afterEach, expect, it, vi } from 'vitest';
import { cameraHttpTransport } from './http';
afterEach(() => vi.unstubAllGlobals());
it('reads binary bytes and token JSON without renderer IO', async () => {
  const fetch = vi.fn(async () => new Response('{"result":"token"}')); vi.stubGlobal('fetch', fetch);
  const response = await cameraHttpTransport.request({ method: 'GET', url: 'http://printer/token', maxResponseBytes: 100 });
  expect(await response.json()).toEqual({ result: 'token' });
  expect(fetch).toHaveBeenCalledWith('http://printer/token', expect.objectContaining({ redirect: 'error' }));
});
it('cancels oversized streaming bodies before buffering the complete response', async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(stream)));
  await expect(cameraHttpTransport.request({ method: 'GET', url: 'http://printer/image', responseType: 'bytes', maxResponseBytes: 8 })).rejects.toThrow('size limit');
  expect(cancel).toHaveBeenCalledOnce();
});
it('rejects a declared oversized body without reading it', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(20), { headers: { 'Content-Length': '20' } })));
  await expect(cameraHttpTransport.request({ method: 'GET', url: 'http://printer/image', maxResponseBytes: 8 })).rejects.toThrow('size limit');
});
