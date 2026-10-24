import { expect, test } from 'vitest';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import desktop from '../../electron.vite.config';

test('dev HTML revalidation delivers the current CSP while modules retain conditional caching', async () => {
  const environment = { command: 'serve' as const, mode: 'development' };
  const config = await (typeof desktop === 'function' ? desktop(environment) : desktop);
  const server = await createServer({
    ...config.renderer,
    configFile: false,
    root: fileURLToPath(new URL('../renderer', import.meta.url)),
    server: { ...config.renderer?.server, host: '127.0.0.1', port: 0, hmr: false, watch: null, preTransformRequests: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent',
  });
  try {
    await server.listen();
    const origin = server.resolvedUrls!.local[0];
    const headers = server.config.server.headers!;
    const currentPolicy = headers['content-security-policy'];
    for (const path of ['', 'index.html?reload=1']) {
      headers['content-security-policy'] = "default-src 'self'";
      const first = await fetch(new URL(path, origin), { headers: { accept: 'text/html' } });
      const html = await first.text();
      const etag = first.headers.get('etag');
      expect(first.headers.get('content-security-policy')).toBe("default-src 'self'");
      expect(etag).toBeTruthy();
      // A CSP-only config change leaves this HTML ETag unchanged. Even a
      // client holding the old policy must receive a full response on reload.
      headers['content-security-policy'] = currentPolicy;
      const revalidated = await fetch(new URL(path, origin), { headers: { accept: 'text/html', 'if-none-match': etag! } });
      expect(revalidated.status).toBe(200);
      expect(revalidated.headers.get('content-security-policy')).toContain("media-src 'self' blob:");
      expect(await revalidated.text()).toBe(html);
    }
    const module = await fetch(new URL('@vite/client', origin));
    await module.text();
    const revalidatedModule = await fetch(new URL('@vite/client', origin), { headers: { 'if-none-match': module.headers.get('etag')! } });
    expect(revalidatedModule.status).toBe(304);
  } finally {
    await server.close();
  }
});
