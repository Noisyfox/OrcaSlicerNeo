import { useEffect, useMemo, useState } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useFilamentSessionStore } from '../../stores/useFilamentSessionStore';
import type { FilamentMutationResultOrError } from '@slicer/client';
import { publishRememberedFilamentRack } from '../../preferences';
import { filamentImpactSummary, compatiblePresetNames, type FilamentImpactSummary } from './filamentRackProjection';
import { Button } from '@/components/ui/button';
import {
  Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem,
  ComboboxList, ComboboxTrigger, ComboboxValue,
} from '@/components/ui/combobox';

type PendingImpact = { kind: 'delete' | 'merge'; summary: FilamentImpactSummary } | null;

function ImpactDialog({ impact, onCancel, onConfirm }: {
  impact: PendingImpact;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!impact) return null;
  const { summary } = impact;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="presentation">
      <div className="w-full max-w-sm rounded-lg border bg-card p-4 text-card-foreground shadow-xl" role="dialog" aria-modal="true" aria-labelledby="filament-impact-title">
        <h2 id="filament-impact-title" className="text-sm font-semibold">Confirm filament change</h2>
        <p className="mt-2 text-xs text-muted-foreground" data-testid="filament-impact-summary">
          Slot {summary.slot} is referenced by {summary.assignmentCount} assignment{summary.assignmentCount === 1 ? '' : 's'} and {summary.mappingCount} native mapping{summary.mappingCount === 1 ? '' : 's'}.
          {summary.remapped ? ` References will be remapped to slot ${summary.destination}.` : ' References without a merge destination will fall back to Default.'}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" data-testid="filament-impact-cancel" onClick={onCancel}>Cancel</Button>
          <Button variant="destructive" size="sm" data-testid="filament-impact-confirm" onClick={onConfirm}>Continue</Button>
        </div>
      </div>
    </div>
  );
}

function SlotCard({ slot, presetNames, mergeDestinations, canDelete, canMerge, pending, onPreset, onColour, onDelete, onMerge }: {
  slot: { slot: number; preset: { name: string }; colour: { effective: string } };
  presetNames: readonly string[];
  mergeDestinations: readonly number[];
  canDelete: boolean;
  canMerge: boolean;
  pending: boolean;
  onPreset: (name: string) => void;
  onColour: (colour: string) => void;
  onDelete: () => void;
  onMerge: (destination: number) => void;
}) {
  const [mergeOpen, setMergeOpen] = useState(false);
  return (
    <article className="min-w-0 rounded-md border bg-background/40 p-2" data-testid={`filament-slot-${slot.slot}`} aria-busy={pending}>
      <div className="flex items-center gap-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ backgroundColor: slot.colour.effective }} aria-label={`Slot ${slot.slot} colour`}>
          {slot.slot}
        </span>
        <input
          aria-label={`Slot ${slot.slot} colour`}
          data-testid={`filament-colour-${slot.slot}`}
          type="color"
          value={slot.colour.effective.slice(0, 7)}
          disabled={pending}
          onChange={(event) => onColour(event.target.value)}
          className="size-6 cursor-pointer rounded border-0 bg-transparent p-0"
        />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">Slot {slot.slot}</span>
        <Button variant="ghost" size="icon-xs" data-testid={`filament-delete-${slot.slot}`} disabled={pending || !canDelete} onClick={onDelete} aria-label={`Delete slot ${slot.slot}`}>×</Button>
      </div>
      <div className="mt-2 flex min-w-0 gap-1">
        <Combobox value={slot.preset.name} onValueChange={(value) => value && onPreset(value)} items={[...presetNames]} disabled={pending}>
          <ComboboxTrigger data-testid={`filament-preset-${slot.slot}`} render={<Button variant="outline" size="sm" className="min-w-0 flex-1 justify-between font-normal" />}>
            <ComboboxValue />
          </ComboboxTrigger>
          <ComboboxContent>
            <ComboboxInput placeholder="Search compatible presets…" showTrigger={false} />
            <ComboboxList>{(name) => <ComboboxItem key={name} value={name}>{name}</ComboboxItem>}</ComboboxList>
            <ComboboxEmpty>No compatible preset</ComboboxEmpty>
          </ComboboxContent>
        </Combobox>
        <Button variant="outline" size="sm" data-testid={`filament-merge-${slot.slot}`} disabled={pending || !canMerge} onClick={() => setMergeOpen((open) => !open)}>Merge</Button>
      </div>
      {mergeOpen && (
        <div className="mt-1 flex flex-wrap gap-1" data-testid={`filament-merge-menu-${slot.slot}`}>
          <span className="sr-only">Choose surviving slot</span>
        </div>
      )}
      {/* The destination buttons are supplied as a compact native menu by the
          rack parent to keep the card itself free of a second session model. */}
      <div className="mt-1 flex justify-end gap-1">
        {mergeOpen && mergeDestinations.filter((destination) => destination !== slot.slot).map((destination) => (
          <Button key={destination} variant="ghost" size="icon-xs" data-testid={`filament-merge-${slot.slot}-to-${destination}`} onClick={() => { setMergeOpen(false); onMerge(destination); }}>→{destination}</Button>
        ))}
      </div>
    </article>
  );
}

