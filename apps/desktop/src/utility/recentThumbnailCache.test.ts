import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecentThumbnailCache } from './recentThumbnailCache';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'neo-thumbnail-cache-')); directories.push(dir);
  const path = join(dir, 'project.3mf'); await writeFile(path, 'project');
  const extract = vi.fn<() => Promise<string | null>>(async () => 'data:image/png;base64,first');
  const cache = new RecentThumbnailCache(extract); cache.retain([path]);
  return { path, extract, cache };
}

describe('Worker-owned recent thumbnail cache', () => {
  it('deduplicates, invalidates on file changes/disappearance, and releases removed entries', async () => {
    const { path, cache, extract } = await fixture();
    expect(await Promise.all([cache.get(path), cache.get(path)])).toEqual(['data:image/png;base64,first', 'data:image/png;base64,first']);
    await cache.get(path); expect(extract).toHaveBeenCalledTimes(1);
    extract.mockResolvedValue('data:image/png;base64,second');
    await utimes(path, new Date(), new Date(Date.now() + 10_000));
    expect(await cache.get(path)).toBe('data:image/png;base64,second');
    expect(extract).toHaveBeenCalledTimes(2);
    await unlink(path); expect(await cache.get(path)).toBeNull();
    await writeFile(path, 'project'); await cache.get(path); expect(extract).toHaveBeenCalledTimes(3);
    cache.retain([]); expect(await cache.get(path)).toBeNull();
    cache.retain([path]); await cache.get(path); expect(extract).toHaveBeenCalledTimes(4);
  });
  it('caches absent previews and recovers from extraction failure', async () => {
    const { path, cache, extract } = await fixture();
    extract.mockRejectedValueOnce(new Error('bad preview')).mockResolvedValue(null);
    expect(await cache.get(path)).toBeNull();
    expect(await cache.get(path)).toBeNull();
    expect(await cache.get(path)).toBeNull();
    expect(extract).toHaveBeenCalledTimes(2);
  });
  it('rechecks the file after extraction so an overlapping save cannot publish an old image', async () => {
    const { path, cache, extract } = await fixture();
    let release!: (url: string) => void;
    extract.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = cache.get(path);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    await writeFile(path, 'a different saved project');
    release('data:image/png;base64,old');
    expect(await pending).toBe('data:image/png;base64,first');
    expect(extract).toHaveBeenCalledTimes(2);
    expect(await cache.get(path)).toBe('data:image/png;base64,first');
    expect(extract).toHaveBeenCalledTimes(2);
  });
  it('discards an in-flight result when removed and re-added before extraction finishes', async () => {
    const { path, cache, extract } = await fixture();
    let release!: (url: string) => void;
    extract.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stale = cache.get(path);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledOnce());
    cache.retain([]); cache.retain([path]);
    const fresh = cache.get(path);
    release('data:image/png;base64,stale');
    expect(await stale).toBeNull();
    expect(await fresh).toBe('data:image/png;base64,first');
    expect(extract).toHaveBeenCalledTimes(2);
  });
});
