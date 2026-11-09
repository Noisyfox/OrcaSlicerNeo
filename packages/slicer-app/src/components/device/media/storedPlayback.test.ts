import { afterEach, expect, it, vi } from 'vitest';
import type { MediaDescriptor, PrinterMedia } from '@orca/printer-control/domain';
import { startStoredPlayback } from './storedPlayback';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture(initialization = false) {
  vi.useFakeTimers();
  class Buffer extends EventTarget {
    buffered = { length: 0 };
    appendBuffer() { queueMicrotask(() => this.dispatchEvent(new Event('updateend'))); }
  }
  class Source extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('sourceopen'))); }
    addSourceBuffer() { return new Buffer(); }
  }
  vi.stubGlobal('MediaSource', Source);
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:stored-test');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const signals: AbortSignal[] = [], released = vi.fn();
  const media: Pick<PrinterMedia, 'readStream'> = { readStream: async function* (_request, options) {
    const signal = options!.signal!; signals.push(signal);
    try {
      if (initialization) yield { kind: 'init', generation: 0, sequence: 0, bytes: new Uint8Array([1]), mimeType: 'video/mp4' };
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    } finally { released(); }
  } };
  const video = Object.assign(new EventTarget(), { pause: vi.fn(), removeAttribute: vi.fn(), load: vi.fn(), duration: 0 });
  const descriptor = { acceptsUserActivity: false, ref: { id: 'storage-video:test' }, presentation: {
    kind: 'video', delivery: { transport: 'mse-fmp4', mimeType: 'video/mp4', streamId: 'stream' },
    durationSeconds: 10, cachedRanges: [{ startSeconds: 0, endSeconds: 10 }],
  } } as unknown as MediaDescriptor;
  const onError = vi.fn();
  const player = startStoredPlayback(descriptor, media, video as unknown as HTMLVideoElement, onError);
  return { player, onError, signals, released, video, create, revoke };
}
it.each([false, true])('cancels a stalled read and reports timeout after cleanup (initialized: %s)', async initialized => {
  const f = fixture(initialized);
  try {
    await vi.advanceTimersByTimeAsync(36_000);
    expect(f.signals[0].aborted).toBe(true);
    expect(f.released).toHaveBeenCalledOnce();
    expect(f.video.load).toHaveBeenCalledOnce();
    expect(f.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('timed out'));
    if (initialized) expect(f.revoke).toHaveBeenCalledExactlyOnceWith('blob:stored-test');
    else expect(f.create).not.toHaveBeenCalled();
  } finally { await f.player.stop(); f.create.mockRestore(); f.revoke.mockRestore(); }
});
it('stops or replaces a stalled stream without reporting a playback failure', async () => {
  const f = fixture();
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(f.player.seek(1)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.signals).toHaveLength(2);
    expect(f.signals[0].aborted).toBe(true); expect(f.signals[1].aborted).toBe(false);
    expect(f.released).toHaveBeenCalledOnce();
    await f.player.stop();
    expect(f.released).toHaveBeenCalledTimes(2);
    expect(f.signals[1].aborted).toBe(true); expect(f.onError).not.toHaveBeenCalled();
  } finally { await f.player.stop(); f.create.mockRestore(); f.revoke.mockRestore(); }
});
