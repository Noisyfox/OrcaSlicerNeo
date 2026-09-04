// packages/slicer-app/src/components/settings/SettingsPanel.tsx
import { useMemo, useState } from 'react';
import type { PresetInfo } from '@slicer/client';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { OptionField } from './OptionField';
import { MovePanel } from './MovePanel';
import { RotatePanel } from './RotatePanel';
import { ScalePanel } from './ScalePanel';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { usePlatform } from '@orca/platform-contract';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@/components/ui/combobox';

const PROCESS_KEYS = [
  'layer_height', 'wall_loops', 'top_shell_layers', 'bottom_shell_layers',
  'sparse_infill_density', 'sparse_infill_pattern', 'enable_support',
  'nozzle_temperature', 'nozzle_temperature_initial_layer',
  'hot_plate_temp_initial_layer', 'print_speed', 'outer_wall_speed',
  'sparse_infill_speed', 'travel_speed',
];

type PresetKind = 'printer' | 'print' | 'filament';

export function SettingsPanel({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  const metadata = useSettingsStore((s) => s.metadata);
  const printers = useSettingsStore((s) => s.printers);
  const prints = useSettingsStore((s) => s.prints);
  const filaments = useSettingsStore((s) => s.filaments);
  const selectedPrinter = useSettingsStore((s) => s.selectedPrinter);
  const selectedPrint = useSettingsStore((s) => s.selectedPrint);
  const selectedFilament = useSettingsStore((s) => s.selectedFilament);
  const hydratePresetSnapshot = useSettingsStore((s) => s.hydratePresetSnapshot);
  const values = useSettingsStore((s) => s.values);
  const setValue = useSettingsStore((s) => s.setValue);
  const setError = useSlicerStore((s) => s.setError);
  const invalidateSliceResult = useSlicerStore((s) => s.invalidateSliceResult);
  const [presetTransitionPending, setPresetTransitionPending] = useState(false);

  // Only render option keys the metadata actually declares (no duplicated
  // schema — PROCESS_KEYS is a render hint, not the schema).
  const processKeys = useMemo(
    () => PROCESS_KEYS.filter((k) => metadata?.[k] !== undefined),
    [metadata],
  );

  // A system profile selection is session state; only its three names and UI
  // preferences are persisted. Compatibility remains in the C++ bridge.
  async function handleSelectPreset(kind: PresetKind, name: string) {
    if (presetTransitionPending) return;
    setPresetTransitionPending(true);
    try {
      const r = await platform.runtime.selectPreset(kind, name);
      if (!r.ok) throw new Error(r.error ?? 'selectPreset failed');
      // The bridge's arrays are already the complete picker-ready candidate
      // sets, in engine order. Replace every picker and resolved name together
      // rather than composing a selection with independently fetched lists.
      hydratePresetSnapshot(r);
      // The result belongs to the old profile combination. One action clears
      // export, toolpath-layer state, progress, and completed status together.
      invalidateSliceResult();
      const project = useProjectStore.getState();
      project.setProject({
        ...(project.scope === 'project' ? { projectPresets: {
          printer: r.printer.name, print: r.print.name, filament: r.filament.name,
        } } : { systemPresets: {
          printer: r.printer.name, print: r.print.name, filament: r.filament.name,
        } }),
      });
      project.markDirty();

      // Persistence failure is non-fatal: the engine-resolved snapshot remains
      // the active session state even when the next-launch preference cannot
      // be written.
      // A project preset is private to the opened project. Only selections
      // made in the system scope may update the cross-host preference store.
      if (project.scope === 'project') return;
      try {
        const prefs = await platform.preferences.load();
        await platform.preferences.save({ ...prefs, selectedProfiles: {
          printer: r.printer.name, print: r.print.name, filament: r.filament.name,
        } });
      } catch (error) {
        console.error('preset preference save failed; keeping resolved session state', error);
      }
    } catch (err) {
      // TODO(profile-compat): define and implement the atomic compatibility
      // transition failure policy before the snapshot-based selection flow ships.
      setError(`select ${kind}: ${String(err)}`);
    } finally {
      setPresetTransitionPending(false);
    }
  }

  if (!metadata) {
    return <div className="p-3 text-xs text-muted-foreground">Loading presets…</div>;
  }

  return (
    <div className="space-y-4 p-3">
      <MovePanel sceneInteraction={sceneInteraction} />
      <RotatePanel sceneInteraction={sceneInteraction} />
      <ScalePanel sceneInteraction={sceneInteraction} />
      <section aria-busy={presetTransitionPending} data-testid="preset-transition-region">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Presets</h2>
        <PresetRow label="Printer" items={printers} value={selectedPrinter} onValue={(v) => handleSelectPreset('printer', v)} disabled={presetTransitionPending} testId="preset-select" />
        <PresetRow label="Process" items={prints} value={selectedPrint} onValue={(v) => handleSelectPreset('print', v)} disabled={presetTransitionPending} testId="process-preset-select" />
        <PresetRow label="Filament" items={filaments} value={selectedFilament} onValue={(v) => handleSelectPreset('filament', v)} disabled={presetTransitionPending} testId="filament-preset-select" />
      </section>
      <section>
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Process</h2>
        {processKeys.map((k) => (
          <OptionField key={k} optionKey={k} meta={metadata[k]} />
        ))}
      </section>
    </div>
  );
}

// Picker-ready candidates only. The bridge has already applied visibility and
// compatibility filtering, and its original order is authoritative. Searchable:
// typing in the popup's search input filters the list (case-insensitive
// substring) — the shadcn base-mira popup style: a button trigger showing
// the current value, search input inside the popup.
function PresetRow({ label, items, value, onValue, disabled, testId }: {
  label: string;
  items: PresetInfo[];
  value: string;
  onValue: (name: string) => void;
  disabled: boolean;
  testId?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1 py-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {/*
        Filtering is items-prop driven in base-ui 1.7 — rendered children are
        NOT auto-filtered. The List's function child becomes a Collection that
        maps the root's filtered items, so search actually narrows the list.
      */}
      <Combobox
        value={value || null}
        onValueChange={(v) => v != null && onValue(v)}
        items={items.map((p) => p.name)}
        disabled={disabled}
      >
        <ComboboxTrigger
          data-testid={testId}
          disabled={disabled}
          render={
            <Button variant="outline" className="w-full justify-between font-normal" />
          }
        >
          <ComboboxValue placeholder="— select —" />
        </ComboboxTrigger>
        <ComboboxContent>
          {/* showTrigger={false} — official popup-style anatomy: the only
              ComboboxTrigger is the root button. Rendering the chevron
              trigger inside the popup overwrites the store's triggerElement
              with an element INSIDE the popup, so the positioner anchors to
              itself and oscillates forever (2026-08-16). */}
          <ComboboxInput placeholder="Search presets…" showTrigger={false} />
          <ComboboxList>
            {(name) => (
              <ComboboxItem key={name} value={name}>{name}</ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>No matching presets</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
