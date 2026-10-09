import { paintingCommandAllowed } from './viewport/gizmo/painting/projectCommands';
import { useEffect, useMemo, useState } from 'react';
import { normalizeHexColor, usePlatform, type ColorValue } from '@orca/platform-contract';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import type { FilamentMutationResultOrError, FilamentSessionSlot } from '@slicer/client';
import { filamentSwatchStyle, filamentSwatchTitle } from './FilamentSwatch';
import { publishRememberedFilamentRack } from '@/preferences';
import { filamentImpactSummary, compatiblePresetNames, type FilamentImpactSummary } from './filamentRackProjection';
import { ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { UserColorPickerPopover } from '@/components/color/UserColorPickerPopover';
import { PresetCombobox } from './PresetCombobox';
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
  ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger,
} from '@/components/ui/context-menu';

type PendingImpact = { kind: 'delete' | 'merge'; summary: FilamentImpactSummary } | null;

function editorValue(slot: FilamentSessionSlot): ColorValue {
  const { mode, colors } = slot.colour.display;
  // The editor owns only two endpoints. Imported partitions and extra stops
  // become a two-endpoint draft without changing native state until Confirm.
  return mode === 'solid'
    ? { kind: 'solid', color: colors[0] }
    : { kind: 'linear-gradient', start: colors[0], end: colors.at(-1)! };
}

function matchesCanonicalColour(slot: FilamentSessionSlot, value: ColorValue): boolean {
  const native = slot.colour.native;
  const equal = (a: string | null, b: string) => normalizeHexColor(a) === normalizeHexColor(b);
  const normalizedMulti = native.multiColour?.split(' ').map(normalizeHexColor).join(' ');
  if (value.kind === 'solid')
    return native.type === '1' && equal(native.representative, value.color) && equal(native.multiColour, value.color);
  return native.type === '0' && equal(native.representative, value.start) &&
    normalizedMulti === `${normalizeHexColor(value.start)} ${normalizeHexColor(value.end)}`;
}

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

