import type * as D from '@orca/printer-control/domain';
import type { TransferQueue, TransferTicket } from '@orca/printer-control/transfer-queue';
const stopped = (): D.Result<never> => ({ ok: false, error: { code: 'cancelled', message: 'Video opening stopped.' } });
interface Entry { owner: string; request: D.OpenMediaRequest; result: Promise<D.Result<D.MediaDescriptor>>; resolve(value: D.Result<D.MediaDescriptor>): void; ticket?: TransferTicket; ref?: D.MediaRef; cancelled: boolean }
export interface StoredMediaBinding {
  resolve(file: D.RemoteFileRef): Promise<D.Result<{ physicalPrinterKey: string }>>;
  open(owner: string, request: D.OpenMediaRequest): Promise<D.Result<D.MediaDescriptor>>;
  waitRead(owner: string, ref: D.MediaRef): Promise<D.Result<null>>;
  cancelOpen(owner: string, requestId: D.Id<'request'>): Promise<unknown>;
  close(owner: string, ref: D.MediaRef): Promise<unknown>;
}
/** Common host admission: a completed cache frees the reader slot, not the viewing resource. */
export class StoredMediaQueue {
  private entries = new Map<string, Entry>();
  private cancelled = new Set<string>();
  constructor(private readonly queue: TransferQueue, private readonly binding: StoredMediaBinding) {}
  open(owner: string, request: D.OpenMediaRequest): Promise<D.Result<D.MediaDescriptor>> {
    const key = `${owner}:${request.requestId}`, old = this.entries.get(key);
    if (this.cancelled.has(key)) return Promise.resolve(stopped());
    if (old) return JSON.stringify(old.request) === JSON.stringify(request) ? old.result : Promise.resolve({ ok: false, error: { code: 'invalid-request', message: 'The media request ID was reused.' } });
    if (this.entries.size >= 64) return Promise.resolve({ ok: false, error: { code: 'busy', message: 'Too many stored video requests.' } });
    let resolve!: Entry['resolve']; const result = new Promise<D.Result<D.MediaDescriptor>>(done => { resolve = done; });
    const entry: Entry = { owner, request: structuredClone(request), result, resolve, cancelled: false }; this.entries.set(key, entry);
    void result.then(value => { if (!value.ok && !entry.ticket) this.entries.delete(key); });
    void this.admit(entry).catch(() => resolve({ ok: false, error: { code: 'transport', message: 'The video could not be opened.' } }));
    return result;
  }
  private async admit(entry: Entry) {
    const { request, owner } = entry;
    if (request.source.kind !== 'file-preview') { entry.resolve(stopped()); return; }
    const resolved = await this.binding.resolve(request.source.target);
    if (!resolved.ok) { entry.resolve(resolved); return; }
    if (entry.cancelled) { entry.resolve(stopped()); return; }
    entry.ticket = this.queue.enqueue({ physicalPrinterKey: resolved.value.physicalPrinterKey,
      run: async ({ signal }) => {
        const cancel = () => { void this.binding.cancelOpen(owner, request.requestId).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          if (signal.aborted) { entry.resolve(stopped()); return { status: 'finished' }; }
          const opened = await this.binding.open(owner, request); entry.resolve(opened);
          if (opened.ok) {
            entry.ref = opened.value.ref;
            if (signal.aborted) return { status: 'finished' };
            const read = await this.binding.waitRead(owner, opened.value.ref);
            if (!read.ok && !signal.aborted && ['offline', 'transport', 'authentication-required', 'permission-denied', 'storage-unavailable'].includes(read.error.code)) return { status: 'blocked', reason: read.error };
          }
          return { status: 'finished' };
        } catch {
          const error: D.PrinterError = { code: 'transport', message: 'Video reading was interrupted.' };
          entry.resolve({ ok: false, error }); return entry.ref ? { status: 'blocked', reason: error } : { status: 'finished' };
        } finally {
          signal.removeEventListener('abort', cancel);
          if (signal.aborted) { await this.binding.cancelOpen(owner, request.requestId); if (entry.ref) await this.binding.close(owner, entry.ref); }
        }
      },
    });
    void entry.ticket.finished.then(() => { if (!entry.ref || entry.cancelled) { entry.resolve(stopped()); this.entries.delete(`${owner}:${request.requestId}`); } });
  }
  async cancel(owner: string, requestId: D.Id<'request'>) {
    const key = `${owner}:${requestId}`; this.cancelled.add(key);
    while (this.cancelled.size > 256) this.cancelled.delete(this.cancelled.values().next().value!);
    const entry = this.entries.get(key); if (!entry) return;
    entry.cancelled = true; entry.ticket?.cancel(); entry.resolve(stopped());
    await this.binding.cancelOpen(owner, requestId); await entry.ticket?.finished;
    if (entry.ref) await this.binding.close(owner, entry.ref); this.entries.delete(key);
  }
  async close(owner: string, ref: D.MediaRef) {
    for (const entry of this.entries.values()) if (entry.owner === owner && entry.ref?.id === ref.id) await this.cancel(owner, entry.request.requestId);
  }
  async closeOwner(owner: string) { await Promise.all([...this.entries.values()].filter(e => e.owner === owner).map(e => this.cancel(owner, e.request.requestId))); }
}
