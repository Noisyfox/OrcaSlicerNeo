import { describe, expect, it } from 'vitest';
import { rendererIsolationHeaders } from './sessionHeaders';

describe('renderer isolation response headers', () => {
  it.each(['/', '/assets/app.js', '/worker.js', '/wasm/threaded/orca_slice.wasm'])('isolates renderer resource %s', (path) => {
    expect(rendererIsolationHeaders(`http://127.0.0.1:1234${path}`, 'http://127.0.0.1:1234')).toEqual({
      'Cross-Origin-Opener-Policy': ['same-origin'],
      'Cross-Origin-Embedder-Policy': ['require-corp'],
    });
  });

  it.each(['http://u1.lan/', 'http://u1.lan/monacoeditorwork/editor.worker.bundle.js', 'http://127.0.0.1:1235/', 'https://127.0.0.1:1234/', 'blob:http://u1.lan/id', 'invalid'])('preserves external response %s', (url) => {
    const headers = { 'content-type': ['text/javascript'], 'Cross-Origin-Embedder-Policy': ['credentialless'] };
    expect(rendererIsolationHeaders(url, 'http://127.0.0.1:1234', headers)).toBe(headers);
  });

  it('supports the Vite development origin and replaces headers case-insensitively', () => {
    expect(rendererIsolationHeaders('http://localhost:5173/worker.js', 'http://localhost:5173/index.html', {
      'cross-origin-embedder-policy': ['unsafe-none'], 'cross-origin-opener-policy': ['unsafe-none'], 'content-type': ['text/javascript'],
    })).toEqual({
      'content-type': ['text/javascript'], 'Cross-Origin-Opener-Policy': ['same-origin'], 'Cross-Origin-Embedder-Policy': ['require-corp'],
    });
  });

  it.each(['', 'invalid', 'file:///index.html'])('does not inject headers without a valid renderer HTTP origin: %s', (origin) => {
    const headers = { 'content-type': ['text/html'] };
    expect(rendererIsolationHeaders('http://u1.lan/', origin, headers)).toBe(headers);
  });
});
