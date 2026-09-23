// packages/slicer-app/src/components/settings/SettingsPanel.tsx
import { useState } from 'react';
import { unstable_batchedUpdates } from 'react-dom';
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
import { refreshFilamentSession, useFilamentSessionStore } from '../../../stores/useFilamentSessionStore';
import { usePlateSessionStore } from '../../../stores/usePlateSessionStore';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { projectHistoryStatus, runProjectMutationOperation } from '../actions/historyMutation';
import { loadRememberedFilamentRackFromRepository, publishRememberedFilamentRack } from '../../../preferences';
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

export function SettingsPanel({ sceneInteraction, onEditPrinter }: {
  sceneInteraction: SceneInteractionController | null;
  onEditPrinter?: (canonicalName: string) => void;
}) {
  const platform = usePlatform();
  const metadata = useSettingsStore((s) => s.metadata);
  const printers = useSettingsStore((s) => s.printers);
  const prints = useSettingsStore((s) => s.prints);
  const selectedPrinter = useSettingsStore((s) => s.selectedPrinter);
  const selectedPrint = useSettingsStore((s) => s.selectedPrint);
  const hydrateProfileSnapshot = useSettingsStore((s) => s.hydrateProfileSnapshot);
  const applyNativeScopedConfigTransport = useSettingsStore((s) => s.applyNativeScopedConfigTransport);
  const setError = useSlicerStore((s) => s.setError);
  const [presetTransitionPending, setPresetTransitionPending] = useState(false);

  // A system profile selection is session state; only its three names and UI
  // preferences are persisted. Compatibility remains in the C++ bridge.
  async function handleSelectPreset(kind: PresetKind, name: string) {
    if (presetTransitionPending) return;
    setPresetTransitionPending(true);
    try {
      if (kind === 'printer') {
        await runProjectMutationOperation(async () => {
          const rememberedRack = await loadRememberedFilamentRackFromRepository(
            platform.preferences, name,
          );
          const transition = await platform.runtime.selectPrinterWithRememberedRack(name, rememberedRack);
          if (!transition.ok) throw new Error(transition.error ?? 'Printer transition failed');

          // This command already committed the single native history entry.
          // Publish its receipt directly; do not issue a second rack edit,
          // revision bump, profile read, or scoped-config revalidation.
          unstable_batchedUpdates(() => {
            const status = projectHistoryStatus(transition.historyStatus);
            if (status.revision === transition.historyStatus.revision) {
              useSettingsStore.getState().hydrateProfileSnapshot(transition.profileSnapshot);
              const scoped = useSettingsStore.getState().applyNativeScopedConfigTransport(
                transition.nativeScopedConfig,
              );
              if (scoped === 'refresh-required')
                throw new Error('Printer transition scoped configuration receipt was not accepted');
              useFilamentSessionStore.getState().publish(transition.filamentSession);
              applyPlateSessionTransforms(transition.plateSession, glVolumeCollection.volumes);
              usePlateSessionStore.getState().setSnapshot(transition.plateSession);
              const project = useProjectStore.getState();
              const selections = {
                printer: transition.profileSnapshot.printer.name,
                print: transition.profileSnapshot.print.name,
              };
              project.setProject(project.scope === 'project'
                ? { projectPresets: selections, dirty: status.dirty, dirtyReasons: [],
                    plateInputRevisions: transition.plateSession.inputRevisions ?? {} }
                : { systemPresets: selections, dirty: status.dirty, dirtyReasons: [],
                    plateInputRevisions: transition.plateSession.inputRevisions ?? {} });
              invalidateAfterSharedConfigurationMutation(
                transition.mutation.affectedPlateIds, platform.runtime,
                transition.mutation.allPlateResultsInvalidated,
              );
            }
          });

          // Rack memory is an independent user preference, not part of the
          // native project-history frame. Publish only the normalized rack
          // returned by a successful native transition, even in project scope.
          await publishRememberedFilamentRack(
            platform.preferences, transition.profileSnapshot.printer.name, transition.filamentSession,
          );
          const project = useProjectStore.getState();
          if (project.scope !== 'project') {
            try {
              const prefs = await platform.preferences.load();
              await platform.preferences.save({ ...prefs, selectedProfiles: {
                printer: transition.profileSnapshot.printer.name,
                print: transition.profileSnapshot.print.name,
              } });
            } catch (error) {
              console.error('preset preference save failed; keeping resolved session state', error);
            }
          }
        });
        return;
      }

      const r = await platform.runtime.selectProfile(kind, name);
      if (!r.ok) throw new Error(r.error ?? 'selectProfile failed');
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
      <MovePanel sceneInteraction={sceneInteraction} />
      <RotatePanel sceneInteraction={sceneInteraction} />
      <ScalePanel sceneInteraction={sceneInteraction} />
      <section aria-busy={presetTransitionPending} data-testid="preset-transition-region">
        <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Presets</h2>
        <PresetRow
          label="Printer"
          items={printers}
          value={selectedPrinter}
          onValue={(v) => handleSelectPreset('printer', v)}
          onEdit={onEditPrinter ? () => onEditPrinter(selectedPrinter) : undefined}
          disabled={presetTransitionPending}
          testId="preset-select"
        />
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
function PresetRow({ label, items, value, onValue, onEdit, disabled, testId }: {
  label: string;
  items: PresetInfo[];
  value: string;
  onValue: (name: string) => void;
  onEdit?: () => void;
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
        <div className="flex min-w-0 gap-1">
          <ComboboxTrigger
            data-testid={testId}
            disabled={disabled}
            render={
              <Button variant="outline" className="min-w-0 flex-1 justify-between font-normal" />
            }
          >
            <ComboboxValue placeholder="— select —" />
          </ComboboxTrigger>
          {onEdit && <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="preset-edit-printer"
            disabled={disabled || value.length === 0}
            onClick={onEdit}
          >Edit</Button>}
        </div>
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
