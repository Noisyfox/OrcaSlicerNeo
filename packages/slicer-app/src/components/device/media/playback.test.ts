// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { playbackUrl } from './playback';
import { startMediaPlayback, type PlaybackState } from './playback';
import type { MediaDescriptor, MediaStreamPacket, PrinterMedia } from '@orca/printer-control/domain';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function jpegPlayer() {
  vi.useFakeTimers();
  let decodeFails = false, blob = 0;
  const decode = vi.fn(async () => { if (decodeFails) throw new Error('Bad JPEG'); });
  vi.stubGlobal('Image', class { src = ''; decode = decode; });
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL() { return `blob:fixture-${++blob}`; }
    static revokeObjectURL() {}
  });
  let deliver!: (packet: IteratorResult<MediaStreamPacket>) => void;
  const iterator = { next: () => new Promise<IteratorResult<MediaStreamPacket>>(resolve => { deliver = resolve; }),
    return: async () => ({ done: true as const, value: undefined }) };
  const media: Pick<PrinterMedia, 'readStream'> = { readStream: () => ({ [Symbol.asyncIterator]: () => iterator }) };
  const descriptor = { ref: { printerId: 'p', routeId: 'r', id: 'm' }, expiresAtMs: null, revision: 1,
    presentation: { kind: 'video', live: true, delivery: { transport: 'jpeg-frames', streamId: 's', mimeType: 'image/jpeg', recoveryWindowMs: 30_000 } } } as MediaDescriptor;
  const video = document.createElement('video'), image = document.createElement('img');
  Object.assign(video, { pause: () => {}, load: () => {}, requestVideoFrameCallback: () => 1, cancelVideoFrameCallback: () => {} });
  const states: PlaybackState[] = [];
  const player = startMediaPlayback({ descriptor, media, video, image, onState: state => states.push(state) });
  let sequence = 0;
  return { player, image, states, setBad: (value: boolean) => { decodeFails = value; },
    feed: async () => {
      deliver({ done: false, value: { kind: 'jpeg', generation: 0, sequence: sequence++, bytes: new Uint8Array([255, 216, 255, 217]) } });
      await vi.advanceTimersByTimeAsync(0);
    } };
}

it('retains the displayed image through an isolated decode failure and resumes playback', async () => {
  const f = jpegPlayer();
  await f.feed(); const first = f.image.src;
  f.setBad(true); await f.feed();
  expect(f.image.src).toBe(first); expect(f.states.at(-1)).toBe('recovering');
  f.setBad(false); await f.feed();
  expect(f.image.src).not.toBe(first); expect(f.states.at(-1)).toBe('playing');
  f.player.stop(); await f.player.done;
});

it('caps continuous decoder recovery at 30 seconds', async () => {
  const f = jpegPlayer(); await f.feed(); f.setBad(true); await f.feed();
  const failed = expect(f.player.done).rejects.toThrow('Camera recovery timed out');
  for (let i = 0; i < 29; i++) { await vi.advanceTimersByTimeAsync(1000); await f.feed(); }
  await vi.advanceTimersByTimeAsync(1000); await failed;
});

it('requires a restored control path even while valid JPEGs continue arriving', async () => {
  const f = jpegPlayer(); await f.feed(); f.player.setConnectionState('connecting');
  const failed = expect(f.player.done).rejects.toThrow('Camera recovery timed out');
  for (let i = 0; i < 29; i++) { await vi.advanceTimersByTimeAsync(1000); await f.feed(); }
  expect(f.states.at(-1)).toBe('recovering');
  await vi.advanceTimersByTimeAsync(1000); await failed;
});

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
