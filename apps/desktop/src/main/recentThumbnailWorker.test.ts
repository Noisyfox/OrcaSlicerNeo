import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Worker } from 'node:worker_threads';
import { RecentThumbnailWorker } from './recentThumbnailWorker';
import { RecentProjectsRepository } from './recentProjects';

function fixture() {
  const workers: Array<EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }> = [];
  const create = vi.fn(() => {
    const worker = Object.assign(new EventEmitter(), { postMessage: vi.fn(), terminate: vi.fn(async () => 0), unref: vi.fn() });
    workers.push(worker); return worker as unknown as Worker;
  });
  const service = new RecentThumbnailWorker(create);
  return { workers, create, service };
}

describe('independent recent thumbnail Worker lifecycle', () => {
  it('is lazy and deduplicates in-flight requests without entering the recent operation queue', async () => {
    const { service, create, workers } = fixture();
    const repo = new RecentProjectsRepository(null, paths => service.retain(paths));
    service.retain(['/held.3mf']); expect(create).not.toHaveBeenCalled();
    const held = service.read('/held.3mf'); expect(service.read('/held.3mf')).toBe(held);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith({ type: 'read', requestId: 1, path: '/held.3mf' });
    // These operations finish with no Worker reply; clear also discards its pending preview.
    expect(await repo.list()).toEqual([]);
    await repo.clear(); expect(await held).toBeNull();
    service.dispose(); expect(workers[0].terminate).toHaveBeenCalledOnce();
  });
  it('drops removed responses and permits a fresh request after re-adding a path', async () => {
    const { service, workers } = fixture();
    service.retain(['/a.3mf']); const stale = service.read('/a.3mf');
    service.retain([]); expect(await stale).toBeNull();
    service.retain(['/a.3mf']); const fresh = service.read('/a.3mf');
    workers[0].emit('message', { requestId: 1, url: 'old' });
    workers[0].emit('message', { requestId: 2, url: 'fresh' });
    expect(await fresh).toBe('fresh'); service.dispose();
  });
  it('settles failures as missing previews, restarts lazily, and terminates on disposal', async () => {
    const { service, workers } = fixture();
    service.retain(['/a.3mf']); const crashed = service.read('/a.3mf');
    workers[0].emit('error', new Error('worker crash')); expect(await crashed).toBeNull();
    const retried = service.read('/a.3mf'); expect(workers).toHaveLength(2);
    workers[0].emit('exit', 1);
    workers[1].emit('message', { requestId: 2, url: 'retry' });
    expect(await retried).toBe('retry');
    const disposed = service.read('/a.3mf'); service.dispose(); expect(await disposed).toBeNull();
    expect(await service.read('/a.3mf')).toBeNull(); expect(workers).toHaveLength(2);
  });
  it('contains startup/postMessage/normal exit failures without rejecting callers', async () => {
    const badStartup = new RecentThumbnailWorker(() => { throw new Error('unavailable'); });
    badStartup.retain(['/a']); expect(await badStartup.read('/a')).toBeNull(); badStartup.dispose();
    const { service, workers } = fixture(); service.retain(['/a']); const waiting = service.read('/a');
    workers[0].emit('exit', 0); expect(await waiting).toBeNull();
    const failedPost = service.read('/a'); workers[1].postMessage.mockImplementation(() => { throw new Error('closed'); });
    service.retain(['/a']); expect(await failedPost).toBeNull(); service.dispose();
  });
});

it('a held thumbnail does not delay recent resolution, project read/save/record, removal or clear', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'neo-held-thumbnail-'));
  const { service } = fixture();
  try {
    const source = join(dir, 'source.3mf'), saved = join(dir, 'saved.3mf');
    await writeFile(source, 'project');
    const repo = new RecentProjectsRepository(join(dir, 'config.json'), paths => service.retain(paths));
    await repo.record(source); const [entry] = await repo.list();
    const held = service.read(await repo.resolve(entry.id));
    expect(await readFile(await repo.resolve(entry.id), 'utf8')).toBe('project');
    await writeFile(saved, 'saved project'); await repo.record(saved);
    expect((await repo.list()).map(entry => entry.displayName)).toEqual(['saved.3mf', 'source.3mf']);
    await repo.remove(entry.id); expect(await held).toBeNull();
    await repo.clear(); expect(await repo.list()).toEqual([]);
  } finally { service.dispose(); await rm(dir, { recursive: true, force: true }); }
});
