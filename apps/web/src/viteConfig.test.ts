import { describe, expect, it } from 'vitest';
import { isolationHeaders } from './viteIsolation';

describe('web Vite isolation headers', () => {
  it('keeps COOP/COEP enabled by default', () => {
    expect(isolationHeaders({})).toEqual({
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    });
  });

  it('disables isolation for the singlethread mode environment', () => {
    expect(isolationHeaders({ ORCA_WEB_NO_ISOLATION: '1' })).toEqual({});
  });
});
