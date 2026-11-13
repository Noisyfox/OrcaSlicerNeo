import { it, expect, vi } from 'vitest';
import type * as D from '@orca/platform-contract';
import { SendActivity, sendActivity, trackPrinterSends } from './send-activity';
it('protects artifact preparation and cancels late-admitted work without replaying it', async () => {
  const activity = new SendActivity(), cancel = vi.fn(), lease = activity.begin();
  expect(activity.active).toBe(true); await activity.stop(); expect(lease.signal.aborted).toBe(true);
  lease.setCancellation(cancel); await Promise.resolve(); expect(cancel).toHaveBeenCalledOnce();
  lease.finish(); expect(activity.active).toBe(false);
  const next = activity.begin(); expect(next.signal.aborted).toBe(false); next.finish();
});
it('retains a prepared send independently of its UI and issues only submission cancellation on exit', async () => {
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; }), cancel = vi.fn(async () => { finish(); return { ok: true }; });
  const ref = { id: 'send', printerId: 'p', routeId: 'r', configurationRevision: 'v' };
  const base = { files: {}, controls: {}, submissions: { submit: async () => ({ ok: true, value: ref }), cancel,
    watch: async function* () { yield { phase: 'sending' }; await pending; yield { phase: 'cancelled' }; } } } as unknown as D.PrinterService;
  const service = trackPrinterSends(base);
  await service.submissions.submit({} as D.PrintSubmissionRequest, []);
  expect(sendActivity(service).active).toBe(true);
  await sendActivity(service).stop(); await vi.waitFor(() => expect(sendActivity(service).active).toBe(false));
  expect(cancel).toHaveBeenCalledExactlyOnceWith(ref);
});
it('tracks upload and device-file start separately and retains unresolved observations', async () => {
  const cancel = vi.fn(async () => ({ ok: true }));
  const base = { submissions: {}, files: { upload: async () => ({ kind: 'recorded', operation: { id: 'upload' } }) },
    controls: { submit: async () => ({ kind: 'recorded', operation: { id: 'start' } }) },
    operations: { requestUploadCancellation: cancel, watch: async function* () { throw new Error('lost observer'); yield; } } } as unknown as D.PrinterService;
  const service = trackPrinterSends(base);
  await service.files.upload({} as Parameters<D.PrinterFiles['upload']>[0], {} as Parameters<D.PrinterFiles['upload']>[1]);
  await service.controls.submit({ command: { type: 'jobs.start' } } as D.CommandRequest);
  await Promise.resolve(); expect(sendActivity(service).active).toBe(true);
  await sendActivity(service).stop(); expect(cancel).toHaveBeenCalledOnce();
});