export function FilamentRack() {
  const platform = usePlatform();
  const snapshot = useFilamentSessionStore((state) => state.snapshot);
  const pendingKind = useFilamentSessionStore((state) => state.pendingKind);
  const rejected = useFilamentSessionStore((state) => state.rejected);
  const load = useFilamentSessionStore((state) => state.load);
  const run = useFilamentSessionStore((state) => state.run);
  const clearRejected = useFilamentSessionStore((state) => state.clearRejected);
  const filaments = useSettingsStore((state) => state.filaments);
  const [expanded, setExpanded] = useState(true);
  const [impact, setImpact] = useState<PendingImpact>(null);

  useEffect(() => {
    if (!platform.runtime || typeof platform.runtime.getFilamentSessionSnapshot !== 'function') return;
    void load(platform.runtime);
  }, [load, platform.runtime]);

  const presetNames = useMemo(
    () => compatiblePresetNames(snapshot, filaments.map((preset) => preset.name)),
    [filaments, snapshot],
  );
  const pending = pendingKind !== null;

  async function updateSlot(request: () => Promise<FilamentMutationResultOrError>) {
    const result = await run(platform.runtime, request);
    if (result.ok) {
      await publishRememberedFilamentRack(platform.preferences, useSettingsStore.getState().selectedPrinter, result.result.snapshot);
    }
  }

  function revision() { return snapshot?.revisions.session ?? 0; }

  function askOrRun(kind: 'delete' | 'merge', slot: number, destination: number | null) {
    if (!snapshot) return;
    const summary = filamentImpactSummary(snapshot, slot, destination);
    if (summary.assignmentCount > 0 || summary.mappingCount > 0) setImpact({ kind, summary });
    else void confirmMutation(kind, slot, destination);
  }

  async function confirmMutation(kind: 'delete' | 'merge', slot: number, destination: number | null) {
    setImpact(null);
    if (kind === 'delete') {
      await updateSlot(() => platform.runtime.deleteFilamentSlot({ version: 1, revision: revision(), slot }));
    } else if (destination !== null) {
      await updateSlot(() => platform.runtime.mergeFilamentSlots({ version: 1, revision: revision(), source: slot, destination }));
    }
  }

  if (!snapshot) {
    return (
      <section data-testid="filament-rack" className="border-b p-3 text-xs text-muted-foreground">
        {rejected ? (
          <div className="flex items-center gap-2 rounded border border-destructive/50 p-2 text-destructive" role="alert" data-testid="filament-rejected">
            <span className="min-w-0 flex-1">{rejected}</span>
            <Button variant="ghost" size="icon-xs" onClick={clearRejected} aria-label="Dismiss rejection">×</Button>
          </div>
        ) : 'Loading filaments…'}
      </section>
    );
  }

  return (
    <>
      <section data-testid="filament-rack" className="border-b p-3" aria-busy={pending}>
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Filament</h2>
          <span className="text-[0.65rem] text-muted-foreground">{snapshot.slots.length}/{snapshot.capabilities.maxSlots}</span>
          <Button className="ml-auto" variant="ghost" size="icon-xs" data-testid="filament-rack-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>{expanded ? '−' : '+'}</Button>
          <Button variant="outline" size="xs" data-testid="filament-add" disabled={pending || !snapshot.capabilities.canAdd} onClick={() => void updateSlot(() => platform.runtime.addFilamentSlot({ version: 1, revision: revision() }))}>Add</Button>
        </div>
        {rejected && <div className="mt-2 flex items-center gap-2 rounded border border-destructive/50 p-2 text-xs text-destructive" role="alert" data-testid="filament-rejected"><span className="min-w-0 flex-1">{rejected}</span><Button variant="ghost" size="icon-xs" onClick={clearRejected} aria-label="Dismiss rejection">×</Button></div>}
        {expanded && <div className="filament-slot-grid mt-2 grid grid-cols-1 gap-2" data-testid="filament-slot-grid">
          {snapshot.slots.map((slot) => (
            <SlotCard
              key={slot.slot}
              slot={slot}
              presetNames={presetNames}
              canDelete={snapshot.capabilities.canDelete}
              canMerge={snapshot.capabilities.canMerge}
              mergeDestinations={snapshot.slots.map((entry) => entry.slot)}
              pending={pending}
              onPreset={(preset) => void updateSlot(() => platform.runtime.selectFilamentSlotPreset({ version: 1, revision: revision(), slot: slot.slot, preset }))}
              onColour={(colour) => void updateSlot(() => platform.runtime.setFilamentSlotColour({ version: 1, revision: revision(), slot: slot.slot, colour }))}
              onDelete={() => askOrRun('delete', slot.slot, null)}
              onMerge={(destination) => askOrRun('merge', slot.slot, destination)}
            />
          ))}
        </div>}
      </section>
      <ImpactDialog impact={impact} onCancel={() => setImpact(null)} onConfirm={() => impact && void confirmMutation(impact.kind, impact.summary.slot, impact.summary.destination)} />
    </>
  );
}
