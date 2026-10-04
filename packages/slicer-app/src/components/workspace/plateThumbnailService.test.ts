import { describe, expect, it, vi } from 'vitest';
import { PlateThumbnailService } from './plateThumbnailService';

describe('plate thumbnail ownership', () => {
  it('serializes renders, reuses images and releases replacements/deleted plates', async () => {
    const urls = { createObjectURL: vi.fn(() => `blob:${Math.random()}`), revokeObjectURL: vi.fn() };
    let active = 0;
    const render = vi.fn(async () => { expect(active++).toBe(0); await Promise.resolve(); active--; return new Blob(); });
    const service = new PlateThumbnailService(render, urls as unknown as typeof URL);
    const first = service.request('a', 'one', [], 128);
    expect(service.request('a', 'one', [], 128)).toBe(first);
    await Promise.all([first, service.request('b', 'one', [], 128)]);
    expect(render).toHaveBeenCalledTimes(2);
    const old = await first;
    await service.request('a', 'two', [], 128);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith(old);
    service.retain(['a']);
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2);
    service.dispose();
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(3);
  });
  it('discards stale encodes after replacement or disposal', async () => {
    let finish!: (blob: Blob) => void;
    const render = vi.fn(() => new Promise<Blob>(resolve => { finish = resolve; }));
    const urls = { createObjectURL: vi.fn(() => 'blob:image'), revokeObjectURL: vi.fn() };
    const service = new PlateThumbnailService(render, urls as unknown as typeof URL);
    const pending = service.request('a', 'old', [], 128);
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    service.retain([]);
    finish(new Blob());
    expect(await pending).toBeUndefined();
    expect(urls.createObjectURL).not.toHaveBeenCalled();
    service.dispose();
    expect(await service.request('b', 'new', [], 128)).toBeUndefined();
  });
});