function SlotCard({ slot, presetNames, presetLabels, presetVendors, mergeDestinations, canDelete, canMerge, pending, onPreset, onColour, onEdit, onDelete, onMerge }: {
  slot: FilamentSessionSlot;
  presetNames: readonly string[];
  presetLabels: ReadonlyMap<string, string>;
  presetVendors: ReadonlyMap<string, string>;
  mergeDestinations: readonly number[];
  canDelete: boolean;
  canMerge: boolean;
  pending: boolean;
  onPreset: (name: string) => void;
  onColour: (colour: ColorValue) => void;
  onEdit?: () => void;
  onDelete: () => void;
  onMerge: (destination: number) => void;
}) {
  const [colourOpen, setColourOpen] = useState(false);
  const colourSignature = JSON.stringify(slot.colour);
  useEffect(() => {
    setColourOpen(false);
  }, [colourSignature]);
  const draft = editorValue(slot);
  const displayedColour = (draft.kind === 'solid' ? draft.color : draft.start).toLowerCase();
  const representative = slot.colour.effective.slice(0, 7);
  const [red, green, blue] = [1, 3, 5].map((offset) => parseInt(representative.slice(offset, offset + 2), 16));
  const numberColour = red * 0.299 + green * 0.587 + blue * 0.114 > 150 ? '#171717' : '#ffffff';
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<article />}
        className="flex h-6 min-w-0 items-center overflow-hidden rounded-sm bg-control-background"
        data-testid={`filament-slot-${slot.slot}`} aria-busy={pending}>
        <UserColorPickerPopover open={colourOpen} onOpenChange={setColourOpen}
          title={`Slot ${slot.slot} color`} value={draft} enableAlpha enableGradient disabled={pending}
          onConfirm={next => {
            const colour: ColorValue = next.kind === 'solid'
              ? { kind: 'solid', color: normalizeHexColor(next.color)!.toLowerCase() }
              : { kind: 'linear-gradient', start: normalizeHexColor(next.start)!.toLowerCase(), end: normalizeHexColor(next.end)!.toLowerCase() };
            if (!matchesCanonicalColour(slot, colour)) onColour(colour);
          }} trigger={<Button variant="ghost" size="icon-sm" className="h-full w-6 shrink-0"
            aria-label={`Slot ${slot.slot} colour`} data-testid={`filament-colour-${slot.slot}`} value={displayedColour}
            title={filamentSwatchTitle(slot.colour.display)}
            style={{ ...filamentSwatchStyle(slot.colour.display), color: numberColour,
              border: 0, backgroundClip: 'border-box', borderRadius: '4px 0 0 4px' }}>{slot.slot}</Button>} />
        <PresetCombobox items={presetNames.map(name => ({ id: name, name, label: presetLabels.get(name)! }))}
          value={slot.preset.name} onValue={onPreset} disabled={pending}
          ariaLabel={`Filament preset for slot ${slot.slot}`} testId={`filament-preset-${slot.slot}`}
          searchPlaceholder="Search compatible presets…" emptyText="No compatible preset"
          groupBy={item => presetVendors.get(item.id)! || 'Unspecified'}
          triggerStyle={{ borderTopLeftRadius: 0, borderBottomLeftRadius: 0 }} />
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onEdit && <ContextMenuItem data-testid={`filament-edit-${slot.slot}`} disabled={pending} onClick={onEdit}>Edit</ContextMenuItem>}
        <ContextMenuSub>
          <ContextMenuSubTrigger data-testid={`filament-merge-${slot.slot}`} disabled={pending || !canMerge}>Merge with…</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {mergeDestinations.filter((destination) => destination !== slot.slot).map((destination) => (
              <ContextMenuItem key={destination} data-testid={`filament-merge-${slot.slot}-to-${destination}`}
                onClick={() => { if (paintingCommandAllowed()) onMerge(destination); }}>Slot {destination}</ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem data-testid={`filament-delete-${slot.slot}`} variant="destructive" disabled={pending || !canDelete} onClick={onDelete}>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function FilamentRack({ onEditPreset }: { onEditPreset?: (canonicalName: string) => void }) {
  const platform = usePlatform();
  const snapshot = useFilamentSessionStore((state) => state.snapshot);
  const pendingKind = useFilamentSessionStore((state) => state.pendingKind);
  const rejected = useFilamentSessionStore((state) => state.rejected);
  const load = useFilamentSessionStore((state) => state.load);
  const run = useFilamentSessionStore((state) => state.run);
  const clearRejected = useFilamentSessionStore((state) => state.clearRejected);
  const filamentCatalog = useSettingsStore((state) => state.filamentCatalog);
  const [expanded, setExpanded] = useState(true);
  const [impact, setImpact] = useState<PendingImpact>(null);

  useEffect(() => {
    void load(platform.runtime);
  }, [load, platform.runtime]);

  const presetNames = useMemo(
    () => compatiblePresetNames(snapshot, filamentCatalog.map((preset) => preset.name)),
    [filamentCatalog, snapshot],
  );
  const presetLabels = useMemo(() => new Map([
    ...filamentCatalog.map(preset => [preset.name, preset.label] as const),
    ...(snapshot?.slots.map(slot => [slot.preset.name, slot.preset.label] as const) ?? []),
  ]), [filamentCatalog, snapshot]);
  const presetVendors = useMemo(() => new Map([
    ...filamentCatalog.map(preset => [preset.name, preset.vendor] as const),
    ...(snapshot?.slots.map(slot => [slot.preset.name, slot.preset.vendor] as const) ?? []),
  ]), [filamentCatalog, snapshot]);
  // The project mutation fence is a safety/ordering mechanism, not a rack
  // presentation state. Filament commands are queued behind model/history
  // work by the shared gate, while the rack remains visually stable and
  // interactive-looking. Only this rack's own native command is pending here.
  const pending = pendingKind !== null;

  async function updateSlot(request: () => Promise<FilamentMutationResultOrError>) {
    const result = await run(platform.runtime, request);
    if (result.ok) {
      // Native mutation + renderer projection are the interactive operation.
      // Do not hold the rack's pending state on a preferences IPC/filesystem
      // round trip; the helper serializes background writes per printer.
      void publishRememberedFilamentRack(platform.preferences, useSettingsStore.getState().selectedPrinter, result.result.snapshot);
    }
  }

  function revision() { return useFilamentSessionStore.getState().snapshot?.revisions.session ?? 0; }

  function askOrRun(kind: 'delete' | 'merge', slot: number, destination: number | null) {
    if (!snapshot || !paintingCommandAllowed()) return;
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
      <section data-testid="filament-rack" className="px-2 pb-2" aria-busy={pending}>
        <div className="sidebar-section-header -mx-2">
          <h2 className="sidebar-section-title">Material ({snapshot.slots.length})</h2>
          <Button className="absolute right-0 bottom-0" variant="panel-toggle" size="icon-xs"
            data-testid="filament-rack-toggle" onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? 'Collapse materials' : 'Expand materials'} aria-expanded={expanded}>
            {expanded ? <ChevronDown /> : <ChevronUp />}
          </Button>
        </div>
        {expanded && <div className="flex h-8 items-center justify-end gap-1">
          <Button variant="secondary" size="icon-xs" className="size-5 rounded-sm" data-testid="filament-remove"
            aria-label="Remove last filament slot" disabled={pending || !snapshot.capabilities.canDelete || snapshot.slots.length === 0}
            onClick={() => askOrRun('delete', snapshot.slots[snapshot.slots.length - 1].slot, null)}><Minus /></Button>
          <Button variant="secondary" size="icon-xs" className="size-5 rounded-sm" data-testid="filament-add"
            aria-label="Add filament slot" disabled={pending || !snapshot.capabilities.canAdd}
            onClick={() => void updateSlot(() => platform.runtime.addFilamentSlot({ version: 1, revision: revision() }))}><Plus /></Button>
        </div>}
        {rejected && <div className="mt-2 flex items-center gap-2 rounded border border-destructive/50 p-2 text-xs text-destructive" role="alert" data-testid="filament-rejected"><span className="min-w-0 flex-1">{rejected}</span><Button variant="ghost" size="icon-xs" onClick={clearRejected} aria-label="Dismiss rejection">×</Button></div>}
        {expanded && <div className="filament-slot-grid grid grid-cols-2 gap-x-2 gap-y-1.5" data-testid="filament-slot-grid">
          {snapshot.slots.map((slot) => (
            <SlotCard
              key={slot.slot}
              slot={slot}
              presetNames={presetNames}
              presetLabels={presetLabels}
              presetVendors={presetVendors}
              canDelete={snapshot.capabilities.canDelete}
              canMerge={snapshot.capabilities.canMerge}
              mergeDestinations={snapshot.slots.map((entry) => entry.slot)}
              pending={pending}
              onPreset={(preset) => void updateSlot(() => platform.runtime.selectFilamentSlotPreset({ version: 1, revision: revision(), slot: slot.slot, preset }))}
              onColour={(colour) => void updateSlot(() => platform.runtime.setFilamentSlotColour({ version: 1, revision: revision(), slot: slot.slot, colour }))}
              onEdit={onEditPreset ? () => onEditPreset(slot.preset.name) : undefined}
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
