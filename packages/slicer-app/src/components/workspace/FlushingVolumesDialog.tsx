import { useEffect, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { FilamentSessionSlot, FlushingVolumesSnapshot } from '@slicer/client';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { readFlushingVolumes } from '@/stores/useFilamentSessionStore';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel, FieldDescription } from '@/components/ui/field';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from '@/components/ui/select';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FilamentSwatch } from './FilamentSwatch';

export function displayedFlushVolume(raw: number, ratio: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, Math.round(raw * ratio)));
}

export function rawFlushVolume(display: number, ratio: number): number {
  return ratio === 0 ? 0 : Math.round(display / ratio);
}

export function flushingModified(editor: FlushingVolumesSnapshot): boolean {
  return editor.multipliers.some(value => value !== 1) || editor.matrix.some((value, i) => value !== editor.defaults[i]);
}

function MaterialHeader({ slot }: { slot: FilamentSessionSlot }) {
  return <span className="inline-flex items-center gap-1" title={slot.preset.label}>
    <FilamentSwatch display={slot.colour.display} className="size-4 rounded-sm border" />{slot.slot}
  </span>;
}

export function FlushingVolumesDialog({ onClose }: { onClose: () => void }) {
  const { runtime } = usePlatform();
  const current = useFilamentSessionStore(s => s.snapshot);
  const run = useFilamentSessionStore(s => s.run);
  const [editor, setEditor] = useState<FlushingVolumesSnapshot | null>(null);
  const [slots, setSlots] = useState<readonly FilamentSessionSlot[]>([]);
  const [matrix, setMatrix] = useState<number[]>([]);
  const [multipliers, setMultipliers] = useState<number[]>([]);
  const [plane, setPlane] = useState(0);
  const [inputEpoch, setInputEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invalidInputs, setInvalidInputs] = useState<Set<string>>(new Set());
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = await readFlushingVolumes(runtime);
      if (!active) return;
      if (!result.ok) { setError(result.error); return; }
      setSlots(result.slots); setEditor(result); setMatrix([...result.matrix]); setMultipliers([...result.multipliers]);
    })().catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [runtime]);
  const stale = editor !== null && current?.revisions.session !== editor.revision;
  const n = editor?.dimension ?? 0;
  const ratio = multipliers[plane] ?? 1;
  const options = Array.from({ length: editor?.planes ?? 0 }, (_, i) => ({ value: String(i), label:
    editor?.planes === 2 ? (i === 0 ? 'Left extruder' : 'Right extruder') : `Extruder ${i + 1}` }));
  function validateInput(key: string, value: string, valid: boolean) {
    setInvalidInputs(previous => { const next = new Set(previous); if (!value.trim() || !valid) next.add(key); else next.delete(key); return next; });
  }
  async function recalculate() {
    if (!editor || stale) return;
    setBusy(true); setError(null);
    try {
      const result = await readFlushingVolumes(runtime, editor.revision);
      if (!result.ok) { setError(result.error); return; }
      setMatrix(previous => previous.map((value, i) => Math.floor(i / (n * n)) === plane ? result.defaults[i] : value));
      setInputEpoch(previous => previous + 1);
      setInvalidInputs(previous => new Set([...previous].filter(key => key === 'multiplier' || Math.floor(Number(key) / (n * n)) !== plane)));
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  async function save() {
    if (!editor || stale || invalidInputs.size) return;
    setBusy(true); setError(null);
    try {
      // Keep the editor's captured revision: a queued concurrent edit must
      // reject this draft rather than silently applying it to a changed rack.
      const result = await run(runtime, () => runtime.setFlushingVolumes({ version: 1, revision: editor.revision, matrix, multipliers }));
      if (result.ok) onClose(); else setError(result.error);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="flex max-h-[85vh] w-[min(95vw,56rem)] max-w-none flex-col" data-testid="flushing-volumes-dialog">
      <DialogHeader><DialogTitle>Flushing volumes</DialogTitle>
        <DialogDescription>Flushing volume (mm³) for each filament pair. Rows are From; columns are To.</DialogDescription>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">Automatic calculation follows All / Color / None in Preferences. Re-calculate updates this draft; OK applies it to the project.</p>
      {(error || stale) && <Alert variant="destructive"><AlertDescription>{stale ? 'Materials or project settings changed. Close and reopen this dialog before applying changes.' : error}</AlertDescription></Alert>}
      {!editor && !error && <p role="status">Loading flushing volumes…</p>}
      {editor && <>
        <div className="flex items-center justify-between gap-2">
          {editor.planes > 1 && <Select value={String(plane)} items={options} onValueChange={value => setPlane(Number(value))} disabled={busy}>
            <SelectTrigger aria-label="Extruder" className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectGroup>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>}
          <Button variant="secondary" disabled={busy || stale} onClick={() => void recalculate()} data-testid="flushing-recalculate">Re-calculate</Button>
        </div>
        <div className="min-h-0 overflow-auto rounded border flushing-volume-table">
          <Table><TableHeader className="sticky top-0 bg-card"><TableRow>
            <TableHead className="sticky left-0 bg-card">From / To</TableHead>
            {slots.map(slot => <TableHead key={slot.logicalId}><MaterialHeader slot={slot} /></TableHead>)}
          </TableRow></TableHeader><TableBody>
            {slots.map((slot, from) => <TableRow key={slot.logicalId}>
              <TableHead className="sticky left-0 bg-card"><MaterialHeader slot={slot} /></TableHead>
              {slots.map((target, to) => {
                const index = plane * n * n + from * n + to;
                const value = from === to ? 0 : displayedFlushVolume(matrix[index], ratio, editor.maximum);
                const expected = displayedFlushVolume(editor.defaults[index], ratio, editor.maximum);
                const state = from === to ? 'default' : value < editor.minimums[plane] ? 'warning' : value !== expected ? 'modified' : 'default';
                return <TableCell key={target.logicalId} className="p-1">
                  <Input key={`${inputEpoch}-${plane}-${index}-${ratio}-${matrix[index]}`} type="number" min={0} max={editor.maximum} step={1}
                    defaultValue={value} readOnly={from === to} disabled={busy || stale || ratio === 0}
                    aria-label={`From material ${from + 1} to material ${to + 1}`} aria-invalid={invalidInputs.has(String(index))}
                    className="w-20 flushing-volume-input" data-value-state={state}
                    onChange={e => {
                      e.currentTarget.dataset.edited = 'true';
                      const next = Number(e.target.value), valid = Number.isFinite(next) && Number.isInteger(next) && next >= 0 && next <= editor.maximum;
                      validateInput(String(index), e.target.value, valid);
                    }}
                    onBlur={e => { if (e.currentTarget.dataset.edited !== 'true') return;
                      const value = Number(e.target.value); if (!e.target.value.trim() || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > editor.maximum) return;
                      setMatrix(previous => previous.map((raw, i) => i === index ? rawFlushVolume(value, ratio) : raw)); }} />
                </TableCell>;
              })}
            </TableRow>)}
          </TableBody></Table>
        </div>
        <FieldGroup><Field orientation="horizontal">
          <FieldLabel htmlFor="flush-multiplier">Multiplier</FieldLabel>
          <Input key={plane} id="flush-multiplier" type="number" min={0} max={3} step={0.01} defaultValue={ratio}
            className="w-24 flushing-volume-input" data-value-state={ratio === 1 ? 'default' : 'modified'} disabled={busy || stale}
            aria-invalid={invalidInputs.has('multiplier')}
            onChange={e => { const value = Number(e.target.value); validateInput('multiplier', e.target.value, Number.isFinite(value) && value >= 0 && value <= 3); }}
            onBlur={e => { const value = Number(e.target.value); if (e.target.value.trim() && Number.isFinite(value) && value >= 0 && value <= 3)
              setMultipliers(previous => previous.map((ratio, i) => i === plane ? value : ratio)); }} />
        </Field><FieldDescription>The multiplier should be in range [0, 3]. A zero multiplier disables flushing for this extruder.</FieldDescription></FieldGroup>
        <p className="text-xs text-muted-foreground">Typical flushing volume: 0–700 mm³. Allowed: 0–{editor.maximum} mm³. Orange marks a modified value; red marks a value below the suggested minimum ({editor.minimums[plane]} mm³).</p>
      </>}
      <DialogFooter><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={!editor || busy || stale || invalidInputs.size > 0} onClick={() => void save()} data-testid="flushing-save">OK</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
