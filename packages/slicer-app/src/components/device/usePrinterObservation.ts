import { useEffect, useRef, useState } from 'react';
import type * as D from '@orca/printer-control/domain';

const contentTopics: D.StateTopic[] = ['status', 'sensors', 'thermal', 'motion', 'actuators', 'materials', 'alerts', 'cameras'];
/** Select only topics consumed by this screen. A metadata capability alone never starts device access. */
export function monitorTopics(capabilities: D.PrinterCapabilities) {
  const topics = contentTopics.filter(topic => capabilities.observations[topic].kind === 'supported');
  const topologyCommands: (keyof D.CommandCapabilities)[] = ['thermal.setTarget', 'fans.setSpeed', 'lights.set', 'motion.home', 'motion.jog', 'extrusion.move', 'tools.select', 'hardware.refreshNozzles'];
  if (['thermal', 'motion', 'actuators', 'materials', 'cameras'].some(topic => topics.includes(topic as D.StateTopic)) || topologyCommands.some(type => capabilities.commands[type].kind === 'supported')) {
    if (capabilities.observations.descriptor.kind === 'supported') topics.unshift('descriptor');
  }
  const stream: D.StateTopic[] = [], manual: D.StateTopic[] = [];
  for (const topic of topics) {
    const capability = capabilities.observations[topic];
    if (capability.kind !== 'supported') continue;
    if (capability.constraints.delivery.some(delivery => delivery === 'push' || delivery === 'poll')) stream.push(topic);
    else if (capability.constraints.delivery.includes('on-demand')) manual.push(topic);
  }
  return { stream, manual };
}

export function usePrinterObservation(service: D.PrinterService, printer: D.SavedPrinter, route: D.PrinterRoute, visible: boolean, observeWhileHidden = false) {
  const [snapshot, setSnapshot] = useState<D.PrinterSnapshot | null>(null), [capabilities, setCapabilities] = useState(route.capabilities);
  const [error, setError] = useState<string | null>(null), [refreshing, setRefreshing] = useState(false);
  const latest = useRef<D.PrinterSnapshot | null>(null), latestErrors = useRef<{ stream: string | null; manual: string | null }>({ stream: null, manual: null }), latestCapabilities = useRef(capabilities);
  const shown = useRef(visible); shown.current = visible;
  const [started, setStarted] = useState(visible || observeWhileHidden);
  const readController = useRef<AbortController | null>(null), reading = useRef(false);
  const { stream, manual } = monitorTopics(capabilities);
  const streamKey = stream.join(',');
  // Observation/description contracts accept identity only; revision guards belong to commands/previews.
  const target: D.PrinterTarget = { printerId: printer.identity.id, routeId: route.id };
  function reportError(source: 'stream' | 'manual', message: string | null) {
    latestErrors.current[source] = message;
    if (shown.current) setError(latestErrors.current.stream ?? latestErrors.current.manual);
  }
  function accept(next: D.PrinterSnapshot) {
    latest.current = latest.current ? { ...next, values: { ...latest.current.values, ...next.values } } : next;
    if (shown.current) setSnapshot(latest.current);
  }
  useEffect(() => {
    if (visible || observeWhileHidden) setStarted(true);
    if (visible) { setSnapshot(latest.current); setError(latestErrors.current.stream ?? latestErrors.current.manual); setCapabilities(latestCapabilities.current); }
  }, [visible, observeWhileHidden]);
  useEffect(() => () => readController.current?.abort(), []);
  useEffect(() => {
    if (!started || !streamKey) return;
    const abort = new AbortController();
    const topics = streamKey.split(',') as [D.StateTopic, ...D.StateTopic[]];
    void (async () => {
      for await (const event of service.observations.watch({ target, topics }, { signal: abort.signal })) {
        if (abort.signal.aborted) return;
        reportError('stream', null);
        accept(event.type === 'snapshot' ? event.snapshot : { target: event.target, configurationRevision: event.configurationRevision, values: event.values });
        const description = await service.describe(target, { signal: abort.signal });
        if (!abort.signal.aborted && description.ok) {
          latestCapabilities.current = description.value.capabilities;
          if (shown.current) setCapabilities(description.value.capabilities);
        }
      }
      if (!abort.signal.aborted) throw new Error('Observation ended');
    })().catch(() => {
      if (!abort.signal.aborted) {
        reportError('stream', 'Printer monitoring is unavailable.');
      }
    });
    return () => abort.abort();
  }, [service, target.printerId, target.routeId, route.configurationRevision, started, streamKey]);
  async function refresh() {
    if (reading.current || !manual.length) return;
    reading.current = true; setRefreshing(true);
    const abort = new AbortController(); readController.current = abort;
    try {
      const result = await service.observations.read({ target, source: 'device', topics: manual as [D.StateTopic, ...D.StateTopic[]] }, { signal: abort.signal });
      if (abort.signal.aborted) return;
      if (result.ok) { accept(result.value); reportError('manual', null); }
      else reportError('manual', 'Unable to refresh. Previously reported readings may be stale.');
    } catch { if (!abort.signal.aborted) reportError('manual', 'Unable to refresh. Previously reported readings may be stale.'); }
    finally { reading.current = false; if (!abort.signal.aborted) setRefreshing(false); }
  }
  return { snapshot, capabilities, error, refreshing, refresh, live: stream.length > 0, liveStatus: stream.includes('status'), canRefresh: manual.length > 0 };
}
