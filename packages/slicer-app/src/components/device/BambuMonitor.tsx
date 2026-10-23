import { useEffect, useRef, useState } from 'react';
import { PrinterMonitorLayout, PrintProgressCard } from './PrinterMonitorLayout';
import { usePlatform } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { useLivePrinter } from './useLivePrinter';
import { ActuatorCard, ControlCard, display, MotionCard, ThermalCard, valueOf } from './PrinterControlCards';
import { MaterialControlCard } from './MaterialControlCard';

export function BambuMonitor({ printer, route, visible }: { printer: D.SavedPrinter; route: D.PrinterRoute; visible: boolean }) {
  const { printers: { service } } = usePlatform();
  const { snapshot, capabilities, error } = useLivePrinter(service, printer, route, visible);
  const [feedback, setFeedback] = useState<string | null>(null), [pending, setPending] = useState(false);
  const [cancel, setCancel] = useState<{ name: string; taskId?: D.Id<'device-task'> } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const busy = useRef(false), controller = useRef<AbortController | null>(null);
  const status = valueOf(snapshot?.values.status), topology = valueOf(snapshot?.values.descriptor)?.topology;
  const fresh = snapshot?.values.status?.kind === 'known' && snapshot.values.status.freshness === 'fresh' && !error;
  const phase = valueOf(status?.printStatus.phase), taskId = valueOf(status?.printStatus.taskId);
  const latestTask = useRef(taskId); latestTask.current = taskId;
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!visible || capabilities.currentPrintPreview.kind !== 'supported' || !taskId) { setPreview(null); return; }
    setPreview(null);
    const abort = new AbortController(); let url: string | null = null;
    void service.media.readCurrentPrintPreview({ printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision }, { signal: abort.signal }).then(result => {
      if (!abort.signal.aborted && result.ok && result.value.taskId === taskId) { url = URL.createObjectURL(new Blob([new Uint8Array(result.value.bytes)], { type: result.value.mimeType })); setPreview(url); }
    }).catch(() => {});
    return () => { abort.abort(); if (url) URL.revokeObjectURL(url); };
  }, [service, printer.identity.id, route.id, route.configurationRevision, taskId, visible, capabilities.currentPrintPreview.kind]);
  async function send(command: D.PrinterCommand, expectedTaskId?: D.Id<'device-task'>) {
    if (busy.current || !fresh) return;
    if (expectedTaskId && latestTask.current !== expectedTaskId) { setFeedback('The active task changed. Review it before cancelling.'); setCancel(null); return; }
    busy.current = true; setPending(true); setFeedback(null); setCancel(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const target = { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision };
      const assessment = await service.controls.evaluate({ printerId: target.printerId, routeId: target.routeId }, command, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (!assessment.ok) { setFeedback(assessment.error.message); return; }
      if (assessment.value.availability.kind !== 'available') { setFeedback(assessment.value.availability.kind === 'blocked' ? assessment.value.availability.reasons.map(reason => reason.message).join(' ') : assessment.value.availability.reason); return; }
      const request = { target, requestId: crypto.randomUUID() as D.Id<'request'>, command, guard: { capabilityRevision: capabilities.revision, ...(expectedTaskId ? { expectedTaskId } : {}) } } as D.CommandRequest;
      const result = await service.controls.submit(request);
      if (abort.signal.aborted) return;
      if (result.kind === 'rejected') { setFeedback(result.error.message); return; }
      if (result.kind === 'outcome-unknown') { setFeedback('Command outcome unknown. Check the printer before trying again.'); return; }
      setFeedback('Command sent. Waiting for the printer.');
      for await (const operation of service.operations.watch(result.operation, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        if (operation.phase.kind === 'completed') { setFeedback('Command completed.'); return; }
        if (operation.phase.kind === 'failed') { setFeedback(operation.phase.error.message); return; }
        if (operation.phase.kind === 'acknowledged') setFeedback('Printer acknowledged the command. Waiting for completion.');
        if (operation.phase.kind === 'outcome-unknown') { setFeedback(operation.phase.reason); return; }
      }
    } catch { if (!abort.signal.aborted) setFeedback('Command outcome unknown. Check the printer before trying again.'); }
    finally { busy.current = false; if (!abort.signal.aborted) setPending(false); }
  }
  const controls = { capabilities, snapshot, disabled: !fresh || pending, send: (command: D.PrinterCommand) => { void send(command); } };
  const speeds = capabilities.commands['jobs.setSpeed'];
  return <><PrinterMonitorLayout testId="bambu-monitor" title={printer.identity.displayName} subtitle={`${printer.identity.model ?? ''} · ${route.label}`}
    status={<span className="text-xs" role="status">{fresh ? 'Live' : snapshot ? 'Disconnected or stale' : 'Connecting…'}</span>}
    preview={preview}
    notices={<>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {feedback && <div role="status" className="flex items-center justify-between gap-3 rounded border p-2 text-sm"><span>{feedback}</span><Button size="sm" variant="ghost" onClick={() => setFeedback(null)}>Dismiss</Button></div>}
    {valueOf(snapshot?.values.alerts)?.map(alert => <section key={alert.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-destructive/40 p-3 text-sm"><span>{alert.message} <span className="text-muted-foreground">{alert.code}</span></span><div className="flex gap-2">{alert.actions.map(action => <Button key={action.actionRef.token} size="sm" variant="secondary" disabled={controls.disabled || action.availability.kind !== 'available'} onClick={() => void send({ type: 'actions.invoke', params: { actionRef: action.actionRef } })}>{action.label}</Button>)}</div></section>)}
    </>}
    progress={<PrintProgressCard status={status?.printStatus} details={<><dt>Stage</dt><dd>{display(status?.printStatus.stage, stage => stage?.label ?? '—')}</dd><dt>Layer</dt><dd>{display(status?.printStatus.currentLayer)} / {display(status?.printStatus.totalLayers)}</dd></>}>
        {capabilities.commands['jobs.pause'].kind === 'supported' && <Button size="sm" variant="secondary" disabled={controls.disabled || phase !== 'printing'} onClick={() => void send({ type: 'jobs.pause', params: {} })}>Pause</Button>}
        {capabilities.commands['jobs.resume'].kind === 'supported' && <Button size="sm" variant="secondary" disabled={controls.disabled || phase !== 'paused'} onClick={() => void send({ type: 'jobs.resume', params: {} })}>Resume</Button>}
        {capabilities.commands['jobs.cancel'].kind === 'supported' && <Button size="sm" variant="destructive" disabled={controls.disabled || !['printing', 'paused', 'preparing'].includes(phase ?? '')} onClick={() => setCancel({ name: valueOf(status?.printStatus.name) ?? 'Current task', taskId: taskId ?? undefined })}>Cancel print</Button>}
        {speeds.kind === 'supported' && <label className="printer-print-speed"><span>Print speed</span><select aria-label="Print speed" className="rounded border bg-background p-1 text-sm" value={valueOf(status?.printStatus.speedModeId) ?? ''} disabled={controls.disabled || !['printing', 'paused'].includes(phase ?? '')} onChange={event => void send({ type: 'jobs.setSpeed', params: { modeId: event.target.value } })}><option value="" disabled>Print speed</option>{speeds.constraints.modes.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>}
    </PrintProgressCard>}
    controls={<ControlCard title="Control"><div className="printer-machine-controls"><div className="printer-environment-controls"><ThermalCard {...controls} /><ActuatorCard {...controls} /></div><MotionCard {...controls} /></div></ControlCard>}
    materials={<MaterialControlCard {...controls} />}
    hardware={<details className="printer-hardware-details"><summary>Nozzle hardware</summary>
    <ControlCard title="Nozzles"><div className="flex flex-wrap gap-4">{topology?.nozzles.map(nozzle => <div key={nozzle.id} className="text-sm"><strong>{nozzle.id.replace('nozzle:', 'Nozzle ')}</strong><p>{nozzle.diameterMm === null ? 'Diameter not reported' : `${nozzle.diameterMm} mm`} · {nozzle.constructionMaterial ?? 'Material not reported'}</p><p className="text-xs text-muted-foreground">{nozzle.flowType ?? 'Flow type not reported'}{nozzle.type ? ` · ${nozzle.type}` : ''}</p></div>)}</div>
      {capabilities.commands['hardware.refreshNozzles'].kind === 'supported' && <Button size="sm" variant="secondary" disabled={controls.disabled} onClick={() => void send({ type: 'hardware.refreshNozzles', params: {} })}>Refresh nozzle identification</Button>}
    </ControlCard></details>}
  />
    {cancel && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="cancel-print-title"><div className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-5 shadow-lg"><h2 id="cancel-print-title" className="font-semibold">Cancel print?</h2><p className="text-sm">Stop “{cancel.name}” on “{printer.identity.displayName}”?</p><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCancel(null)}>Keep printing</Button><Button variant="destructive" disabled={controls.disabled} onClick={() => void send({ type: 'jobs.cancel', params: {} }, cancel.taskId)}>Confirm cancellation</Button></div></div></div>}
  </>;
}
