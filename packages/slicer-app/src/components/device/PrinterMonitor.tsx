import { useRef, useState } from 'react';
import { Pause, Play, Square } from 'lucide-react';
import { PrinterMonitorLayout, PrintProgressCard } from './PrinterMonitorLayout';
import { usePlatform } from '@orca/platform-contract';
import type * as D from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { usePrinterCommands, useCurrentPrintPreview } from './usePrinterControl';
import { usePrinterObservation } from './usePrinterObservation';
import { ActuatorCard, ControlCard, display, MotionCard, ThermalCard, valueOf } from './PrinterControlCards';
import { CameraCard } from './media/CameraCard';
import { MaterialControlCard } from './MaterialControlCard';

const monitoringTopics = ['status', 'thermal', 'motion', 'actuators', 'materials', 'sensors'] as const;
export function supportsMonitor(capabilities: D.PrinterCapabilities): boolean {
  return monitoringTopics.some(topic => capabilities.observations[topic].kind === 'supported')
    || capabilities.cameras.some(camera => camera.liveView.kind === 'supported' || camera.snapshot.kind === 'supported')
    || Object.entries(capabilities.commands).some(([name, capability]) => capability.kind === 'supported'
      && !['jobs.start', 'files.delete', 'actions.invoke', 'materials.writeMetadata', 'materials.refreshTag'].includes(name));
}

