/** Host-local unfinished sends. UI observation lifetime never owns this registry. */
import type * as D from '@orca/platform-contract';
import type { SendActivityLease } from '@orca/platform-contract';

export class SendActivity {
  private entries = new Set<{ controller: AbortController; cancel?: () => void | Promise<unknown> }>();
  get active() { return this.entries.size > 0; }
  begin(cancel?: () => void | Promise<unknown>): SendActivityLease {
    const entry = { controller: new AbortController(), cancel }; this.entries.add(entry);
    return { signal: entry.controller.signal,
      setCancellation: next => { entry.cancel = next; if (entry.controller.signal.aborted) void Promise.resolve().then(next).catch(() => undefined); },
      finish: () => { this.entries.delete(entry); },
    };
  }
  /** Requests local cancellation only. Already dispatched print start cannot be recalled. */
  async stop(): Promise<void> {
    const entries = [...this.entries];
    for (const entry of entries) entry.controller.abort();
    await Promise.allSettled(entries.map(entry => Promise.resolve().then(() => entry.cancel?.())));
  }
}
const registries = new WeakMap<D.PrinterService, SendActivity>();
export function sendActivity(service: D.PrinterService): SendActivity {
  let activity = registries.get(service);
  if (!activity) { activity = new SendActivity(); registries.set(service, activity); }
  return activity;
}
/** Wrap every provider at the shared service boundary, including remote-file start and retries. */
export function trackPrinterSends(service: D.PrinterService): D.PrinterService {
  const activity = new SendActivity();
  async function trackOperation(lease: SendActivityLease, result: D.Submission, upload: boolean) {
    if (result.kind === 'rejected') { lease.finish(); return; }
    try {
      let ref = result.kind === 'recorded' ? result.operation : undefined;
      if (!ref && result.kind === 'outcome-unknown') {
        const found = await service.operations.find(result.lookup);
        if (found.ok && found.value.kind === 'found') ref = found.value.operation.ref;
      }
      if (!ref) { lease.finish(); return; }
      const operation = ref;
      if (upload) lease.setCancellation(() => service.operations.requestUploadCancellation(operation));
      for await (const value of service.operations.watch(operation)) {
        if (['completed', 'failed', 'cancelled', 'outcome-unknown', 'submitted', 'accepted'].includes(value.phase.kind)) { lease.finish(); return; }
      }
      lease.finish();
    } catch { /* Keep an unresolved send protected until explicit exit or later provider resolution. */ }
  }
  const wrapped: D.PrinterService = { ...service,
    files: { ...service.files, upload: async (request, source) => {
      const lease = activity.begin();
      try { const result = await service.files.upload(request, source); void trackOperation(lease, result, true).catch(() => undefined); return result; }
      catch (error) { lease.finish(); throw error; }
    } },
    controls: { ...service.controls, submit: async request => {
      if (request.command.type !== 'jobs.start') return service.controls.submit(request);
      const lease = activity.begin();
      try { const result = await service.controls.submit(request); void trackOperation(lease, result, false).catch(() => undefined); return result; }
      catch (error) { lease.finish(); throw error; }
    } },
    submissions: { ...service.submissions, submit: async (request, artifacts) => {
      const lease = activity.begin();
      try {
        const result = await service.submissions.submit(request, artifacts);
        if (!result.ok) { lease.finish(); return result; }
        lease.setCancellation(() => service.submissions.cancel(result.value));
        void (async () => {
          try {
            for await (const state of service.submissions.watch(result.value)) if (['sent', 'failed', 'cancelled', 'unknown'].includes(state.phase)) { lease.finish(); return; }
          } catch { /* Observation loss is not proof of send completion. */ }
        })().catch(() => undefined);
        return result;
      } catch (error) { lease.finish(); throw error; }
    } },
  };
  registries.set(wrapped, activity); return wrapped;
}
