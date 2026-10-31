import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { readSynchronizationSource, validateSynchronizationSource, type SynchronizationKind, type SynchronizationSource } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { loadUserPreferences, usePlatform, type PlatformCapabilities } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, MaterialImportApplication } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { useProjectModal } from '@/components/useProjectModal';
import { useProjectDialogStore } from '@/stores/useProjectDialogStore';
import { useDeviceSelectionStore } from '@/stores/useDeviceSelectionStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { publishRememberedFilamentRack, publishRememberedNozzleCapacities, configurePrinterProjectPreferences } from '@/preferences';
import { publishPrinterTransition, rememberPrinterTransition } from '../settings/configurationActions';
import { historyContextForStructure, readProjectHistoryStatus, runProjectMutationOperation } from '../actions/historyMutation';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { materialImportSources, suggestMaterialMapping, displayedMaterialMatch, pendingMaterialAdditions, type PreparedMaterials } from './materialSynchronization';

export const usePrepareSynchronization = create<{ kind: SynchronizationKind | null }>(() => ({ kind: null }));
export function requestPrepareSynchronization(kind: SynchronizationKind) {
  if (!useProjectDialogStore.getState().open && !usePrepareSynchronization.getState().kind)
    usePrepareSynchronization.setState({ kind });
}
export function synchronizationRoute(printer: D.SavedPrinter, kind: SynchronizationKind) {
  return printer.routes.find(route => route.capabilities.observations.materials.kind === 'supported'
    && (kind === 'filament' || route.capabilities.observations.descriptor.kind === 'supported'));
}

/** Uses exactly the same publication/preference path as an ordinary Printer selection. */
export async function synchronizeProjectPrinter(platform: PlatformCapabilities, source: SynchronizationSource,
  revision: number, confirmModelChange: boolean, scene: SceneInteractionController | null) {
  return runProjectMutationOperation(async () => {
    const checked = await validateSynchronizationSource(platform.printers.service, source);
    if (!checked.ok) throw new Error(checked.error.message);
    if (useDeviceSelectionStore.getState().currentPrinterId !== source.target.printerId)
      throw new Error('The selected device changed. Click Sync again to use the current device.');
    const preferences = await loadUserPreferences(platform.preferences);
    await configurePrinterProjectPreferences(platform.preferences, platform.runtime, false);
    const result = await platform.runtime.synchronizePrinter({ revision, identity: source.identity, tools: source.tools,
      confirmModelChange, rackMemory: preferences.rememberedFilamentRacks ?? {}, bedMemory: preferences.rememberedBedTypes ?? {},
      context: historyContextForStructure(scene) });
    if (!result.ok) return result;
    publishPrinterTransition(platform, result);
    await rememberPrinterTransition(platform, result);
    await publishRememberedNozzleCapacities(platform.preferences, result.profileSnapshot.printer.name,
      { nozzles: source.tools.map((tool, i) => ({ id: i + 1, diameter: tool.diameterMm ?? 0, capacity: tool.capacity })) });
    return result;
  });
}

