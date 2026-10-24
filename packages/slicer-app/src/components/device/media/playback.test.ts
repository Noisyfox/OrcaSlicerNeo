import { describe, expect, it } from 'vitest';
import { playbackUrl } from './playback';

describe('remote media URL admission', () => {
  it('preserves signed URL queries without downloading or rewriting the resource', () => {
    expect(playbackUrl('/camera?signature=opaque', 'https://agent.test/view')).toBe('https://agent.test/camera?signature=opaque');
    expect(playbackUrl('http://127.0.0.1:4000/live', 'http://localhost/')).toBe('http://127.0.0.1:4000/live');
  });
  it('rejects embedded passwords, executable protocols and HTTPS downgrades', () => {
    for (const url of ['https://user:secret@agent.test/live', 'javascript:alert(1)', 'file:///tmp/video', 'http://agent.test/live']) {
      expect(() => playbackUrl(url, 'https://app.test/')).toThrow('This media URL is not supported');
    }
  });
});
