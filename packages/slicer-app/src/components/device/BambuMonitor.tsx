import { useRef, useState } from 'react';
import { PrinterMonitorLayout, PrintProgressCard } from './PrinterMonitorLayout';
import { usePlatform } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { usePrinterCommands, useCurrentPrintPreview } from './usePrinterControl';
import { useLivePrinter } from './useLivePrinter';
import { ActuatorCard, ControlCard, display, MotionCard, ThermalCard, valueOf } from './PrinterControlCards';
import { MaterialControlCard } from './MaterialControlCard';

export function BambuMonitor({ printer, route, visible }: { printer: D.SavedPrinter; route: D.PrinterRoute; visible: boolean }) {
  const { printers: { service } } = usePlatform();
  const { snapshot, capabilities, error } = useLivePrinter(service, printer, route, visible);
  const target = { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision };
  const { send: submit, feedback, pending, setFeedback } = usePrinterCommands(service, target, capabilities.revision);
  const [cancel, setCancel] = useState<{ name: string; taskId?: D.Id<'device-task'> } | null>(null);
  const status = valueOf(snapshot?.values.status), topology = valueOf(snapshot?.values.descriptor)?.topology;
  const fresh = snapshot?.values.status?.kind === 'known' && snapshot.values.status.freshness === 'fresh' && !error;
  const phase = valueOf(status?.printStatus.phase), taskId = valueOf(status?.printStatus.taskId);
  const latestTask = useRef(taskId); latestTask.current = taskId;
  const preview = useCurrentPrintPreview(service, target, taskId, visible && capabilities.currentPrintPreview.kind === 'supported');
  async function send(command: D.PrinterCommand, expectedTaskId?: D.Id<'device-task'>) {
    if (!fresh || pending) return;
    if (expectedTaskId && latestTask.current !== expectedTaskId) { setFeedback('The active task changed. Review it before cancelling.'); setCancel(null); return; }
    setCancel(null); await submit(command, expectedTaskId);
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
