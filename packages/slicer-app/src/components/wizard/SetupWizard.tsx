import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlatformCapabilities } from '@orca/platform-contract';
import { loadUserPreferences } from '@orca/platform-contract';
import type { ProfileActivation, SetupWizardCatalogue } from '@slicer/client';
import { LoaderCircle, Printer } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel, FieldGroup, FieldSet, FieldLegend } from '@/components/ui/field';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { createWizardCatalogueSession } from './setupWizardCatalogueSession';
import { completeSetupWizard, retrySetupWizardApplication, type SetupCompletionResult } from './setupWizardCompletion';
import { activationFromSelection, checkDefaultFilaments, checkedFilaments, eligibleFilaments, filamentKey,
  modelKey, printerMatches, visibleFilaments, wizardModels, type FilamentFilters } from './setupWizardSelection';

interface Props { platform: PlatformCapabilities; mandatory: boolean;
  onApplied: (result: Extract<SetupCompletionResult, { ok: true }>) => Promise<void>; onClose: () => void }
const emptyActivation: ProfileActivation = { models: [], filaments: [] };
const emptyFilters: FilamentFilters = { model: '', type: '', manufacturer: '', text: '' };

function Filter({ label, value, options, onChange, disabled }: { label: string; value: string;
  options: Array<{ label: string; value: string }>; disabled: boolean; onChange: (value: string) => void }) {
  const items = [{ label: `All ${label.toLowerCase()}`, value: '' }, ...options];
  return <Field><FieldLabel>{label}</FieldLabel><Select disabled={disabled} items={items} value={value} onValueChange={value => onChange(value ?? '')}>
    <SelectTrigger aria-label={label} className="w-full"><SelectValue /></SelectTrigger>
    <SelectContent><SelectGroup>{items.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
  </Select></Field>;
}

/** One mount owns one temporary catalogue, activation draft and image URL set. */
export function SetupWizard({ platform, mandatory, onApplied, onClose }: Props) {
  const [loadAttempt, setLoadAttempt] = useState(0);
  const appliedReceipt = useRef<Extract<SetupCompletionResult, { ok: true }> | null>(null);
  const [catalogue, setCatalogue] = useState<SetupWizardCatalogue | null>(null);
  const [original, setOriginal] = useState<ProfileActivation>(emptyActivation);
  const [models, setModels] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const [images, setImages] = useState<Record<string, string>>({});
  const [page, setPage] = useState<'printer' | 'filament'>('printer');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(emptyFilters);
  const [phase, setPhase] = useState<'loading' | 'selection' | 'applying' | 'retry' | 'publication-retry' | 'closing'>('loading');
  const [error, setError] = useState<string | null>(null);
  const operation = useRef(false);
  const urls = useRef<string[]>([]);
  const closed = useRef(false);
  const sessionRef = useRef<ReturnType<typeof createWizardCatalogueSession> | null>(null);
  const canCancel = !mandatory && phase === 'selection';

  useEffect(() => {
    let disposed = false;
    const session = createWizardCatalogueSession(platform.runtime);
    sessionRef.current = session;
    void (async () => {
      try {
        const preferences = await loadUserPreferences(platform.preferences);
        if (disposed) return;
        const result = await session.open();
        if (!result.ok) throw new Error(result.error);
        if (disposed) { await session.close(); return; }
        const activation = preferences.profileActivation ?? emptyActivation;
        setCatalogue(result.catalogue); setOriginal(activation);
        setModels(new Set(activation.models.map(modelKey)));
        setGroups(checkedFilaments(result.catalogue.filaments, activation));
        setPhase('selection');
        // Covers may belong to unlinked vendors; raw resources remain in /profiles.
        for (const model of wizardModels(result.catalogue)) {
          if (!model.image) continue;
          try {
            const bytes = await platform.runtime.readFilesystemFile(model.image);
            if (disposed) return;
            const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: model.image.endsWith('.svg') ? 'image/svg+xml' : 'image/png' }));
            urls.current.push(url); setImages(current => ({ ...current, [modelKey(model)]: url }));
          } catch { /* Missing vendor covers use the standard printer placeholder. */ }
        }
      } catch (error) { if (!disposed) { setError(String(error)); setPhase('selection'); } }
    })();
    return () => {
      disposed = true;
      urls.current.forEach(url => URL.revokeObjectURL(url)); urls.current = [];
      if (!closed.current) void session.close().catch(() => undefined);
    };
  }, [platform, loadAttempt]);
  const allModels = useMemo(() => catalogue ? wizardModels(catalogue) : [], [catalogue]);
  const selected = allModels.filter(model => models.has(modelKey(model)));
  const activation = catalogue ? activationFromSelection(catalogue, original, models, groups) : emptyActivation;
  const eligible = catalogue ? eligibleFilaments(catalogue, activation.models) : [];
  const visible = visibleFilaments(eligible, filters, activation.models, groups);
  const displayedModels = allModels.filter(model => printerMatches(model, search));
  const vendors = [...new Set(displayedModels.map(model => model.vendor))];
  const toggle = (set: Set<string>, keys: string[], checked: boolean) => {
    const next = new Set(set); keys.forEach(key => checked ? next.add(key) : next.delete(key)); return next;
  };
  const close = async () => {
    if (!canCancel || operation.current) return;
    operation.current = true; setPhase('closing');
    const result = await sessionRef.current!.close().catch(error => ({ ok: false as const, error: String(error) }));
    operation.current = false;
    if (!result.ok) { setError(result.error); setPhase('selection'); return; }
    closed.current = true; onClose();
  };
  const finish = async () => {
    if (!catalogue || operation.current || (!selected.length || !eligible.some(group => groups.has(filamentKey(group))))) return;
    operation.current = true; const retry = phase === 'retry'; setPhase('applying'); setError(null);
    const result = appliedReceipt.current ?? (retry ? await retrySetupWizardApplication(platform.runtime)
      : await completeSetupWizard(platform.runtime, platform.preferences, activation));
    if (!result.ok) { operation.current = false; setError(result.error); setPhase(result.phase === 'apply' ? 'retry' : 'selection'); return; }
    // Apply has committed. Keep the modal locked through renderer publication and close.
    appliedReceipt.current = result;
    try {
      await onApplied(result);
      const closeResult = await sessionRef.current!.close();
      if (!closeResult.ok) throw new Error(closeResult.error);
      closed.current = true; onClose();
    } catch (error) { setError(String(error)); setPhase('publication-retry'); }
    finally { operation.current = false; }
  };
  const disabled = phase !== 'selection';
  return <Dialog open onOpenChange={(open, details) => {
    if (!open && details.reason === 'escape-key' && canCancel) void close();
  }}>
    <DialogContent data-testid="setup-wizard" className="setup-wizard flex max-w-4xl flex-col overflow-hidden">
      <DialogHeader><DialogTitle>Setup Wizard</DialogTitle><DialogDescription>
        {page === 'printer' ? '1. Select your printer models' : '2. Select your filaments'}
      </DialogDescription></DialogHeader>
      {error && <Alert variant="destructive"><AlertDescription data-testid="setup-error">{error}</AlertDescription></Alert>}
      {!catalogue && phase === 'selection' && <Button onClick={() => { setError(null); setPhase('loading'); setLoadAttempt(attempt => attempt + 1); }}>Retry Load</Button>}
      {phase === 'loading' ? <div role="status" className="flex flex-1 items-center justify-center gap-2"><LoaderCircle className="size-4 animate-spin" />Loading profiles…</div> :
        <fieldset disabled={disabled} className="flex min-h-0 flex-1 flex-col gap-3">
          {page === 'printer' ? <>
            <FieldGroup><Field><FieldLabel htmlFor="setup-printer-search">Search printers</FieldLabel><Input disabled={disabled} id="setup-printer-search" value={search} onChange={event => setSearch(event.target.value)} /></Field></FieldGroup>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto" data-testid="setup-printers">
              {vendors.map(vendor => <FieldSet key={vendor} className="gap-2"><FieldLegend>{vendor}</FieldLegend>
                <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setModels(toggle(models, displayedModels.filter(model => model.vendor === vendor).map(modelKey), true))}>Select visible {vendor}</Button>
                  <Button variant="outline" size="sm" onClick={() => setModels(toggle(models, displayedModels.filter(model => model.vendor === vendor).map(modelKey), false))}>Deselect visible {vendor}</Button></div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{displayedModels.filter(model => model.vendor === vendor).map(model => {
                  const key = modelKey(model), id = `setup-model-${encodeURIComponent(key)}`;
                  return <Card key={key} size="sm"><CardHeader><CardTitle>{model.name}</CardTitle></CardHeader><CardContent>
                    {images[key] ? <img src={images[key]} alt="" className="mx-auto h-24 max-w-full object-contain" /> : <Printer className="mx-auto size-24 text-muted-foreground" />}
                  </CardContent><CardFooter className="flex-col items-start gap-2"><Field orientation="horizontal"><Checkbox disabled={disabled} id={id} checked={models.has(key)} onCheckedChange={checked => setModels(toggle(models, [key], checked))} /><FieldLabel htmlFor={id}>{model.name}</FieldLabel></Field>
                    <span className="text-muted-foreground">Nozzles: {model.nozzle_diameter.join(', ')} mm</span></CardFooter></Card>;
                })}</div></FieldSet>)}
              {!displayedModels.length && <p className="text-muted-foreground">No matching printers.</p>}
            </div>
          </> : <>
            <FieldGroup className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Filter disabled={disabled} label="Models" value={filters.model} options={selected.map(model => ({ label: model.name, value: modelKey(model) }))} onChange={model => setFilters(current => ({ ...current, model }))} />
              <Filter disabled={disabled} label="Types" value={filters.type} options={[...new Set(eligible.map(group => group.type))].sort().map(value => ({ label: value, value }))} onChange={type => setFilters(current => ({ ...current, type }))} />
              <Filter disabled={disabled} label="Manufacturers" value={filters.manufacturer} options={[...new Set(eligible.map(group => group.vendor))].sort().map(value => ({ label: value, value }))} onChange={manufacturer => setFilters(current => ({ ...current, manufacturer }))} />
              <Field><FieldLabel htmlFor="setup-filament-search">Search filaments</FieldLabel><Input disabled={disabled} id="setup-filament-search" value={filters.text} onChange={event => setFilters(current => ({ ...current, text: event.target.value }))} /></Field>
            </FieldGroup>
            <div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => setGroups(toggle(groups, visible.map(filamentKey), true))}>Select All</Button><Button variant="outline" size="sm" onClick={() => setGroups(toggle(groups, visible.map(filamentKey), false))}>Deselect All</Button></div>
            <FieldSet className="min-h-0 flex-1 overflow-y-auto"><FieldLegend>Filaments</FieldLegend><FieldGroup className="gap-2">{visible.map(group => {
              const key = filamentKey(group), id = `setup-filament-${encodeURIComponent(key)}`;
              return <Field key={key} orientation="horizontal" className="rounded-md border p-2"><Checkbox disabled={disabled} id={id} checked={groups.has(key)} onCheckedChange={checked => setGroups(toggle(groups, [key], checked))} /><FieldLabel htmlFor={id} className="min-w-0"><span className="truncate">{group.name}</span><span className="ml-auto shrink-0 text-muted-foreground">{group.vendor} · {group.type}</span></FieldLabel></Field>;
            })}{!visible.length && <p className="text-muted-foreground">No matching filaments.</p>}</FieldGroup></FieldSet>
          </>}
        </fieldset>}
      <DialogFooter>
        {mandatory && platform.chrome.kind === 'desktop' && <Button variant="outline" onClick={async () => {
          try { await platform.menu.execute('quit'); } catch (error) { setError(String(error)); }
        }}>Exit</Button>}
        {!mandatory && <Button variant="outline" disabled={!canCancel} onClick={() => void close()}>Cancel</Button>}
        {page === 'filament' && <Button variant="outline" disabled={disabled} onClick={() => setPage('printer')}>Back</Button>}
        {page === 'printer' ? <Button disabled={disabled || selected.length === 0} onClick={() => {
          setGroups(checkDefaultFilaments(eligible, selected, groups)); setPage('filament'); setFilters(emptyFilters);
        }}>Next</Button> : <Button disabled={(phase !== 'selection' && phase !== 'retry' && phase !== 'publication-retry') || !eligible.some(group => groups.has(filamentKey(group)))} onClick={() => void finish()}>
          {phase === 'applying' && <LoaderCircle data-icon="inline-start" className="animate-spin" />}{phase === 'publication-retry' ? 'Retry Complete' : phase === 'retry' ? 'Retry Apply' : phase === 'applying' ? 'Applying…' : 'Finish'}
        </Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
