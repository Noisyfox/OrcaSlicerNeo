import type { BambuStorageResourceReader, BambuStorageResourceRequest } from '@orca/bambu-native';
import { StorageHostError } from './storageFiles';
interface Entry { reader: Promise<BambuStorageResourceReader>; controller: AbortController; busy: boolean; closing?: Promise<void>; timer?: ReturnType<typeof setTimeout> }
/** Reuse sequential SUB_FILE batches, with at most two connections and a two-second idle lease. */
export class StorageResourceConnections {
  private entries = new Map<string, Entry>();
  private closed = false;
  private release(key: string, entry: Entry): Promise<void> {
    if (!entry.closing) entry.closing = (async () => {
      if (entry.timer) clearTimeout(entry.timer); entry.controller.abort();
      try { await (await entry.reader).close(); } catch { /* Opening/reading owns the error. */ }
      finally { if (this.entries.get(key) === entry) this.entries.delete(key); }
    })();
    return entry.closing;
  }
  async read(key: string, requests: readonly BambuStorageResourceRequest[], open: (signal: AbortSignal) => Promise<BambuStorageResourceReader>, signal: AbortSignal) {
    const check = () => { if (this.closed || signal.aborted) throw new StorageHostError({ code: 'cancelled', message: 'Thumbnail reading stopped.' }); };
    check();
    let entry = this.entries.get(key);
    if (entry?.closing) { await this.release(key, entry); entry = undefined; }
    if (!entry) {
      while (this.entries.size >= 2) {
        const idle = [...this.entries].find(([, value]) => !value.busy);
        if (!idle) throw new StorageHostError({ code: 'busy', message: 'Wait for other thumbnails to finish.' });
        await this.release(...idle);
      }
      check();
      const controller = new AbortController(); entry = { controller, busy: false, reader: open(controller.signal) }; this.entries.set(key, entry);
    }
    if (entry.busy) throw new Error('A thumbnail connection is already in use.');
    entry.busy = true; if (entry.timer) clearTimeout(entry.timer);
    const current = entry;
    const abort = () => { current.controller.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const reader = await current.reader; check();
      const data = await reader.read(requests); check();
      if (current.controller.signal.aborted) throw new StorageHostError({ code: 'cancelled', message: 'Thumbnail reading stopped.' });
      return data;
    }
    catch (error) { await this.release(key, current); throw error; }
    finally {
      signal.removeEventListener('abort', abort); current.busy = false;
      if (this.entries.get(key) === current) current.timer = setTimeout(() => { void this.release(key, current); }, 2000);
    }
  }
  async reconcile(valid: (key: string) => Promise<boolean>) {
    for (const [key, entry] of this.entries) if (!await valid(key)) await this.release(key, entry);
  }
  async close() { this.closed = true; await Promise.all([...this.entries].map(([key, entry]) => this.release(key, entry))); }
}