type Phase = 'reading' | 'choose' | 'confirm-printer' | 'need-printer' | 'continue-filament' | 'filament' | 'error';
export function PrepareSynchronization({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const kind = usePrepareSynchronization(s => s.kind);
  return kind && <SynchronizationDialog key={kind} kind={kind} scene={sceneInteraction}
    onClose={() => usePrepareSynchronization.setState({ kind: null })} />;
}
function SynchronizationDialog({ kind, scene, onClose }: { kind: SynchronizationKind; scene: SceneInteractionController | null; onClose(): void }) {
  const platform = usePlatform(), service = platform.printers.service;
  const currentDevice = useDeviceSelectionStore(s => s.currentPrinterId);
  const [phase, setPhase] = useState<Phase>('reading'), [busy, setBusy] = useState(false);
  const [printers, setPrinters] = useState<readonly D.SavedPrinter[]>([]), [choice, setChoice] = useState('');
  const [source, setSource] = useState<SynchronizationSource | null>(null), [selected, setSelected] = useState<D.SavedPrinter | null>(null);
  const [error, setError] = useState<string | null>(null), [ready, setReady] = useState(false);
  const [prepared, setPrepared] = useState<PreparedMaterials | null>(null), [rack, setRack] = useState<FilamentSessionSnapshot | null>(null);
  const [mode, setMode] = useState<MaterialImportApplication['mode']>('mapping');
  const [mapping, setMapping] = useState<(string | null)[]>([]), [replacements, setReplacements] = useState<(number | null)[]>([]);
  const [appendUnused, setAppendUnused] = useState(true), [colourOnly, setColourOnly] = useState(false);
  const controller = useRef(new AbortController()), initialRevision = useRef<number | null>(null), live = useRef(true);
  const observation = useRef<{ key: string; abort: AbortController } | null>(null);
  const reviewed = useRef({ source, phase }); reviewed.current = { source, phase };
  const visible = phase !== 'reading' || kind === 'filament';
  useProjectModal(visible, '[data-testid="prepare-synchronization-dialog"]');
  function failure(cause: unknown) { if (live.current) { setError(cause instanceof Error ? cause.message : String(cause)); setPhase('error'); setBusy(false); } }
  async function projectRevision() {
    const status = await readProjectHistoryStatus(platform.runtime);
    if (!status) throw new Error('Project history is unavailable.');
    return status.revision;
  }
  async function prepareFilament(next: SynchronizationSource, preserve = false) {
    const snapshot = await platform.runtime.getFilamentSessionSnapshot();
    if (!snapshot.ok) throw new Error(snapshot.error);
    const result = await platform.runtime.prepareMaterialImport({ version: 1, revision: snapshot.revisions.session,
      identity: next.identity, sources: materialImportSources(next) });
    if (!live.current) return;
    if (!result.ok) {
      if (result.errorCode === 'printer_model_mismatch') { setPhase('need-printer'); setError(null); return; }
      throw new Error(result.error);
    }
    const structure = await platform.runtime.getModelStructure();
    if (!live.current) return;
    if (!preserve) {
      setMode(structure.objects.length ? 'mapping' : 'rebuild');
      setMapping(suggestMaterialMapping(next, result, snapshot));
      setReplacements(snapshot.slots.map(() => null));
    } else {
      if (rack && rack.revisions.session !== snapshot.revisions.session) throw new Error('Project materials changed. Cancel and open synchronization again.');
      setMapping(current => current.map(id => result.sources.some(s => s.slotId === id) ? id : null));
    }
    setSource(next); setRack(snapshot); setPrepared(result); setReady(true); setError(null); setPhase('filament');
  }
  async function syncPrinter(next: SynchronizationSource, confirmed = false) {
    setBusy(true);
    try {
      const result = await synchronizeProjectPrinter(platform, next, initialRevision.current ?? await projectRevision(), confirmed, scene);
      if (!live.current) return;
      if (!result.ok) {
        if (result.errorCode === 'printer_model_mismatch') { setPhase('confirm-printer'); setError(result.error); return; }
        throw new Error(result.error);
      }
      setError(null); setPhase('continue-filament');
    } catch (cause) { failure(cause); }
    finally { if (live.current) setBusy(false); }
  }
  async function readDevice(printer: D.SavedPrinter, operation: SynchronizationKind, preserve = false) {
    const route = synchronizationRoute(printer, operation);
    if (!route) throw new Error('This printer does not provide the observations required for synchronization.');
    setBusy(true); setError(null); setSelected(printer);
    await retainSourceObservation(printer, route);
    const result = await readSynchronizationSource(service, printer, route, operation, { signal: controller.current.signal, refresh: preserve });
    if (!live.current || controller.current.signal.aborted) return;
    if (!result.ok) throw new Error(result.error.message);
    setSource(result.value);
    if (operation === 'printer') await syncPrinter(result.value);
    else await prepareFilament(result.value, preserve);
    if (live.current) setBusy(false);
  }
  useEffect(() => {
    const lifetime = new AbortController();
    live.current = true; controller.current = lifetime;
    void (async () => {
      const revision = await projectRevision();
      // StrictMode replays setup after cleanup. A shared live ref becomes true
      // again, so only this setup's own signal can reject its obsolete work.
      if (lifetime.signal.aborted) return;
      initialRevision.current = revision;
      const saved = await service.listSaved();
      if (lifetime.signal.aborted) return;
      if (!saved.ok) throw new Error(saved.error.message);
      const eligible = saved.value.filter(p => synchronizationRoute(p, kind));
      setPrinters(eligible);
      const current = eligible.find(p => p.identity.id === useDeviceSelectionStore.getState().currentPrinterId);
      if (current) for (const route of current.routes) {
        if (!synchronizationRoute({ ...current, routes: [route] }, kind)) continue;
        const cached = await service.observations.read({ target: { printerId: current.identity.id, routeId: route.id }, topics: ['materials'], source: 'cache' });
        if (lifetime.signal.aborted) return;
        const reading = cached.ok && cached.value.values.materials;
        if (reading && reading.kind === 'known' && reading.freshness === 'fresh' && reading.sourceRouteId === route.id
          && cached.ok && cached.value.configurationRevision === route.configurationRevision) {
          await readDevice({ ...current, routes: [route] }, kind); return;
        }
      }
      if (live.current) { setChoice(eligible[0]?.identity.id ?? ''); setPhase('choose'); }
    })().catch(cause => { if (!lifetime.signal.aborted) failure(cause); });
    return () => { live.current = false; lifetime.abort(); };
  }, []);
  // Hold the selected source across reads/review. Revalidating a proposal must
  // not tear down its own sole subscription and thereby disconnect the device.
  async function retainSourceObservation(printer: D.SavedPrinter, route: D.PrinterRoute) {
    const capability = route.capabilities.observations.materials;
    if (capability.kind !== 'supported' || !capability.constraints.delivery.some(d => d === 'push' || d === 'poll')) return;
    const key = JSON.stringify([printer.identity.id, route.id, route.configurationRevision]);
    if (observation.current?.key === key && !observation.current.abort.signal.aborted) return;
    observation.current?.abort.abort();
    const lease = { key, abort: new AbortController() }; observation.current = lease;
    const signal = controller.current.signal, abort = () => lease.abort.abort();
    signal.addEventListener('abort', abort, { once: true });
    const accept = (event: D.PrinterEvent<'materials'>) => {
      const { source: basis, phase: reviewing } = reviewed.current;
      if (!live.current || lease.abort.signal.aborted || !basis || reviewing !== 'filament') return;
      const reading = event.type === 'snapshot' ? event.snapshot.values.materials : event.values.materials;
      if (reading && (reading.kind !== 'known' || reading.freshness !== 'fresh' || reading.sourceRouteId !== basis.target.routeId
        || reading.value.state.inventoryRevision !== basis.inventoryRevision || reading.value.topologyRevision !== basis.topologyRevision)) {
        setReady(false); setError('The source is disconnected or its materials changed. Refresh this device to review the current materials.');
      }
    };
    const stream = service.observations.watch({ target: { printerId: printer.identity.id, routeId: route.id }, topics: ['materials'] }, { signal: lease.abort.signal })[Symbol.asyncIterator]();
    try {
      const first = await stream.next();
      if (first.done) throw new Error('Device observations ended.');
      accept(first.value);
    } catch (cause) { abort(); signal.removeEventListener('abort', abort); observation.current = null; throw cause; }
    void (async () => {
      try {
        while (!lease.abort.signal.aborted) {
          const event = await stream.next();
          if (event.done) { if (!lease.abort.signal.aborted) throw new Error('Device observations ended.'); return; }
          accept(event.value);
        }
      } catch {
        if (live.current && !lease.abort.signal.aborted) { setReady(false); setError('Device disconnected. Your mapping is retained. Refresh after reconnecting.'); }
      } finally {
        signal.removeEventListener('abort', abort);
        if (observation.current === lease) observation.current = null;
        await stream.return?.();
      }
    })();
  }
  useEffect(() => {
    if (phase === 'filament' && source && currentDevice !== source.target.printerId) {
      setReady(false); setError('Device selection changed. Your mapping is retained. Cancel and open synchronization again to use another device.');
    }
  }, [phase, source, currentDevice]);
  async function refresh() {
    if (!selected || !source) return;
    setBusy(true); setReady(false);
    try {
      const saved = await service.listSaved();
      const current = saved.ok && saved.value.find(p => p.identity.id === source.target.printerId);
      const route = current && current.routes.find(r => r.id === source.target.routeId);
      if (!current || !route || route.configurationRevision !== source.configurationRevision) throw new Error('Device configuration changed. Cancel and open synchronization again.');
      await readDevice({ ...current, routes: [route] }, 'filament', true);
    } catch (cause) { if (live.current) setError(String(cause)); }
    finally { if (live.current) setBusy(false); }
  }
  async function apply() {
    if (!source || !prepared || !rack || busy || !ready) return;
    setBusy(true);
    try {
      const result = await useFilamentSessionStore.getState().run(platform.runtime, async () => {
        const checked = await validateSynchronizationSource(service, source);
        if (!checked.ok || useDeviceSelectionStore.getState().currentPrinterId !== source.target.printerId)
          return { ok: false, version: 1, errorCode: 'stale_context', error: checked.ok ? 'Device selection changed. Cancel and open synchronization again.' : checked.error.message };
        return platform.runtime.applyMaterialImport({ version: 1, revision: prepared.revision, identity: source.identity,
          sources: materialImportSources(source), mode, mapping, replacements, appendUnused, colourOnly });
      });
      if (!live.current) return;
      if (!result.ok) { setReady(false); setError(result.error); return; }
      await publishRememberedFilamentRack(platform.preferences, useSettingsStore.getState().selectedPrinter, result.result.snapshot);
      onClose();
    } catch (cause) { if (live.current) setError(String(cause)); }
    finally { if (live.current) setBusy(false); }
  }
  const sources = prepared?.sources ?? [], additions = source && prepared && rack ? pendingMaterialAdditions(source, prepared, rack, mapping, colourOnly) : [];
  const invalidReplacement = mode === 'rebuild' && !!rack && !!prepared && prepared.references.some((r, i) => i >= sources.length && r.kinds.length && (!replacements[i] || replacements[i]! > sources.length));
  const unresolved = mode === 'rebuild' ? sources.some((s, i) => !displayedMaterialMatch(prepared!, s.slotId, i)?.preset) || !sources.length
    : mapping.some((id, i) => id && !displayedMaterialMatch(prepared!, id, i)?.preset);
  if (!visible) return null;
  const label = (id: string) => source?.materials.find(s => s.slotId === id)?.label ?? id;
  const colorLabel = (id: string) => {
    const color = source?.materials.find(s => s.slotId === id)?.metadata?.color;
    return color ? color.kind === 'solid' ? color.rgba : color.rgba.join(' / ') : 'Keep project color';
  };
  const matchLabel = (id: string, i: number) => { const m = displayedMaterialMatch(prepared!, id, i); return <><span>{m?.preset ?? 'No compatible preset'}</span>{m?.warning && <span className="block text-xs text-amber-700">{m.warning}</span>}</>; };
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" data-testid="prepare-synchronization-dialog" role="dialog" aria-modal="true" aria-labelledby="prepare-sync-title">
    <div className="flex max-h-[90vh] w-full max-w-3xl flex-col gap-4 overflow-hidden rounded-lg border bg-card p-5 shadow-lg">
      <h2 id="prepare-sync-title" className="font-semibold">{phase === 'filament' || kind === 'filament' && !['need-printer', 'confirm-printer', 'continue-filament'].includes(phase) ? 'Sync Filament' : 'Sync Printer'}</h2>
      {(source || selected) && <p className="text-sm font-medium">{(source?.identity ?? selected!.identity).displayName} · {(source?.identity ?? selected!.identity).model ?? 'Model not reported'}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {phase === 'reading' && <p role="status">Reading device materials…</p>}
      {phase === 'choose' && <><label>Device <select className="rounded border bg-background p-2" aria-label="Synchronization device" value={choice} disabled={busy} onChange={e => setChoice(e.target.value)}>
        {printers.map(p => <option key={p.identity.id} value={p.identity.id}>{p.identity.displayName}</option>)}</select></label>
        {!printers.length && <p>No saved device supports this synchronization. Add a device in Device first.</p>}
        <Button disabled={!choice || busy} onClick={() => {
          const printer = printers.find(p => p.identity.id === choice)!;
          useDeviceSelectionStore.getState().selectPrinter(printer.identity.id);
          setPhase('reading'); void readDevice(printer, kind).catch(failure);
        }}>Connect and sync</Button></>}
      {phase === 'confirm-printer' && <><p>Switch the project Printer to match this device?</p><Button disabled={busy} onClick={() => source && void syncPrinter(source, true)}>Switch Printer and sync</Button></>}
      {phase === 'need-printer' && <><p>The project Printer does not match this device. Synchronize Printer first?</p><Button disabled={busy} onClick={() => selected && void (async () => { initialRevision.current = await projectRevision(); await readDevice(selected, 'printer'); })().catch(failure)}>Sync Printer first</Button></>}
      {phase === 'continue-filament' && <><p>Printer synchronized. Continue with Filament sync?</p><Button disabled={busy} onClick={() => selected && void readDevice(selected, 'filament').catch(failure)}>Continue to Filament sync</Button></>}
      {phase === 'filament' && prepared && rack && source && <div className="min-h-0 flex-1 space-y-4 overflow-auto">
        <div className="flex flex-wrap items-center gap-4 text-sm"><label>Mode <select aria-label="Filament sync mode" className="rounded border bg-background p-1" disabled={busy} value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="mapping">Update project mapping</option><option value="rebuild">Rebuild from device</option></select></label>
          <label><input type="checkbox" checked={colourOnly} disabled={busy} onChange={e => setColourOnly(e.target.checked)} /> Colors only</label>
          {mode === 'mapping' && <label><input type="checkbox" checked={appendUnused} disabled={busy} onChange={e => setAppendUnused(e.target.checked)} /> Append unused device materials</label>}
          <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>Refresh device</Button></div>
        <p className="text-xs text-muted-foreground">Changes affect materials on every Plate. Empty and unknown slots can contain retained metadata; Send checks the loaded material separately.</p>
        <div className="max-h-40 overflow-auto rounded border p-2 text-xs" aria-label="Device materials">{source.materials.map(s => <div key={s.slotId} className="flex justify-between gap-4 py-1"><span>{s.label}</span><span>{s.metadata ? s.metadata.materialType ?? 'Material type not reported' : 'No material metadata'} · {s.presence} · {colorLabel(s.slotId)}{!s.toolIndices.length ? ' · No usable tool path' : ''}</span></div>)}</div>
        <table className="w-full text-left text-sm"><thead><tr><th>{mode === 'mapping' ? 'Project material' : 'Device material'}</th><th>{mode === 'mapping' ? 'Device source' : 'Result'}</th></tr></thead><tbody>
          {mode === 'mapping' ? rack.slots.map((slot, i) => <tr key={slot.logicalId}><td className="border-t p-2">{slot.slot}. {slot.preset.label}</td><td className="border-t p-2"><select className="w-full rounded border bg-background p-1" aria-label={`Source for material ${slot.slot}`} disabled={busy} value={mapping[i] ?? ''} onChange={e => setMapping(m => m.map((id, index) => index === i ? e.target.value || null : id))}><option value="">Keep unchanged</option>{sources.map(s => <option key={s.slotId} value={s.slotId}>{label(s.slotId)}</option>)}</select>{mapping[i] && <><p className="mt-1 text-xs">Color: {colorLabel(mapping[i]!)}</p>{!colourOnly && matchLabel(mapping[i]!, i)}</>}</td></tr>)
            : sources.map((s, i) => <tr key={s.slotId}><td className="border-t p-2">{label(s.slotId)}</td><td className="border-t p-2">{colourOnly && rack.slots[i] ? rack.slots[i].preset.label : matchLabel(s.slotId, i)}<p className="text-xs">Color: {colorLabel(s.slotId)}</p></td></tr>)}
        </tbody></table>
        {mode === 'mapping' && appendUnused && <p className="text-sm" data-testid="sync-additions">Additions: {additions.length ? additions.map(label).join(', ') : 'None'}</p>}
        {mode === 'rebuild' && rack.slots.slice(sources.length).map((slot, offset) => {
          const i = offset + sources.length, refs = prepared.references[i]?.kinds ?? [];
          return <label key={slot.logicalId} className="block rounded border p-2 text-sm">Remove material {slot.slot} · {refs.length ? refs.join(', ') : 'No project references'}
            {refs.length > 0 && <select aria-label={`Replacement for material ${slot.slot}`} className="ml-2 rounded border bg-background p-1" disabled={busy} value={replacements[i] ?? ''} onChange={e => setReplacements(current => current.map((n, j) => i === j ? Number(e.target.value) || null : n))}><option value="">Choose surviving replacement</option>{sources.map((s, j) => <option key={s.slotId} value={j + 1}>{j + 1}. {label(s.slotId)}</option>)}</select>}</label>;
        })}
      </div>}
      <div className="flex shrink-0 justify-end gap-2">
        {phase === 'filament' && <Button disabled={busy || !ready || invalidReplacement || unresolved} onClick={() => void apply()}>Apply Filament sync</Button>}
        <Button variant="ghost" disabled={busy} onClick={onClose}>{phase === 'continue-filament' ? 'Done' : 'Cancel'}</Button>
      </div>
    </div>
  </div>;
}
