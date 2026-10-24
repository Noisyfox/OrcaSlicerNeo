import { lock } from 'proper-lockfile';
/** Short local transactions only. All instances share the same stale/update policy. */
export async function withFileLock<T>(path: string, work: () => Promise<T>): Promise<T> {
  const release = await lock(path, { realpath: false, stale: 30_000, update: 10_000,
    retries: { retries: 100, minTimeout: 50, maxTimeout: 50, factor: 1, randomize: false } });
  try { return await work(); } finally { await release(); }
}
