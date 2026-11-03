import type { BambuStorageResourceRequest } from '@orca/bambu-native';
import { StorageHostError } from './storageFiles';
type Read = (requests: readonly BambuStorageResourceRequest[], signal: AbortSignal) => Promise<readonly (Uint8Array | null)[]>;
interface Job { key: string; request: BambuStorageResourceRequest; signal?: AbortSignal; read: Read;
  resolve(value: Uint8Array | null): void; reject(error: unknown): void; abort(): void; active: boolean }
const cancelled = () => new StorageHostError({ code: 'cancelled', message: 'Thumbnail reading stopped.' });
/** Coalesce viewport reads per authorized route/configuration; bound batches and native readers. */
export class StorageResourceQueue {
  private pending: Job[] = [];
  private running = new Map<string, { controller: AbortController; jobs: Job[]; done: Promise<void> }>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  read(key: string, request: BambuStorageResourceRequest, read: Read, signal?: AbortSignal): Promise<Uint8Array | null> {
    if (this.closed || signal?.aborted) return Promise.reject(cancelled());
    if (this.pending.length >= 64) return Promise.reject(new StorageHostError({ code: 'busy', message: 'Wait for other thumbnails to finish.' }));
    return new Promise((resolve, reject) => {
      const job: Job = { key, request, read, signal, resolve, reject, active: false, abort: () => {
        if (!job.active) { this.pending = this.pending.filter(item => item !== job); signal?.removeEventListener('abort', job.abort); reject(cancelled()); }
        else { const batch = this.running.get(key); if (batch?.jobs.every(item => item.signal?.aborted)) batch.controller.abort(); }
      } };
      signal?.addEventListener('abort', job.abort, { once: true }); this.pending.push(job); this.schedule();
    });
  }
  private schedule() {
    if (!this.closed && !this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 8);
  }
  private flush() {
    if (this.closed) return;
    for (const key of new Set(this.pending.map(job => job.key))) {
      if (this.running.size >= 2) break;
      if (this.running.has(key)) continue;
      const jobs = this.pending.filter(job => job.key === key).slice(0, 8);
      this.pending = this.pending.filter(job => !jobs.includes(job)); jobs.forEach(job => { job.active = true; });
      const controller = new AbortController();
      const batch = { controller, jobs, done: Promise.resolve() };
      this.running.set(key, batch);
      batch.done = (async () => {
        try {
          const unique = new Map<string, BambuStorageResourceRequest>();
          const address = (request: BambuStorageResourceRequest) => JSON.stringify([request.path, request.resource]);
          for (const job of jobs) { const previous = unique.get(address(job.request));
            unique.set(address(job.request), { ...job.request, maxBytes: Math.max(job.request.maxBytes, previous?.maxBytes ?? 0) }); }
          const requests = [...unique.values()], data = await jobs[0].read(requests, controller.signal);
          if (data.length !== requests.length) throw new Error('Invalid thumbnail batch.');
          for (const job of jobs) {
            const value = data[requests.findIndex(request => address(request) === address(job.request))];
            if (this.closed || controller.signal.aborted || job.signal?.aborted) job.reject(cancelled());
            else if (value && value.byteLength > job.request.maxBytes) job.reject(new Error('The thumbnail exceeds its resource limit.'));
            else job.resolve(value ? new Uint8Array(value) : null);
          }
        } catch (error) { for (const job of jobs) job.reject(this.closed || controller.signal.aborted || job.signal?.aborted ? cancelled() : error); }
        finally { jobs.forEach(job => job.signal?.removeEventListener('abort', job.abort)); this.running.delete(key); this.schedule(); }
      })();
    }
  }
  async close() {
    this.closed = true; if (this.timer) clearTimeout(this.timer);
    for (const job of this.pending) { job.signal?.removeEventListener('abort', job.abort); job.reject(cancelled()); } this.pending = [];
    for (const batch of this.running.values()) batch.controller.abort();
    await Promise.all([...this.running.values()].map(batch => batch.done));
  }
}
