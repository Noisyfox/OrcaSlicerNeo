import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';

/** Command observation is independent of printer observation and never retries a mutation. */
export function usePrinterCommands(service: D.PrinterService, target: D.TargetRequest, capabilityRevision: string) {
  const [feedback, setFeedback] = useState<string | null>(null), [pending, setPending] = useState(false);
  const busy = useRef(false), controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function send(command: D.PrinterCommand, expectedTaskId?: D.Id<'device-task'>) {
    if (busy.current) return;
    busy.current = true; setPending(true); setFeedback(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const assessment = await service.controls.evaluate({ printerId: target.printerId, routeId: target.routeId }, command, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!assessment.ok) { setFeedback(assessment.error.message); return; }
      if (assessment.value.availability.kind !== 'available') {
        setFeedback(assessment.value.availability.kind === 'blocked' ? assessment.value.availability.reasons.map(reason => reason.message).join(' ') : assessment.value.availability.reason); return;
      }
      const request = { target, requestId: crypto.randomUUID() as D.Id<'request'>, command,
        guard: { capabilityRevision, ...(expectedTaskId ? { expectedTaskId } : {}) } } as D.CommandRequest;
      const result = await service.controls.submit(request);
      if (abort.signal.aborted) return;
      if (result.kind === 'rejected') { setFeedback(result.error.message); return; }
      if (result.kind === 'outcome-unknown') { setFeedback('Command outcome unknown. Check the printer before trying again.'); return; }
      setFeedback('Command sent. Waiting for the printer.');
      for await (const operation of service.operations.watch(result.operation, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        if (operation.phase.kind === 'accepted') { setFeedback('Printer accepted the command.'); return; }
        if (operation.phase.kind === 'completed') { setFeedback('Command completed.'); return; }
        if (operation.phase.kind === 'failed') { setFeedback(operation.phase.error.message); return; }
        if (operation.phase.kind === 'acknowledged') setFeedback('Printer acknowledged the command. Waiting for completion.');
        if (operation.phase.kind === 'outcome-unknown') { setFeedback(operation.phase.reason); return; }
      }
      if (!abort.signal.aborted) setFeedback('Command outcome unknown. Check the printer before trying again.');
    } catch { if (!abort.signal.aborted) setFeedback('Command outcome unknown. Check the printer before trying again.'); }
    finally { busy.current = false; if (!abort.signal.aborted) setPending(false); }
  }
  return { send, pending, feedback, setFeedback };
}

export function useCurrentPrintPreview(service: D.PrinterService, target: D.TargetRequest, taskId: D.Id<'device-task'> | null | undefined, enabled: boolean) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    setPreview(null);
    if (!enabled || !taskId) return;
    const abort = new AbortController(); let url: string | null = null;
    void service.media.readCurrentPrintPreview(target, { signal: abort.signal }).then(result => {
      if (!abort.signal.aborted && result.ok && result.value.taskId === taskId) {
        url = URL.createObjectURL(new Blob([new Uint8Array(result.value.bytes)], { type: result.value.mimeType })); setPreview(url);
      }
    }).catch(() => {});
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [service, target.printerId, target.routeId, target.expectedConfigurationRevision, taskId, enabled]);
  return preview;
}
