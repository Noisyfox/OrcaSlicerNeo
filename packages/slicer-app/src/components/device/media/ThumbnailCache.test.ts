import { expect, it, vi } from 'vitest';
import { ThumbnailCache, snapshotThumbnail } from './ThumbnailCache';
const image = (url: string, bytes = 4) => ({ url, bytes, dispose: vi.fn() });
it('coalesces shared reads and aborts only after the last pending consumer leaves', async () => {
  const cache = new ThumbnailCache(); let finish!: (value: ReturnType<typeof image>) => void;
  const load = vi.fn((_signal: AbortSignal) => new Promise<ReturnType<typeof image>>(resolve => { finish = resolve; }));
  const a = cache.acquire('a', load), b = cache.acquire('a', load); await Promise.resolve();
  a.release(); expect(load.mock.calls[0][0].aborted).toBe(false);
  b.release(); expect(load.mock.calls[0][0].aborted).toBe(true);
  const late = image('late'); finish(late); expect(await a.result).toBeNull(); expect(late.dispose).toHaveBeenCalledOnce();
  const replacement = cache.acquire('a', async () => image('new'));
  expect(await replacement.result).toBe('new'); replacement.release(); cache.clear();
});
it('evicts the least recently used inactive image by byte/entry budgets and releases URLs on clear', async () => {
  const cache = new ThumbnailCache(8, 10), images = [image('a'), image('b'), image('c')];
  for (const [i, snapshot] of images.entries()) {
    const entry = cache.acquire(String(i), async () => snapshot); await entry.result; entry.release();
  }
  expect(images[0].dispose).toHaveBeenCalledOnce(); expect(images[1].dispose).not.toHaveBeenCalled();
  const hit = vi.fn(async () => image('unneeded'));
  const b = cache.acquire('1', hit); expect(await b.result).toBe('b'); expect(hit).not.toHaveBeenCalled(); b.release();
  cache.clear(); expect(images[1].dispose).toHaveBeenCalledOnce(); expect(images[2].dispose).toHaveBeenCalledOnce();
});
it('bounds pending entries and zero-byte cached misses as well as image bytes', async () => {
  const cache = new ThumbnailCache(8, 1);
  let finish!: (value: null) => void;
  const pending = cache.acquire('missing', () => new Promise<null>(resolve => { finish = resolve; }));
  await Promise.resolve();
  const blocked = vi.fn(async () => image('blocked'));
  await expect(cache.acquire('other', blocked).result).rejects.toThrow('full');
  expect(blocked).not.toHaveBeenCalled();
  finish(null); await pending.result; pending.release();
  const next = cache.acquire('next', async () => null); await next.result; next.release();
  const reread = vi.fn(async () => null);
  const evicted = cache.acquire('missing', reread); await evicted.result;
  expect(reread).toHaveBeenCalledOnce(); evicted.release(); cache.clear();
});
it('never evicts displayed images and disposes rejected oversized copies', async () => {
  const cache = new ThumbnailCache(4, 2), a = image('a'), b = image('b');
  const pinned = cache.acquire('a', async () => a); await pinned.result;
  const rejected = cache.acquire('b', async () => b); await expect(rejected.result).rejects.toThrow('full');
  expect(a.dispose).not.toHaveBeenCalled(); expect(b.dispose).toHaveBeenCalledOnce();
  rejected.release(); pinned.release(); cache.clear();
});
it('copies expiring URLs into browser-owned blobs and bounds streamed image bytes', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch');
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:local');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  try {
    const signal = new AbortController().signal;
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    const copied = await snapshotThumbnail('https://same-origin/expiring-image', signal);
    expect(copied.url).toBe('blob:local'); expect(copied.bytes).toBe(3); copied.dispose(); expect(revoke).toHaveBeenCalledWith('blob:local');
    fetcher.mockResolvedValueOnce(new Response(new Uint8Array(4 * 1024 * 1024 + 1)));
    await expect(snapshotThumbnail('https://same-origin/oversized', signal)).rejects.toThrow('too large');
    expect(create).toHaveBeenCalledOnce();
    const inline = await snapshotThumbnail('data:image/png;base64,aGVsbG8=', signal);
    expect(inline.url).toContain('data:image/png'); expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); create.mockRestore(); revoke.mockRestore(); }
});
