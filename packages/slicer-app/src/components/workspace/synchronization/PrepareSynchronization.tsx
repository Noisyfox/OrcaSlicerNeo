import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { readSynchronizationSource, validateSynchronizationSource, type SynchronizationKind, type SynchronizationSource } from '@orca/printer-control';
import type * as D from '@orca/printer-control/domain';
import { loadUserPreferences, usePlatform, type PlatformCapabilities } from '@orca/platform-contract';
import type { FilamentSessionSnapshot, MaterialImportApplication } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { FilamentSwatch } from '../FilamentSwatch';
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
function SynchronizationSelect({ label, value, options, disabled, onChange, id }: {
  label: string; value: string; options: { value: string; label: string }[]; disabled: boolean; onChange(value: string): void; id?: string;
}) {
  return <Select value={value} items={options} disabled={disabled} onValueChange={next => onChange(next ?? '')}>
    <SelectTrigger id={id} aria-label={label} className="w-full min-w-0"><SelectValue className="truncate" /></SelectTrigger>
    <SelectContent align="start"><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select>;
}
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
          sources: materialImportSources(source), mode, mapping, replacements, appendUnused: appendUnused && !colourOnly, colourOnly });
      });
      if (!live.current) return;
      if (!result.ok) { setReady(false); setError(result.error); return; }
      await publishRememberedFilamentRack(platform.preferences, useSettingsStore.getState().selectedPrinter, result.result.snapshot);
      onClose();
    } catch (cause) { if (live.current) setError(String(cause)); }
    finally { if (live.current) setBusy(false); }
  }
  const sources = prepared?.sources ?? [], additions = source && prepared && rack ? pendingMaterialAdditions(source, prepared, rack, mapping, colourOnly) : [];
  const rebuildSources = colourOnly && rack ? sources.slice(0, rack.slots.length) : sources;
  const invalidReplacement = !colourOnly && mode === 'rebuild' && !!rack && !!prepared && prepared.references.some((r, i) => i >= sources.length && r.kinds.length && (!replacements[i] || replacements[i]! > sources.length));
  const unresolved = !sources.length || (mode === 'rebuild' ? rebuildSources.some((s, i) => !displayedMaterialMatch(prepared!, s.slotId, i)?.preset)
    : mapping.some((id, i) => id && !displayedMaterialMatch(prepared!, id, i)?.preset));
  if (!visible) return null;
  const label = (id: string) => source?.materials.find(s => s.slotId === id)?.label ?? id;
  const colorLabel = (id: string) => {
    const color = source?.materials.find(s => s.slotId === id)?.metadata?.color;
    return color ? color.kind === 'solid' ? color.rgba : color.rgba.join(' / ') : 'Keep project color';
  };
  const sourceOptions = sources.map(s => ({ value: s.slotId, label: label(s.slotId) }));
  const matchLabel = (id: string, i: number) => {
    const match = displayedMaterialMatch(prepared!, id, i);
    return <div className="space-y-1"><p>{match?.preset ?? 'No compatible preset'}</p>
      {match?.warning && <p className="text-xs text-muted-foreground">{match.warning}</p>}</div>;
  };
  const materialColor = (id: string) => {
    const color = source?.materials.find(s => s.slotId === id)?.metadata?.color;
    return <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      {color && (color.kind === 'solid' || color.rgba.length > 0) && <FilamentSwatch className="size-4 shrink-0 rounded-sm border" display={{
        mode: color.kind === 'solid' ? 'solid' : color.appearance === 'gradient' ? 'gradient' : 'multicolor',
        colors: color.kind === 'solid' ? [color.rgba] : [...color.rgba],
      }} />}{colorLabel(id)}</span>;
  };
  const filamentReview = phase === 'filament' && prepared && rack && source;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent data-testid="prepare-synchronization-dialog" className={`flex max-h-[85vh] flex-col ${filamentReview ? 'w-[min(95vw,56rem)] max-w-none' : 'w-[min(95vw,28rem)]'}`}>
      <DialogHeader>
        <DialogTitle>{phase === 'filament' || kind === 'filament' && !['need-printer', 'confirm-printer', 'continue-filament'].includes(phase) ? 'Sync Filament' : 'Sync Printer'}</DialogTitle>
        <DialogDescription>{(source || selected) ? <>{(source?.identity ?? selected!.identity).displayName} · {(source?.identity ?? selected!.identity).model ?? 'Model not reported'}</> : 'Synchronize project settings from a connected device.'}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto text-xs/relaxed">
        {error && <Alert variant={phase === 'confirm-printer' ? 'default' : 'destructive'}><AlertDescription>{error}</AlertDescription></Alert>}
        {phase === 'reading' && <p role="status" className="text-muted-foreground">Reading device materials…</p>}
        {phase === 'choose' && <Field>
          <FieldLabel htmlFor="synchronization-device">Device</FieldLabel>
          <SynchronizationSelect id="synchronization-device" label="Synchronization device" value={choice} disabled={busy}
            options={printers.map(p => ({ value: p.identity.id, label: p.identity.displayName }))} onChange={setChoice} />
          {!printers.length && <p className="text-muted-foreground">No saved device supports this synchronization. Add a device in Device first.</p>}
        </Field>}
        {phase === 'confirm-printer' && <p>Switch the project Printer to match this device?</p>}
        {phase === 'need-printer' && <p>The project Printer does not match this device. Synchronize Printer first?</p>}
        {phase === 'continue-filament' && <p>Printer synchronized. Continue with Filament sync?</p>}
        {filamentReview && <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Field orientation="horizontal" className="w-full sm:w-auto">
              <FieldLabel htmlFor="filament-sync-mode" className="flex-none">Mode</FieldLabel>
              <div className="min-w-0 flex-1 sm:w-52 sm:flex-none"><SynchronizationSelect id="filament-sync-mode" label="Filament sync mode" value={mode} disabled={busy}
                options={[{ value: 'mapping', label: 'Update project mapping' }, { value: 'rebuild', label: 'Rebuild from device' }]}
                onChange={value => setMode(value as typeof mode)} /></div>
            </Field>
            <Button variant="secondary" disabled={busy} onClick={() => void refresh()}>Refresh device</Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Field orientation="horizontal" className="w-auto"><Checkbox id="filament-sync-colors" checked={colourOnly} disabled={busy} onCheckedChange={setColourOnly} /><FieldLabel htmlFor="filament-sync-colors">Colors only</FieldLabel></Field>
            {mode === 'mapping' && <Field orientation="horizontal" className="w-auto"><Checkbox id="filament-sync-append" checked={appendUnused && !colourOnly} disabled={busy || colourOnly} onCheckedChange={setAppendUnused} /><FieldLabel htmlFor="filament-sync-append">Append unused device materials</FieldLabel></Field>}
          </div>
          <p className="text-muted-foreground">Changes affect materials on every Plate. Empty and unknown slots can contain retained metadata; Send checks the loaded material separately.</p>
          <section aria-label="Device materials" className="space-y-2">
            <h3 className="font-medium">Device materials</h3>
            <div className="max-h-40 overflow-y-auto rounded-md border">
              <Table><TableHeader className="sticky top-0 bg-card"><TableRow className="hover:bg-transparent"><TableHead>Source</TableHead><TableHead>Material</TableHead><TableHead>Presence</TableHead><TableHead>Color</TableHead></TableRow></TableHeader>
                <TableBody>{source.materials.map(s => <TableRow key={s.slotId} className="hover:bg-transparent">
                  <TableCell className="whitespace-normal">{s.label}{!s.toolIndices.length && <p className="text-muted-foreground">No usable tool path</p>}</TableCell>
                  <TableCell>{s.metadata ? s.metadata.materialType || 'Material type not reported' : 'No material metadata'}{!sources.some(p => p.slotId === s.slotId) && <p className="text-muted-foreground">Not eligible for synchronization</p>}</TableCell>
                  <TableCell><Badge variant="secondary">{s.presence}</Badge></TableCell><TableCell>{materialColor(s.slotId)}</TableCell>
                </TableRow>)}</TableBody>
              </Table>
            </div>
          </section>
          <section aria-label="Material synchronization mapping" className="space-y-2">
            <h3 className="font-medium">{mode === 'mapping' ? 'Project material mapping' : 'Materials to import'}</h3>
            <div className="rounded-md border"><Table className="table-fixed">
              <TableHeader><TableRow className="hover:bg-transparent"><TableHead className="w-2/5">{mode === 'mapping' ? 'Project material' : 'Device material'}</TableHead><TableHead>{mode === 'mapping' ? 'Device source' : 'Result'}</TableHead></TableRow></TableHeader>
              <TableBody>{mode === 'mapping' ? rack.slots.map((slot, i) => <TableRow key={slot.logicalId} className="hover:bg-transparent">
                <TableCell className="align-top whitespace-normal"><span className="inline-flex items-center gap-2"><FilamentSwatch display={slot.colour.display} className="size-4 shrink-0 rounded-sm border" />{slot.slot}. {slot.preset.label}</span></TableCell>
                <TableCell className="space-y-2 align-top whitespace-normal"><SynchronizationSelect label={`Source for material ${slot.slot}`} value={mapping[i] ?? ''} disabled={busy}
                  options={[{ value: '', label: 'Keep unchanged' }, ...sourceOptions]}
                  onChange={value => setMapping(current => current.map((id, index) => index === i ? value || null : id))} />
                  {mapping[i] && <>{materialColor(mapping[i]!)}{!colourOnly && matchLabel(mapping[i]!, i)}</>}
                </TableCell>
              </TableRow>) : rebuildSources.map((s, i) => <TableRow key={s.slotId} className="hover:bg-transparent">
                <TableCell className="align-top whitespace-normal">{label(s.slotId)}</TableCell>
                <TableCell className="space-y-2 align-top whitespace-normal">{colourOnly && rack.slots[i] ? rack.slots[i].preset.label : matchLabel(s.slotId, i)}{materialColor(s.slotId)}</TableCell>
              </TableRow>)}</TableBody>
            </Table></div>
          </section>
          {mode === 'mapping' && appendUnused && !colourOnly && <p className="text-muted-foreground" data-testid="sync-additions">Additions: {additions.length ? additions.map(label).join(', ') : 'None'}</p>}
          {mode === 'rebuild' && !colourOnly && rack.slots.slice(sources.length).map((slot, offset) => {
            const i = offset + sources.length, refs = prepared.references[i]?.kinds ?? [];
            return <Field key={slot.logicalId} className="rounded-md border p-3">
              <FieldLabel htmlFor={`sync-replacement-${slot.slot}`}>Remove material {slot.slot}</FieldLabel>
              <p className="text-muted-foreground">{refs.length ? refs.join(', ') : 'No project references'}</p>
              {refs.length > 0 && <SynchronizationSelect id={`sync-replacement-${slot.slot}`} label={`Replacement for material ${slot.slot}`} value={String(replacements[i] ?? '')} disabled={busy}
                options={[{ value: '', label: 'Choose surviving replacement' }, ...sources.map((s, j) => ({ value: String(j + 1), label: `${j + 1}. ${label(s.slotId)}` }))]}
                onChange={value => setReplacements(current => current.map((n, j) => i === j ? Number(value) || null : n))} />}
            </Field>;
          })}
        </>}
      </div>
      <DialogFooter className="shrink-0">
        <Button variant="ghost" disabled={busy} onClick={onClose}>{phase === 'continue-filament' ? 'Done' : 'Cancel'}</Button>
        {phase === 'choose' && <Button disabled={!choice || busy} onClick={() => {
          const printer = printers.find(p => p.identity.id === choice)!;
          useDeviceSelectionStore.getState().selectPrinter(printer.identity.id);
          setPhase('reading'); void readDevice(printer, kind).catch(failure);
        }}>Connect and sync</Button>}
        {phase === 'confirm-printer' && <Button disabled={busy} onClick={() => source && void syncPrinter(source, true)}>Switch Printer and sync</Button>}
        {phase === 'need-printer' && <Button disabled={busy} onClick={() => selected && void (async () => { initialRevision.current = await projectRevision(); await readDevice(selected, 'printer'); })().catch(failure)}>Sync Printer first</Button>}
        {phase === 'continue-filament' && <Button disabled={busy} onClick={() => selected && void readDevice(selected, 'filament').catch(failure)}>Continue to Filament sync</Button>}
        {phase === 'filament' && <Button disabled={busy || !ready || invalidReplacement || unresolved} onClick={() => void apply()}>Apply Filament sync</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
