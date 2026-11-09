import { afterEach, expect, it, vi } from 'vitest';
import { cameraHttpTransport } from './http';
afterEach(() => vi.unstubAllGlobals());
it('reads binary bytes and token JSON without renderer IO', async () => {
  const fetch = vi.fn(async () => new Response('{"result":"token"}')); vi.stubGlobal('fetch', fetch);
  const response = await cameraHttpTransport.request({ method: 'GET', url: 'http://printer/token' });
  expect(await response.json()).toEqual({ result: 'token' });
  expect(fetch).toHaveBeenCalledWith('http://printer/token', expect.objectContaining({ redirect: 'error' }));
});
