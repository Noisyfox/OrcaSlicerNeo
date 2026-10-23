import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { CommandRequest, Id, PrinterCapabilities, PrinterRoute, PrinterSnapshot, SavedPrinter, StateTopic } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';
import { ControlCard, display as reading, valueOf } from './PrinterControlCards';
import { PrinterMonitorLayout, PrintProgressCard } from './PrinterMonitorLayout';

const monitoringTopics = ['status', 'thermal', 'motion', 'actuators', 'materials', 'sensors'] as const;
const printControls = [
  { type: 'jobs.pause', label: 'Pause' },
  { type: 'jobs.resume', label: 'Resume' },
  { type: 'jobs.cancel', label: 'Cancel print' },
] as const;

export function supportsMonitor(capabilities: PrinterCapabilities): boolean {
  return monitoringTopics.some(topic => capabilities.observations[topic].kind === 'supported')
    || capabilities.cameras.some(camera => camera.liveView.kind === 'supported' || camera.snapshot.kind === 'supported')
    || Object.entries(capabilities.commands).some(([name, capability]) => capability.kind === 'supported'
      && !['jobs.start', 'files.delete', 'actions.invoke', 'materials.writeMetadata', 'materials.refreshTag'].includes(name));
}

/** Explicit reads and commands on one route; selecting a printer never starts polling. */
export function PrinterMonitor({ printer, route }: { printer: SavedPrinter; route: PrinterRoute }) {
  const { printers: { service } } = usePlatform();
  const [snapshot, setSnapshot] = useState<PrinterSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pending = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => { abort.current?.abort(); }, []);
  const topics = (['status', 'sensors', 'thermal'] as const).filter(topic => route.capabilities.observations[topic].kind === 'supported');
  const target = { printerId: printer.identity.id, routeId: route.id, expectedConfigurationRevision: route.configurationRevision };

  async function refresh() {
    if (pending.current || topics.length === 0) return;
    pending.current = true; setBusy(true); setMessage(null);
    const controller = new AbortController(); abort.current = controller;
    try {
      const result = await service.observations.read({ target, source: 'device', topics: topics as [StateTopic, ...StateTopic[]] }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.ok) setSnapshot(result.value);
      else setMessage('Unable to refresh. Previously reported readings may be stale.');
    } catch { if (!controller.signal.aborted) setMessage('Unable to refresh. Previously reported readings may be stale.'); }
    finally { pending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }

  async function command(type: typeof printControls[number]['type']) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setMessage(null);
    const controller = new AbortController(); abort.current = controller;
    try {
      const request = { target, requestId: crypto.randomUUID() as Id<'request'>, command: { type, params: {} } } as Extract<CommandRequest, { command: { type: typeof type } }>;
      const result = await service.controls.submit(request);
      if (controller.signal.aborted) return;
      if (result.kind === 'rejected') { setMessage('The printer rejected the command.'); return; }
      if (result.kind === 'outcome-unknown') { setMessage('Command outcome unknown. Check the printer before trying again.'); return; }
      for await (const operation of service.operations.watch(result.operation, { signal: controller.signal })) {
        if (controller.signal.aborted) return;
        if (operation.phase.kind === 'completed') { setMessage('Command completed. Refresh to read the current state.'); return; }
        if (operation.phase.kind === 'failed') { setMessage('The printer could not complete the command.'); return; }
        if (operation.phase.kind === 'outcome-unknown') break;
      }
      if (!controller.signal.aborted) setMessage('Command outcome unknown. Check the printer before trying again.');
    } catch { if (!controller.signal.aborted) setMessage('Command outcome unknown. Check the printer before trying again.'); }
    finally { pending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }

  const status = snapshot?.values.status;
  const controls = <>{printControls.filter(control => route.capabilities.commands[control.type].kind === 'supported').map(control => <Button key={control.type} size="sm" variant="secondary" disabled={busy} onClick={() => void command(control.type)}>{control.label}</Button>)}
    {!printControls.some(control => route.capabilities.commands[control.type].kind === 'supported') && <p className="text-xs text-muted-foreground">No basic print controls are available on this route.</p>}</>;
  const sensors = valueOf(snapshot?.values.sensors), thermal = valueOf(snapshot?.values.thermal);
  const hasSensors = route.capabilities.observations.sensors.kind === 'supported', hasThermal = route.capabilities.observations.thermal.kind === 'supported';
  return <PrinterMonitorLayout testId="device-monitor" title={printer.identity.displayName} subtitle={route.label}
    toolbar={topics.length > 0 && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>Refresh</Button>}
    notices={<>
      {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
      {status?.kind === 'known' && status.freshness === 'stale' && <p className="text-xs text-muted-foreground">Stale readings</p>}
      {topics.length === 0 && <p className="text-sm text-muted-foreground">This route does not provide status, sensor or temperature readings. Additional monitor controls and camera viewing are not available in this view yet.</p>}
      {topics.length > 0 && !snapshot && <p className="text-sm text-muted-foreground">No readings requested. Use Refresh to read the printer.</p>}
    </>}
    progress={<PrintProgressCard status={valueOf(status)?.printStatus} details={route.capabilities.observations.status.kind === 'supported' && <><dt>State</dt><dd>{reading(valueOf(status)?.operationalState)}</dd></>}>{controls}</PrintProgressCard>}
    controls={<ControlCard title="Control">
      {hasSensors && <ControlCard title="Sensors">{sensors ? sensors.definitions.map(sensor => {
        const state = sensors.readings.find(state => state.sensorId === sensor.id);
        return <p key={sensor.id} className="text-sm">{sensor.name}: {reading<unknown>(state?.reading, value => typeof value === 'object' ? Object.entries(value ?? {}).map(([axis, number]) => `${axis}: ${number}`).join(', ') : String(value))}{sensor.unit ? ` ${sensor.unit}` : ''}</p>;
      }) : <p className="text-sm text-muted-foreground">Not reported</p>}</ControlCard>}
      {hasThermal && <ControlCard title="Heater targets">{thermal ? thermal.map(heater => <p key={heater.heaterId} className="text-sm">{heater.heaterId}: {reading(heater.targetC, value => `${value} °C`)}</p>) : <p className="text-sm text-muted-foreground">Not reported</p>}</ControlCard>}
      {!hasSensors && !hasThermal && <p className="text-sm text-muted-foreground">Temperature and sensor readings are not available on this route.</p>}
    </ControlCard>}
  />;
}