export function PrinterMonitor({ printer, route, visible = true }: { printer: D.SavedPrinter; route: D.PrinterRoute; visible?: boolean }) {
  const { printers: { service } } = usePlatform();
  const { snapshot, capabilities, error, refreshing, refresh, live, liveStatus, canRefresh } = usePrinterObservation(service, printer, route, visible);
  const target = { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision };
  const { send: submit, feedback, pending, setFeedback } = usePrinterCommands(service, target, capabilities.revision);
  const [cancel, setCancel] = useState<{ name: string; taskId?: D.Id<'device-task'> } | null>(null);
  const status = valueOf(snapshot?.values.status), topology = valueOf(snapshot?.values.descriptor)?.topology;
  const fresh = snapshot?.values.status?.kind === 'known' && snapshot.values.status.freshness === 'fresh' && !error;
  const phase = valueOf(status?.printStatus.phase), taskId = valueOf(status?.printStatus.taskId);
  const latestTask = useRef(taskId); latestTask.current = taskId;
  const preview = useCurrentPrintPreview(service, target, taskId, visible && capabilities.currentPrintPreview.kind === 'supported');
  async function send(command: D.PrinterCommand, expectedTaskId?: D.Id<'device-task'>) {
    if (pending || refreshing || liveStatus && !fresh) return;
    if (expectedTaskId && latestTask.current !== expectedTaskId) { setFeedback('The active task changed. Review it before cancelling.'); setCancel(null); return; }
    setCancel(null); await submit(command, expectedTaskId);
  }
  const controls = { capabilities, snapshot, disabled: pending || refreshing || liveStatus && !fresh, send: (command: D.PrinterCommand) => { void send(command); } };
  const hasThermal = capabilities.observations.thermal.kind === 'supported' || capabilities.commands['thermal.setTarget'].kind === 'supported';
  const hasSensors = capabilities.observations.sensors.kind === 'supported';
  const hasActuators = capabilities.observations.actuators.kind === 'supported' || capabilities.commands['fans.setSpeed'].kind === 'supported' || capabilities.commands['lights.set'].kind === 'supported';
  const hasMotion = capabilities.observations.motion.kind === 'supported' || ['motion.home', 'motion.jog', 'extrusion.move', 'tools.select'].some(type => capabilities.commands[type as keyof D.CommandCapabilities].kind === 'supported');
  const sensors = valueOf(snapshot?.values.sensors), thermal = valueOf(snapshot?.values.thermal);
  const speeds = capabilities.commands['jobs.setSpeed'];
  const paused = phase === 'paused';
  const pauseResumeCommand = paused ? 'jobs.resume' : 'jobs.pause';
  const pauseResumeLabel = paused ? 'Resume' : 'Pause';
  const PauseResumeIcon = paused ? Play : Pause;
  return <><PrinterMonitorLayout testId="device-monitor" title={printer.identity.displayName} subtitle={`${printer.identity.model ?? ''} · ${route.label}`}
    toolbar={canRefresh && <Button size="sm" variant="secondary" disabled={pending || refreshing} onClick={() => void refresh()}>Refresh</Button>}
    status={live && <span className="text-xs" role="status">{error ? 'Disconnected or stale' : liveStatus ? fresh ? 'Live' : snapshot ? 'Disconnected or stale' : 'Connecting…' : snapshot ? 'Live observations' : 'Connecting…'}</span>}
    camera={capabilities.cameras.length ? capabilities.cameras.map(camera => <CameraCard
      key={`${target.printerId}:${target.routeId}:${route.configurationRevision}:${camera.cameraId}`}
      media={service.media} target={target} capability={camera} visible={visible}
      name={topology?.cameras.find(item => item.id === camera.cameraId)?.name ?? 'Camera'}
      disabled={valueOf(snapshot?.values.cameras)?.some(item => item.cameraId === camera.cameraId && valueOf(item.enabled) === false) ?? false}
    />) : capabilities.observations.cameras.kind === 'supported' && <ControlCard title="Camera"><p role="status" className="printer-camera-viewport printer-camera-placeholder">Camera information has not been reported.</p></ControlCard>}
    notices={<>
    {canRefresh && !snapshot && <p className="text-sm text-muted-foreground">No readings requested. Use Refresh to read the printer.</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {feedback && <div role="status" className="flex items-center justify-between gap-3 rounded border p-2 text-sm"><span>{feedback}</span><Button size="sm" variant="ghost" onClick={() => setFeedback(null)}>Dismiss</Button></div>}
    {valueOf(snapshot?.values.alerts)?.map(alert => <section key={alert.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-destructive/40 p-3 text-sm"><span>{alert.message} <span className="text-muted-foreground">{alert.code}</span></span><div className="flex gap-2">{alert.actions.map(action => <Button key={action.actionRef.token} size="sm" variant="secondary" disabled={controls.disabled || action.availability.kind !== 'available'} onClick={() => void send({ type: 'actions.invoke', params: { actionRef: action.actionRef } })}>{action.label}</Button>)}</div></section>)}
    </>}
    progress={<PrintProgressCard preview={preview} status={status?.printStatus} progressActions={<>
        {(capabilities.commands['jobs.pause'].kind === 'supported' || capabilities.commands['jobs.resume'].kind === 'supported') && <Button size="icon-lg" variant="ghost" className="text-muted-foreground" aria-label={pauseResumeLabel} title={pauseResumeLabel} disabled={controls.disabled || capabilities.commands[pauseResumeCommand].kind !== 'supported' || liveStatus && phase !== (paused ? 'paused' : 'printing')} onClick={() => void send({ type: pauseResumeCommand, params: {} })}><PauseResumeIcon className="size-4" fill="currentColor" strokeWidth={0} /></Button>}
        {capabilities.commands['jobs.cancel'].kind === 'supported' && <Button size="icon-lg" variant="ghost" className="text-muted-foreground" aria-label="Cancel print" title="Cancel print" disabled={controls.disabled || liveStatus && !['printing', 'paused', 'preparing'].includes(phase ?? '')} onClick={() => { if (liveStatus || taskId) setCancel({ name: valueOf(status?.printStatus.name) ?? 'Current task', taskId: taskId ?? undefined }); else void send({ type: 'jobs.cancel', params: {} }); }}><Square className="size-4" fill="currentColor" strokeWidth={0} /></Button>}
      </>} details={<><dt>State</dt><dd>{display(status?.operationalState)}</dd><dt>Stage</dt><dd>{display(status?.printStatus.stage, stage => stage?.label ?? '—')}</dd><dt>Layer</dt><dd>{display(status?.printStatus.currentLayer)} / {display(status?.printStatus.totalLayers)}</dd></>}

    />}
    controls={<ControlCard title="Control"><div className={hasMotion ? 'printer-machine-controls' : 'space-y-3'}><div className={hasMotion ? 'printer-environment-controls' : 'space-y-3'}>
      {hasThermal && (topology?.heaters.length ? <ThermalCard {...controls} /> : <ControlCard title="Heater targets">{thermal?.map(heater => <p key={heater.heaterId}>{heater.heaterId}: {display(heater.targetC, value => `${value} °C`)}</p>) ?? 'Not reported'}</ControlCard>)}
      {hasSensors && !topology?.heaters.length && <ControlCard title="Sensors">{sensors?.definitions.map(sensor => <p key={sensor.id}>{sensor.name}: {display<unknown>(sensors.readings.find(state => state.sensorId === sensor.id)?.reading, value => typeof value === 'object' ? Object.entries(value ?? {}).map(([axis, number]) => `${axis}: ${number}`).join(', ') : String(value))}{sensor.unit ? ` ${sensor.unit}` : ''}</p>) ?? 'Not reported'}</ControlCard>}
      {hasActuators && <ActuatorCard {...controls} />}
      {speeds.kind === 'supported' && <div className="printer-print-actions"><label className="printer-print-speed"><span>Print speed</span><select aria-label="Print speed" className="rounded border bg-background p-1 text-sm" value={valueOf(status?.printStatus.speedModeId) ?? ''} disabled={controls.disabled || !['printing', 'paused'].includes(phase ?? '')} onChange={event => void send({ type: 'jobs.setSpeed', params: { modeId: event.target.value } })}><option value="" disabled>Print speed</option>{speeds.constraints.modes.map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label></div>}
      {!hasThermal && !hasSensors && !hasActuators && !hasMotion && <p className="text-sm text-muted-foreground">Temperature and sensor readings are not available on this route.</p>}
    </div>{hasMotion && <MotionCard {...controls} />}</div></ControlCard>}
    materials={capabilities.observations.materials.kind === 'supported' && <MaterialControlCard {...controls} />}
    hardware={(!!topology?.nozzles.length || capabilities.commands['hardware.refreshNozzles'].kind === 'supported') && <details className="printer-hardware-details"><summary>Nozzle hardware</summary>
    <ControlCard title="Nozzles"><div className="flex flex-wrap gap-4">{topology?.nozzles.map(nozzle => <div key={nozzle.id} className="text-sm"><strong>{topology.tools.find(tool => tool.nozzleId === nozzle.id)?.name ?? 'Unknown tool'} · Nozzle</strong><p>{nozzle.diameterMm === null ? 'Diameter not reported' : `${nozzle.diameterMm} mm`} · {nozzle.constructionMaterial ?? 'Material not reported'}</p><p className="text-xs text-muted-foreground">{nozzle.flowType ?? 'Flow type not reported'}{nozzle.type ? ` · ${nozzle.type}` : ''}</p></div>)}</div>
      {capabilities.commands['hardware.refreshNozzles'].kind === 'supported' && <Button size="sm" variant="secondary" disabled={controls.disabled} onClick={() => void send({ type: 'hardware.refreshNozzles', params: {} })}>Refresh nozzle identification</Button>}
    </ControlCard></details>}
  />
    {cancel && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-labelledby="cancel-print-title"><div className="w-full max-w-sm space-y-4 rounded-lg border bg-card p-5 shadow-lg"><h2 id="cancel-print-title" className="font-semibold">Cancel print?</h2><p className="text-sm">Stop “{cancel.name}” on “{printer.identity.displayName}”?</p><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCancel(null)}>Keep printing</Button><Button variant="destructive" disabled={controls.disabled} onClick={() => void send({ type: 'jobs.cancel', params: {} }, cancel.taskId)}>Confirm cancellation</Button></div></div></div>}
  </>;
}
