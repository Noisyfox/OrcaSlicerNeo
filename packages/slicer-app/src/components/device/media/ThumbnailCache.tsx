import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

interface Snapshot { url: string; bytes: number; dispose(): void }
interface Entry {
  controller: AbortController;
  users: number;
  settled: boolean;
  snapshot?: Snapshot | null;
  result: Promise<string | null>;
}

/** Browser-owned immutable images, independent of provider media leases. */
export class ThumbnailCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  constructor(private maxBytes = 32 * 1024 * 1024, private maxEntries = 256) {}

  acquire(key: string, load: (signal: AbortSignal) => Promise<Snapshot | null>) {
    let entry = this.entries.get(key);
    if (!entry) {
      const created: Entry = { controller: new AbortController(), users: 0, settled: false, result: Promise.resolve(null) };
      entry = created;
      this.entries.set(key, entry);
      created.result = Promise.resolve().then(() => load(created.controller.signal)).then(snapshot => {
        if (this.entries.get(key) !== created || created.controller.signal.aborted) {
          snapshot?.dispose(); return null;
        }
        created.snapshot = snapshot; created.settled = true;
        this.bytes += snapshot?.bytes ?? 0;
        this.trim();
        return snapshot?.url ?? null;
      }).catch(error => {
        if (this.entries.get(key) === created) this.remove(key, created);
        throw error;
      });
    }
    entry.users++;
    // Map order is the least-recently-used order, including cached misses.
    this.entries.delete(key); this.entries.set(key, entry);
    this.trim();
    const owned = entry; let released = false;
    return { result: entry.result, release: () => {
      if (released) return; released = true; owned.users--;
      if (!owned.users && !owned.settled && this.entries.get(key) === owned) this.remove(key, owned);
      this.trim();
    } };
  }

  clear() { for (const [key, entry] of this.entries) this.remove(key, entry); }
  private trim() {
    // Retention targets never reject an image or revoke one still being displayed.
    // Pinned/pending entries may exceed them; release makes them eligible again.
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const victim = [...this.entries].find(([, entry]) => entry.settled && entry.users === 0);
      if (!victim) break;
      this.remove(...victim);
    }
  }
  private remove(key: string, entry: Entry) {
    this.entries.delete(key); entry.controller.abort();
    this.bytes -= entry.snapshot?.bytes ?? 0; entry.snapshot?.dispose();
  }
}

/** Copy expiring delivery URLs before closing their media lease. Never persist them. */
export async function snapshotThumbnail(url: string, signal: AbortSignal): Promise<Snapshot> {
  // Immutable inline images need no fetch (and no host-specific CSP exceptions).
  if (/^data:image\/(?:png|jpeg);base64,[a-z\d+/=\s]+$/i.test(url)) {
    // Account conservatively for UTF-16 backing storage of the retained data URL.
    return { url, bytes: url.length * 2, dispose() {} };
  }
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error('Thumbnail could not be read');
  const reader = response.body.getReader(), chunks: Uint8Array<ArrayBuffer>[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      chunks.push(new Uint8Array(chunk.value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const objectUrl = URL.createObjectURL(new Blob(chunks, { type: response.headers.get('content-type') ?? 'application/octet-stream' }));
  return { url: objectUrl, bytes, dispose: () => URL.revokeObjectURL(objectUrl) };
}

const Context = createContext<ThumbnailCache | null>(null);
export function ThumbnailCacheScope({ scope, children }: { scope: string; children: ReactNode }) {
  const cache = useMemo(() => new ThumbnailCache(), [scope]);
  useEffect(() => () => cache.clear(), [cache]);
  return <Context.Provider value={cache}>{children}</Context.Provider>;
}
export function useThumbnailCache() {
  const shared = useContext(Context);
  const local = useMemo(() => new ThumbnailCache(), []);
  useEffect(() => () => local.clear(), [local]);
  return shared ?? local;
}
