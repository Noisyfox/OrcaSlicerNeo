import { useEffect, useRef, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { CommandRequest, Id, PrinterCapabilities, PrinterRoute, PrinterSnapshot, Reading, SavedPrinter, StateTopic } from '@orca/printer-control/domain';
import { Button } from '@/components/ui/button';

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

function reading<T>(value: Reading<T> | undefined, format: (value: T) => string = String): string {
  if (!value || value.kind === 'unknown') return 'Not reported';
  return `${format(value.value)}${value.freshness === 'stale' ? ' (stale)' : ''}`;
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
  return <div className="h-full overflow-y-auto p-4" data-testid="device-monitor">
    <div className="mb-4 flex items-center justify-between gap-3">
      <div><h2 className="text-sm font-semibold">{printer.identity.displayName}</h2><p className="text-xs text-muted-foreground">{route.label}</p></div>
      {topics.length > 0 && <Button size="sm" variant="secondary" disabled={busy} onClick={() => void refresh()}>Refresh</Button>}
    </div>
    {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
    <div className="grid gap-3 md:grid-cols-2">
      {route.capabilities.observations.status.kind === 'supported' && <section className="rounded-md border p-3">
        <h3 className="mb-2 text-sm font-medium">Print status</h3>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt>State</dt><dd>{reading(status?.kind === 'known' ? status.value.operationalState : undefined)}</dd>
          <dt>Print</dt><dd>{reading(status?.kind === 'known' ? status.value.printStatus.name : undefined, value => value ?? 'No active print')}</dd>
          <dt>Phase</dt><dd>{reading(status?.kind === 'known' ? status.value.printStatus.phase : undefined)}</dd>
          <dt>Progress</dt><dd>{reading(status?.kind === 'known' ? status.value.printStatus.progressFraction : undefined, value => `${Math.round(value * 100)}%`)}</dd>
          <dt>Remaining</dt><dd>{reading(status?.kind === 'known' ? status.value.printStatus.remainingSeconds : undefined, value => `${Math.ceil(value / 60)} min`)}</dd>
        </dl>
        {status?.kind === 'known' && status.freshness === 'stale' && <p className="mt-2 text-xs text-muted-foreground">Stale readings</p>}
      </section>}
      {route.capabilities.observations.sensors.kind === 'supported' && <section className="rounded-md border p-3">
        <h3 className="mb-2 text-sm font-medium">Sensors</h3>
        {snapshot?.values.sensors?.kind === 'known' ? snapshot.values.sensors.value.definitions.map(sensor => {
          const value = snapshot.values.sensors;
          const state = value?.kind === 'known' ? value.value.readings.find(state => state.sensorId === sensor.id) : undefined;
          return <p key={sensor.id} className="text-sm">{sensor.name}: {reading<unknown>(state?.reading, value => typeof value === 'object' ? Object.entries(value ?? {}).map(([axis, number]) => `${axis}: ${number}`).join(', ') : String(value))}{sensor.unit ? ` ${sensor.unit}` : ''}</p>;
        }) : <p className="text-sm text-muted-foreground">Not reported</p>}
      </section>}
      {route.capabilities.observations.thermal.kind === 'supported' && <section className="rounded-md border p-3">
        <h3 className="mb-2 text-sm font-medium">Heater targets</h3>
        {snapshot?.values.thermal?.kind === 'known' ? snapshot.values.thermal.value.map(heater => <p key={heater.heaterId} className="text-sm">{heater.heaterId}: {reading(heater.targetC, value => `${value} °C`)}</p>) : <p className="text-sm text-muted-foreground">Not reported</p>}
      </section>}
      <section className="rounded-md border p-3"><h3 className="mb-2 text-sm font-medium">Printer controls</h3>
        <div className="flex flex-wrap gap-2">{printControls.filter(control => route.capabilities.commands[control.type].kind === 'supported').map(control => <Button key={control.type} size="sm" variant="secondary" disabled={busy} onClick={() => void command(control.type)}>{control.label}</Button>)}</div>
        {!printControls.some(control => route.capabilities.commands[control.type].kind === 'supported') && <p className="text-xs text-muted-foreground">No basic print controls are available on this route.</p>}
      </section>
    </div>
    {topics.length === 0 && <p className="mt-4 text-sm text-muted-foreground">This route does not provide status, sensor or temperature readings. Additional monitor controls and camera viewing are not available in this view yet.</p>}
    {topics.length > 0 && !snapshot && <p className="mt-4 text-sm text-muted-foreground">No readings requested. Use Refresh to read the printer.</p>}
  </div>;
}
