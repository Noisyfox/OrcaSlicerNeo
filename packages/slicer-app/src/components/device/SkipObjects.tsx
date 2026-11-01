import { useEffect, useRef, useState } from 'react';
import { SkipForward } from 'lucide-react';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from '@/components/ui/dialog';

const known = <T,>(reading?: D.Reading<T>) => reading?.kind === 'known' ? reading.value : undefined;
const reason = (availability: D.Availability) => availability.kind === 'blocked' ? availability.reasons.map(r => r.message).join(' ') : availability.kind === 'unknown' ? availability.reason : null;
const referenceKey = (ref: D.PrintObjectContextRef) => JSON.stringify(ref);

/** A modal current-task workflow; operation tracking never locks subsequent batches. */
export function SkipObjects({ service, target, printerName, capability, capabilityRevision, phase, taskId, fresh, observed, onFeedback }: {
  service: D.PrinterService; target: D.TargetRequest; printerName: string;
  capability: D.CommandCapabilities['jobs.skipObjects']; capabilityRevision: string;
  phase: D.PrintPhase | undefined; taskId: D.Id<'device-task'> | null | undefined; fresh: boolean;
  observed?: D.Reading<D.PrintObjectSnapshot>; onFeedback: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState<D.PrintObjectSnapshot | null>(null);
  const [selected, setSelected] = useState<D.Id<'print-object'>[]>([]), [confirmation, setConfirmation] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [submitting, setSubmitting] = useState(false), [message, setMessage] = useState<string | null>(null);
  const [map, setMap] = useState<D.PrintObjectMap | null>(null), [mapFailed, setMapFailed] = useState(false);
  const reader = useRef<AbortController | null>(null), operationReaders = useRef(new Set<AbortController>()), sending = useRef(false), alive = useRef(true);
  const currentObserved = known(observed);
  const reportedSkippedCount = known(currentObserved?.skippedObjectIds)?.length ?? 0;
  const snapshot = loaded && currentObserved && referenceKey(currentObserved.contextRef) === referenceKey(loaded.contextRef) ? currentObserved : loaded;
  const skipped = known(snapshot?.skippedObjectIds) ?? [];
  const skippedKey = JSON.stringify(skipped.slice().sort());
  const unavailable = !fresh ? 'Wait for fresh printer status.' : !['printing', 'paused'].includes(phase ?? '') ? 'Object skipping is unavailable for this task.' : capability.kind !== 'supported' ? 'Object skipping support has not been reported.' : snapshot ? reason(snapshot.availability) : null;
  const validSelection = selected.filter(id => snapshot?.objects.some(o => o.id === id) && !skipped.includes(id));
  const all = !!snapshot && snapshot.objects.filter(o => !skipped.includes(o.id)).length === validSelection.length;
  const stamp = JSON.stringify([snapshot?.contextRef, taskId, fresh, unavailable, skippedKey, validSelection, capabilityRevision]);
  const latest = useRef(stamp); latest.current = stamp;
  const canSubmit = !!snapshot && !unavailable && snapshot.skippedObjectIds.kind === 'known' && snapshot.skippedObjectIds.freshness === 'fresh' && validSelection.length > 0 && !submitting;
  const openedTask = useRef(taskId);
  useEffect(() => { alive.current = true; return () => { alive.current = false; latest.current = ''; reader.current?.abort(); for (const controller of operationReaders.current) controller.abort(); }; }, []);
  useEffect(() => {
    if (!open) return;
    if (fresh && (taskId !== openedTask.current || loaded && currentObserved && referenceKey(currentObserved.contextRef) !== referenceKey(loaded.contextRef))) {
      reader.current?.abort(); setOpen(false); setSelected([]); setConfirmation(null); setLoaded(null); setMap(null);
      onFeedback('The current task or object information changed. The selection was discarded.');
    }
  }, [open, fresh, taskId, loaded, currentObserved, onFeedback]);
  useEffect(() => { setConfirmation(null); }, [stamp]);
  useEffect(() => {
    if (!open || !loaded) return;
    setSelected(previous => previous.filter(id => !skipped.includes(id)));
    if (skipped.length) setMessage('The printer reported skipped objects. Review the remaining selection.');
  }, [open, loaded, skippedKey]);
  useEffect(() => {
    setMap(null); setMapFailed(false);
    if (!open || !loaded || loaded.pickingImage.kind !== 'supported') return;
    const abort = new AbortController();
    void service.media.readPrintObjectMap(loaded.contextRef, { signal: abort.signal }).then(result => {
      if (abort.signal.aborted) return;
      if (result.ok && referenceKey(result.value.contextRef) === referenceKey(loaded.contextRef)) setMap(result.value);
      else setMapFailed(true);
    }).catch(() => { if (!abort.signal.aborted) setMapFailed(true); });
    return () => abort.abort();
  }, [service, open, loaded]);
  async function load() {
    reader.current?.abort(); const abort = new AbortController(); reader.current = abort;
    setLoading(true); setMessage(null); setConfirmation(null);
    try {
      const result = await service.observations.read({ target: { printerId: target.printerId, routeId: target.routeId }, source: 'device', topics: ['printObjects'] }, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (result.ok) {
        const next = known(result.value.values.printObjects);
        if (!next || next.contextRef.taskId !== openedTask.current) { setMessage('The current task object information is unavailable.'); return; }
        setLoaded(next); setSelected([]);
      } else setMessage(result.error.message);
    } catch { if (!abort.signal.aborted) setMessage('Current task object information could not be loaded.'); }
    finally { if (!abort.signal.aborted) setLoading(false); }
  }
  function toggle(id: D.Id<'print-object'>) {
    if (skipped.includes(id) || submitting) return;
    setSelected(previous => previous.includes(id) ? previous.filter(item => item !== id) : [...previous, id]); setConfirmation(null);
  }
  async function track(operation: D.OperationRef) {
    const abort = new AbortController(); operationReaders.current.add(abort);
    try {
      for await (const state of service.operations.watch(operation, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        if (state.phase.kind === 'completed') { onFeedback('Object operation confirmed by the printer.'); return; }
        if (state.phase.kind === 'failed') { onFeedback(state.phase.error.message); return; }
        if (state.phase.kind === 'outcome-unknown') { onFeedback(state.phase.reason); return; }
      }
      if (!abort.signal.aborted) onFeedback('Object operation outcome unknown. Check the printer before trying again.');
    } catch { if (!abort.signal.aborted) onFeedback('Object operation outcome unknown. Check the printer before trying again.'); }
    finally { operationReaders.current.delete(abort); }
  }
  async function submit() {
    if (!canSubmit || confirmation !== stamp || sending.current || !snapshot) return;
    const expected = stamp;
    const command: Extract<D.PrinterCommand, { type: 'jobs.skipObjects' }> = { type: 'jobs.skipObjects', params: {
      contextRef: snapshot.contextRef, objectIds: validSelection as [D.Id<'print-object'>, ...D.Id<'print-object'>[]], intent: all ? 'cancel-print' : 'skip-selected',
    } };
    sending.current = true; setSubmitting(true);
    try {
      const assessment = await service.controls.evaluate({ printerId: target.printerId, routeId: target.routeId }, command);
      if (latest.current !== expected) return;
      if (!assessment.ok) { setMessage(assessment.error.message); setConfirmation(null); return; }
      if (assessment.value.availability.kind !== 'available') { setMessage(reason(assessment.value.availability)); setConfirmation(null); return; }
      const result = await service.controls.submit({ target, requestId: crypto.randomUUID() as D.Id<'request'>, command,
        guard: { capabilityRevision, expectedTaskId: snapshot.contextRef.taskId } });
      if (!alive.current) return;
      if (result.kind === 'rejected') { setMessage(result.error.message); setConfirmation(null); return; }
      setOpen(false); setSelected([]); setConfirmation(null); reader.current?.abort();
      if (result.kind === 'outcome-unknown') onFeedback('Object operation outcome unknown. Check the printer before trying again.');
      else { onFeedback('Object operation submitted. Waiting for the printer.'); void track(result.operation); }
    } catch { if (!alive.current) return; setMessage('Object operation outcome unknown. Check the printer before trying again.'); setConfirmation(null); }
    finally { sending.current = false; if (alive.current) setSubmitting(false); }
  }
  if (capability.kind === 'unsupported') return null;
  const entryReason = !fresh ? 'Wait for fresh printer status.' : capability.kind !== 'supported' ? 'Object skipping support has not been reported.' : !['printing', 'paused'].includes(phase ?? '') || !taskId ? 'Object skipping is unavailable for this task.' : currentObserved ? reason(currentObserved.availability) : null;
  return <>
    <span title={entryReason ?? 'Skip Objects'} className="inline-flex items-center gap-1">
      <Button size="icon-lg" variant="ghost" aria-label="Skip Objects" disabled={!!entryReason} onClick={() => { openedTask.current = taskId; setLoaded(null); setMap(null); setSelected([]); setOpen(true); void load(); }}><SkipForward className="size-4" /></Button>
      {reportedSkippedCount > 0 && <span className="text-xs text-muted-foreground" aria-label="Skipped objects">{reportedSkippedCount} skipped</span>}
      {entryReason && <span className="sr-only">{entryReason}</span>}
    </span>
    <Dialog open={open} onOpenChange={next => { if (!next && !submitting) { reader.current?.abort(); setOpen(false); setConfirmation(null); } }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogTitle>{confirmation ? all ? 'Stop the entire print?' : 'Confirm object skipping' : 'Skip Objects'}</DialogTitle>
        <DialogDescription>{printerName} · {confirmation ? `${validSelection.length} selected object${validSelection.length === 1 ? '' : 's'}` : 'Select printed instances to skip. Opening this dialog does not pause or resume the print.'}</DialogDescription>
        {loading ? <p role="status">Loading current task objects…</p> : !loaded ? <><p role="alert">{message}</p><Button onClick={() => void load()} disabled={!fresh}>Retry</Button></> : <>
          {unavailable && <p role="alert">{unavailable}</p>}
          {message && <p role="status">{message}</p>}
          {confirmation ? <>
            <p>{all ? 'All remaining objects are selected. This will stop the entire print. Stopping cannot be undone.' : 'The selected objects will no longer be printed. Skipping cannot be undone.'}</p>
            <ul className="max-h-64 overflow-y-auto list-disc pl-5">{snapshot!.objects.filter(o => validSelection.includes(o.id)).map(o => <li key={o.id}>{o.name}</li>)}</ul>
          </> : <>
            {map && !mapFailed ? <ObjectPickingMap map={map} selected={validSelection} skipped={skipped} onToggle={toggle} onFailure={() => setMapFailed(true)} /> : <p className="text-sm text-muted-foreground">{mapFailed || loaded.pickingImage.kind !== 'supported' ? 'The graphical view is unavailable. Use the object list.' : 'Loading graphical view… The object list is available.'}</p>}
            <div className="flex justify-between text-sm"><span>{skipped.length} skipped · {validSelection.length} selected</span><Button size="sm" variant="ghost" disabled={submitting} onClick={() => setSelected(snapshot!.objects.filter(o => !skipped.includes(o.id)).map(o => o.id))}>Select all remaining</Button></div>
            <div className="max-h-60 overflow-y-auto space-y-2 rounded border p-3">{snapshot!.objects.map(object => <label key={object.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={validSelection.includes(object.id)} disabled={skipped.includes(object.id) || submitting} onChange={() => toggle(object.id)} />{object.name}{skipped.includes(object.id) && <span className="text-muted-foreground">(Skipped)</span>}</label>)}</div>
          </>}
        </>}
        <DialogFooter>
          <Button variant="ghost" disabled={submitting} onClick={() => { if (confirmation) setConfirmation(null); else { reader.current?.abort(); setOpen(false); } }}>{confirmation ? 'Back' : 'Close'}</Button>
          {loaded && <Button variant={confirmation ? 'destructive' : 'default'} disabled={!canSubmit} onClick={() => confirmation ? void submit() : setConfirmation(stamp)}>{submitting ? 'Submitting…' : confirmation ? all ? 'Confirm stop print' : 'Confirm skip' : 'Review selection'}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

function ObjectPickingMap({ map, selected, skipped, onToggle, onFailure }: { map: D.PrintObjectMap; selected: readonly D.Id<'print-object'>[]; skipped: readonly D.Id<'print-object'>[]; onToggle: (id: D.Id<'print-object'>) => void; onFailure: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), pixels = useRef<ImageData | null>(null);
  const [decoded, setDecoded] = useState(0);
  const fail = useRef(onFailure); fail.current = onFailure;
  useEffect(() => {
    let cancelled = false; const image = new Image(); pixels.current = null;
    const url = URL.createObjectURL(new Blob([new Uint8Array(map.bytes)], { type: map.mimeType }));
    image.onload = () => {
      if (cancelled) return;
      try {
        if (!image.width || !image.height || image.width > 2048 || image.height > 2048) throw new Error('Invalid image');
        const context = canvas.current?.getContext('2d', { willReadFrequently: true }); if (!context || !canvas.current) throw new Error('No canvas');
        canvas.current.width = image.width; canvas.current.height = image.height; context.drawImage(image, 0, 0);
        pixels.current = context.getImageData(0, 0, image.width, image.height); setDecoded(n => n + 1);
      } catch { fail.current(); }
    };
    image.onerror = () => { if (!cancelled) fail.current(); }; image.src = url;
    return () => { cancelled = true; image.onload = null; image.onerror = null; URL.revokeObjectURL(url); };
  }, [map]);
  useEffect(() => {
    const original = pixels.current, context = canvas.current?.getContext('2d'); if (!original || !context) return;
    const palette = new Map(map.palette.map(p => [p.colourId, p.objectId]));
    const rendered = new ImageData(original.width, original.height);
    for (let i = 0; i < original.data.length; i += 4) {
      const id = original.data[i] | original.data[i + 1] << 8 | original.data[i + 2] << 16;
      const object = original.data[i + 3] ? palette.get(id) : undefined;
      const colour = !object ? [243, 244, 246] : skipped.includes(object) ? [156, 163, 175] : selected.includes(object) ? [20, 184, 166] : [75, 85, 99];
      rendered.data.set([...colour, 255], i);
    }
    context.putImageData(rendered, 0, 0);
  }, [map, selected, skipped, decoded]);
  return <canvas ref={canvas} role="img" aria-label="Top-down object selection; use the object list for keyboard selection" className="w-full max-w-72 h-auto mx-auto cursor-pointer rounded border" onClick={event => {
    const original = pixels.current, bounds = event.currentTarget.getBoundingClientRect(); if (!original || !bounds.width || !bounds.height) return;
    const x = Math.floor((event.clientX - bounds.left) / bounds.width * original.width), y = Math.floor((event.clientY - bounds.top) / bounds.height * original.height);
    if (x < 0 || y < 0 || x >= original.width || y >= original.height) return;
    const i = (y * original.width + x) * 4, colour = original.data[i] | original.data[i + 1] << 8 | original.data[i + 2] << 16;
    const object = original.data[i + 3] ? map.palette.find(p => p.colourId === colour)?.objectId : undefined; if (object) onToggle(object);
  }} />;
}
