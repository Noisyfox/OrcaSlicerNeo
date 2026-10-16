import { stat } from 'node:fs/promises';
import { readProjectThumbnail } from './projectThumbnail';

/** Worker-only cache and queue; one extraction at a time avoids flooding disk/zlib IO. */
export class RecentThumbnailCache {
  private paths = new Set<string>();
  private cache = new Map<string, { signature: string; url: string | null }>();
  private pending = new Map<string, Promise<string | null>>();
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly extract = readProjectThumbnail) {}

  retain(paths: readonly string[]): void {
    this.paths = new Set(paths);
    for (const path of this.cache.keys()) if (!this.paths.has(path)) this.cache.delete(path);
    for (const path of this.pending.keys()) if (!this.paths.has(path)) this.pending.delete(path);
  }

  get(path: string): Promise<string | null> {
    if (!this.paths.has(path)) return Promise.resolve(null);
    const pending = this.pending.get(path);
    if (pending) return pending;
    const current = () => this.paths.has(path) && this.pending.get(path) === task;
    const task: Promise<string | null> = this.tail.then(async () => {
      if (!current()) return null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const file = await stat(path);
        if (!file.isFile() || !current()) return null;
        const signature = `${file.mtimeMs}:${file.ctimeMs}:${file.size}`;
        const previous = this.cache.get(path);
        if (previous?.signature === signature) return previous.url;
        const url = await this.extract(path);
        if (!current()) return null;
        const after = await stat(path);
        // A save/replace during extraction must not publish the old file's image.
        if (`${after.mtimeMs}:${after.ctimeMs}:${after.size}` !== signature) continue;
        this.cache.set(path, { signature, url });
        return url;
      }
      return null;
    }).catch(() => {
      if (current()) this.cache.delete(path);
      return null;
    }).finally(() => {
      if (current()) this.pending.delete(path);
    });
    this.pending.set(path, task);
    this.tail = task.then(() => undefined);
    return task;
  }
}
