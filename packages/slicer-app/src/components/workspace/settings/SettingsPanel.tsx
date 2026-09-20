// packages/slicer-app/src/components/settings/SettingsPanel.tsx
import { useState } from 'react';
import type { PresetInfo } from '@slicer/client';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { useSlicerStore } from '../../../stores/useSlicerStore';
import { useProjectStore } from '../../../stores/useProjectStore';
import { MovePanel } from './MovePanel';
import { RotatePanel } from './RotatePanel';
import { ScalePanel } from './ScalePanel';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { usePlatform } from '@orca/platform-contract';
import { applyPresetConfigurationMutation, invalidateAfterSharedConfigurationMutation } from './configurationActions';
import { refreshFilamentSession } from '../../../stores/useFilamentSessionStore';
import { applyRememberedFilamentRackFromRepository } from '../../../preferences';
import { ScopedConfigurationPanel } from './ScopedConfigurationPanel';
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

type PresetKind = 'printer' | 'print';

export function SettingsPanel({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  const metadata = useSettingsStore((s) => s.metadata);
  const printers = useSettingsStore((s) => s.printers);
  const prints = useSettingsStore((s) => s.prints);
  const selectedPrinter = useSettingsStore((s) => s.selectedPrinter);
  const selectedPrint = useSettingsStore((s) => s.selectedPrint);
  const hydrateProfileSnapshot = useSettingsStore((s) => s.hydrateProfileSnapshot);
  const applyNativeScopedConfigTransport = useSettingsStore((s) => s.applyNativeScopedConfigTransport);
  const configurationMode = useSettingsStore((s) => s.configurationMode);
  const setConfigurationMode = useSettingsStore((s) => s.setConfigurationMode);
  const setError = useSlicerStore((s) => s.setError);
  const [presetTransitionPending, setPresetTransitionPending] = useState(false);

  // A system profile selection is session state; only its three names and UI
  // preferences are persisted. Compatibility remains in the C++ bridge.
  async function handleSelectPreset(kind: PresetKind, name: string) {
    if (presetTransitionPending) return;
    setPresetTransitionPending(true);
    try {
      const r = await platform.runtime.selectProfile(kind, name);
      if (!r.ok) throw new Error(r.error ?? 'selectProfile failed');
      if (kind === 'printer') {
        await applyRememberedFilamentRackFromRepository(
          platform.preferences,
          platform.runtime,
          r.printer.name,
        );
      }
      // Preset selection changes the shared slice input for every plate. The
      // bridge owns the complete plate set and advances all revisions in one
      // typed transaction; its response is the sole source for revisions and
      // affected plates recorded by the shared action.
      await applyPresetConfigurationMutation(platform);
      const filament = await refreshFilamentSession(platform.runtime);
      if (!filament.ok) throw new Error(filament.error ?? 'filament session refresh failed');
      // The bridge's arrays are already the complete picker-ready candidate
      // sets, in engine order. Replace every picker and resolved name together
      // rather than composing a selection with independently fetched lists.
      hydrateProfileSnapshot(r);
      const revalidated = await platform.runtime.revalidateNativeScopedConfig();
      if (revalidated.ok) applyNativeScopedConfigTransport(revalidated.nativeScopedConfig);
      // The result belongs to the old profile combination. One action clears
      // export, toolpath-layer state, progress, and completed status together.
      invalidateAfterSharedConfigurationMutation();
      const project = useProjectStore.getState();
      project.setProject({
        ...(project.scope === 'project' ? { projectPresets: {
          printer: r.printer.name, print: r.print.name,
        } } : { systemPresets: {
          printer: r.printer.name, print: r.print.name,
        } }),
      });

      // Persistence failure is non-fatal: the engine-resolved snapshot remains
      // the active session state even when the next-launch preference cannot
      // be written.
      // A project preset is private to the opened project. Only selections
      // made in the system scope may update the cross-host preference store.
      if (project.scope === 'project') return;
      try {
        const prefs = await platform.preferences.load();
        await platform.preferences.save({ ...prefs, selectedProfiles: {
          printer: r.printer.name, print: r.print.name,
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
      <section data-testid="configuration-surface" className="space-y-2">
        <div role="tablist" aria-label="Configuration mode" className="grid grid-cols-2 rounded border p-0.5">
          <Button
            type="button"
            role="tab"
            aria-selected={configurationMode === 'project'}
            data-testid="config-mode-project"
            variant={configurationMode === 'project' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setConfigurationMode('project')}
          >Project</Button>
          <Button
            type="button"
            role="tab"
            aria-selected={configurationMode === 'scoped'}
            data-testid="config-mode-scoped"
            variant={configurationMode === 'scoped' ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setConfigurationMode('scoped')}
          >Scoped</Button>
        </div>
      </section>
      <MovePanel sceneInteraction={sceneInteraction} />
      <RotatePanel sceneInteraction={sceneInteraction} />
      <ScalePanel sceneInteraction={sceneInteraction} />
      <section aria-busy={presetTransitionPending} data-testid="preset-transition-region">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Presets</h2>
        <PresetRow label="Printer" items={printers} value={selectedPrinter} onValue={(v) => handleSelectPreset('printer', v)} disabled={presetTransitionPending} testId="preset-select" />
        <PresetRow label="Process" items={prints} value={selectedPrint} onValue={(v) => handleSelectPreset('print', v)} disabled={presetTransitionPending} testId="process-preset-select" />
      </section>
      <ScopedConfigurationPanel sceneInteraction={sceneInteraction} />
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
