import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';

type AcceptedSubmission = Exclude<D.Submission, { kind: 'rejected' }>;
const remembered = new WeakMap<D.PrinterService, Map<string, AcceptedSubmission>>();
const unknownOutcome = 'Command outcome unknown. Check the printer before trying again.';

/** UI readers may leave a device; the provider retains the original physical operation. */
export function usePrinterCommands(service: D.PrinterService, target: D.TargetRequest, capabilityRevision: string) {
  const [feedback, setFeedback] = useState<string | null>(null), [pending, setPending] = useState(false);
  const busy = useRef(false), controller = useRef<AbortController | null>(null);
  const key = JSON.stringify([target.printerId, target.routeId, target.expectedConfigurationRevision]);
  const current = useRef({ key, service }), alive = useRef(false); current.current = { key, service };
  let saved = remembered.get(service);
  if (!saved) { saved = new Map(); remembered.set(service, saved); }
  const records = saved;
  const active = (abort: AbortController) => alive.current && !abort.signal.aborted && current.current.key === key && current.current.service === service;
  async function track(result: AcceptedSubmission, abort: AbortController) {
    try {
      let ref = result.kind === 'recorded' ? result.operation : null;
      if (!ref && result.kind === 'outcome-unknown') {
        const found = await service.operations.find(result.lookup, { signal: abort.signal });
        if (!active(abort)) return;
        if (found.ok && found.value.kind === 'found') ref = found.value.operation.ref;
      }
      if (!ref) { if (active(abort)) setFeedback(unknownOutcome); return; }
      for await (const operation of service.operations.watch(ref, { signal: abort.signal })) {
        if (!active(abort)) return;
        if (operation.phase.kind === 'accepted' || operation.phase.kind === 'completed') { setFeedback(null); return; }
        if (operation.phase.kind === 'failed') { setFeedback(operation.phase.error.message); return; }
        if (operation.phase.kind === 'outcome-unknown') { setFeedback(operation.phase.reason); return; }
      }
      if (active(abort)) setFeedback(unknownOutcome);
    } catch { if (active(abort)) setFeedback(unknownOutcome); }
    finally { if (active(abort)) { busy.current = false; setPending(false); } }
  }
  function acceptSubmission(result: AcceptedSubmission) {
    // Remember even if selection changed during IPC; only the original Monitor may observe it.
    records.set(key, result);
    if (!alive.current || current.current.key !== key || current.current.service !== service) return;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    busy.current = true; setPending(true); setFeedback(null);
    void track(result, abort);
  }
  useEffect(() => {
    alive.current = true; controller.current?.abort(); busy.current = false; setPending(false); setFeedback(null);
    const result = records.get(key);
    if (result) acceptSubmission(result);
    return () => { alive.current = false; controller.current?.abort(); };
  }, [service, key]);
  async function send(command: D.PrinterCommand, expectedTaskId?: D.Id<'device-task'>) {
    if (busy.current) return;
    busy.current = true; setPending(true); setFeedback(null);
    const abort = new AbortController(); controller.current = abort;
    let handedOff = false;
    try {
      const assessment = await service.controls.evaluate({ printerId: target.printerId, routeId: target.routeId }, command, { signal: abort.signal });
      if (!active(abort)) return;
      if (!assessment.ok) { setFeedback(assessment.error.message); return; }
      if (assessment.value.availability.kind !== 'available') {
        setFeedback(assessment.value.availability.kind === 'blocked' ? assessment.value.availability.reasons.map(reason => reason.message).join(' ') : assessment.value.availability.reason); return;
      }
      const request = { target, requestId: crypto.randomUUID() as D.Id<'request'>, command,
        guard: { capabilityRevision, ...(expectedTaskId ? { expectedTaskId } : {}) } } as D.CommandRequest;
      const result = await service.controls.submit(request);
      if (result.kind !== 'rejected') { acceptSubmission(result); handedOff = true; }
      else if (active(abort)) setFeedback(result.error.message);
    } catch { if (active(abort)) setFeedback(unknownOutcome); }
    finally { if (!handedOff && active(abort)) { busy.current = false; setPending(false); } }
  }
  return { send, acceptSubmission, pending, feedback, setFeedback };
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
