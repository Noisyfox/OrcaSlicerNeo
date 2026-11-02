import { expect, it } from 'vitest';
import { externalHttpsUrl } from './externalLinks';
it('permits documentation HTTPS links and rejects executable, local and credential-bearing URLs', () => {
  expect(externalHttpsUrl('https://wiki.bambulab.com/en/guide')).toBe('https://wiki.bambulab.com/en/guide');
  for (const value of ['javascript:alert(1)', 'file:///tmp/file', 'http://printer/', 'https://user:secret@host/', null, 'bad'])
    expect(() => externalHttpsUrl(value)).toThrow();
});
