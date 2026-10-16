import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { RecentThumbnailRequest, RecentThumbnailResponse } from '../shared/recentThumbnailWorker';

type ThumbnailWorker = Pick<Worker, 'postMessage' | 'on' | 'terminate' | 'unref'>;

/** Lazy, optional preview service. Its promises never join the recent-operation queue. */
export class RecentThumbnailWorker {
  private worker: ThumbnailWorker | null = null;
  private paths = new Set<string>();
  private nextRequest = 0;
  private disposed = false;
  private pending = new Map<number, { path: string; resolve: (url: string | null) => void }>();
  private requests = new Map<string, Promise<string | null>>();
  constructor(private readonly createWorker: () => ThumbnailWorker = () => new Worker(join(__dirname.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2'), 'recent-thumbnail-worker.js'))) {}

  retain(paths: readonly string[]): void {
    this.paths = new Set(paths);
    for (const [id, request] of this.pending) {
      if (!this.paths.has(request.path)) {
        this.pending.delete(id); this.requests.delete(request.path); request.resolve(null);
      }
    }
    if (this.worker) this.send(this.worker, { type: 'retain', paths });
  }

  read(path: string): Promise<string | null> {
    if (this.disposed || !this.paths.has(path)) return Promise.resolve(null);
    const existing = this.requests.get(path);
    if (existing) return existing;
    const worker = this.ensureWorker();
    if (!worker) return Promise.resolve(null);
    const requestId = ++this.nextRequest;
    const result = new Promise<string | null>(resolve => { this.pending.set(requestId, { path, resolve }); });
    this.requests.set(path, result);
    this.send(worker, { type: 'read', requestId, path });
    return result;
  }

  private ensureWorker(): ThumbnailWorker | null {
    if (this.worker) return this.worker;
    try {
      const worker = this.createWorker(); this.worker = worker;
      worker.on('message', (response: RecentThumbnailResponse) => {
        if (this.worker !== worker) return;
        const pending = this.pending.get(response.requestId);
        if (!pending) return;
        this.pending.delete(response.requestId); this.requests.delete(pending.path);
        pending.resolve(this.paths.has(pending.path) ? response.url : null);
      });
      worker.on('error', () => this.fail(worker));
      worker.on('exit', () => this.fail(worker));
      worker.unref();
      if (!this.send(worker, { type: 'retain', paths: [...this.paths] })) return null;
      return worker;
    } catch {
      if (this.worker) this.fail(this.worker);
      return null;
    }
  }

  private send(worker: ThumbnailWorker, message: RecentThumbnailRequest): boolean {
    try { worker.postMessage(message); return true; }
    catch { this.fail(worker); return false; }
  }

  private fail(worker: ThumbnailWorker): void {
    if (this.worker !== worker) return;
    this.worker = null;
    for (const request of this.pending.values()) request.resolve(null);
    this.pending.clear(); this.requests.clear();
    void worker.terminate().catch(() => undefined);
  }

  dispose(): void {
    this.disposed = true; this.paths.clear();
    if (this.worker) this.fail(this.worker);
  }
}
