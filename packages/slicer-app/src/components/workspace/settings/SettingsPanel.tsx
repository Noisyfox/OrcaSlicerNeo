import { paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';
// packages/slicer-app/src/components/settings/SettingsPanel.tsx
import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal } from 'lucide-react';
import { ObjectList } from '../objectList/ObjectList';
import { PlateToolbar } from '../PlateToolbar';
import { unstable_batchedUpdates } from 'react-dom';
import type { PresetInfo } from '@slicer/client';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { useProjectStore } from '@/stores/useProjectStore';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from 'cn';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { updateUserPreferences, usePlatform } from '@orca/platform-contract';
import { commitGlobalBedType, selectProcessPreset, invalidateAfterSharedConfigurationMutation } from './configurationActions';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { applyPlateSessionTransforms } from '../actions/syncModelTransforms';
import { glVolumeCollection } from '../viewport/GLVolume';
import { projectHistoryStatus, runProjectMutationOperation } from '../actions/historyMutation';
import { loadRememberedFilamentRackFromRepository, publishRememberedFilamentRack, loadRememberedBedTypeFromRepository, publishRememberedBedType } from '@/preferences';
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

export function SettingsPanel({ sceneInteraction, onEditPrinter, platesContent, renderLayout }: {
  sceneInteraction: SceneInteractionController | null;
  onEditPrinter?: (canonicalName: string) => void;
  platesContent?: ReactNode;
  renderLayout?: (panels: { printer: ReactNode; settings: ReactNode }) => ReactNode;
}) {
  const platform = usePlatform();
  const metadata = useSettingsStore((s) => s.metadata);
  const printers = useSettingsStore((s) => s.printers);
  const prints = useSettingsStore((s) => s.prints);
  const selectedPrinter = useSettingsStore((s) => s.selectedPrinter);
  const selectedPrint = useSettingsStore((s) => s.selectedPrint);
  const bedType = useSettingsStore((s) => s.bedType);
  const globalBed = useSettingsStore((s) => s.nativeScopedConfig.project.curr_bed_type);
  const mutationPending = useProjectStore((s) => s.projectMutationPendingCount > 0);
  const projectOperation = useProjectStore((s) => s.operation.phase);
  const slicing = useSlicerStore((s) => s.status === 'slicing');
  const setError = useSlicerStore((s) => s.setError);
  const [presetTransitionPending, setPresetTransitionPending] = useState(false);
  const selectionPending = useRef(false);
  const [printerExpanded, setPrinterExpanded] = useState(true);

  const controlsDisabled = presetTransitionPending || mutationPending ||
    (slicing && platform.runtime.getRuntimeExecutionState().threaded === false) ||
    ['loading', 'saving', 'model-import', 'waiting-for-dirty-decision'].includes(projectOperation);
  const bedVisible = bedType?.supportsSelection && bedType.choices.length > 0;
  const bedValue = globalBed ?? bedType?.defaultValue ?? '';
  const bedLabel = bedType?.choices.find(choice => choice.value === bedValue)?.label ?? '—';

  async function handleSelectBed(value: string) {
    if (selectionPending.current || controlsDisabled || !paintingCommandAllowed() || value === bedValue) return;
    selectionPending.current = true;
    setPresetTransitionPending(true);
    try { await commitGlobalBedType(platform, value); }
    catch (error) { setError(`select bed type: ${String(error)}`); }
    finally { selectionPending.current = false; setPresetTransitionPending(false); }
  }

  // System profile names and per-printer preferences persist across projects.
  // Compatibility and effective configuration remain native.
  async function handleSelectPreset(kind: PresetKind, name: string) {
    if (selectionPending.current || controlsDisabled || !paintingCommandAllowed()) return;
    selectionPending.current = true;
    setPresetTransitionPending(true);
    try {
      if (kind === 'printer') {
        await runProjectMutationOperation(async () => {
          const rememberedRack = await loadRememberedFilamentRackFromRepository(
            platform.preferences, name,
          );
          const rememberedBed = await loadRememberedBedTypeFromRepository(platform.preferences, name);
          const transition = await platform.runtime.selectPrinterWithRememberedRack(name, rememberedRack, rememberedBed);
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
          await publishRememberedBedType(platform.preferences, transition.profileSnapshot.printer.name,
            transition.nativeScopedConfig.snapshot.project.curr_bed_type);
          const project = useProjectStore.getState();
          if (project.scope !== 'project') {
            try {
              await updateUserPreferences(platform.preferences, prefs => ({ ...prefs, selectedProfiles: {
                printer: transition.profileSnapshot.printer.name,
                print: transition.profileSnapshot.print.name,
              } }));
            } catch (error) {
              console.error('preset preference save failed; keeping resolved session state', error);
            }
          }
        });
        return;
      }

      const r = await selectProcessPreset(platform, name);
      if (!r) return;
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
        await updateUserPreferences(platform.preferences, prefs => ({ ...prefs, selectedProfiles: {
          printer: r.printer.name, print: r.print.name,
        } }));
      } catch (error) {
        console.error('preset preference save failed; keeping resolved session state', error);
      }
    } catch (err) {
      // TODO(profile-compat): define and implement the atomic compatibility
      // transition failure policy before the snapshot-based selection flow ships.
      setError(`select ${kind}: ${String(err)}`);
    } finally {
      selectionPending.current = false;
      setPresetTransitionPending(false);
    }
  }

  const printer = !metadata ? <div className="p-3 text-xs text-muted-foreground">Loading presets…</div> : (
    <section className="pb-2" aria-busy={controlsDisabled} data-testid="preset-transition-region">
      <div className="sidebar-section-header">
        <h2 className="sidebar-section-title">Printer</h2>
        <Button className="absolute right-0 bottom-0" variant="panel-toggle" size="icon-xs"
          data-testid="printer-section-toggle" onClick={() => setPrinterExpanded((value) => !value)}
          aria-label={printerExpanded ? 'Collapse printer' : 'Expand printer'} aria-expanded={printerExpanded}
          aria-controls="printer-section-content">
          {printerExpanded ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </div>
      <div id="printer-section-content" hidden={!printerExpanded} className="px-2 pt-1">
        <div data-testid="printer-bed-row" className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <PresetRow
              compact
              label="Printer"
              items={printers}
              value={selectedPrinter}
              onValue={(v) => handleSelectPreset('printer', v)}
              onEdit={onEditPrinter ? () => onEditPrinter(selectedPrinter) : undefined}
              disabled={controlsDisabled}
              testId="preset-select"
            />
          </div>
          {bedVisible && <div className="min-w-0 flex-[0.6]">
            <Select items={bedType.choices} value={bedValue} disabled={controlsDisabled}
              onValueChange={(value) => value != null && void handleSelectBed(value)}>
              <SelectTrigger variant="sidebar" className="w-full" data-testid="global-bed-type-select"
                aria-label="Global bed type" title={`${bedLabel}. Global bed type; plates without a local override inherit this value.`}>
                <SelectValue>{bedLabel}</SelectValue>
              </SelectTrigger>
              <SelectContent><SelectGroup>{bedType.choices.map(choice =>
                <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </div>}
        </div>
      </div>
    </section>
  );
  const settings = !metadata ? <div className="p-3 text-xs text-muted-foreground">Loading presets…</div> : (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 pb-2">
      <ScopedConfigurationPanel
        bedTypeDisabled={controlsDisabled}
        sceneInteraction={sceneInteraction}
        projectContent={<PresetRow compact label="Process" items={prints} value={selectedPrint} onValue={(v) => handleSelectPreset('print', v)} disabled={controlsDisabled} testId="process-preset-select" />}
        scopedContent={<ObjectList sceneInteraction={sceneInteraction} />}
        platesContent={platesContent}
        platesToolbar={sceneInteraction && <PlateToolbar sceneInteraction={sceneInteraction} />}
      />
    </div>
  );
  return renderLayout ? renderLayout({ printer, settings }) : <>{printer}{settings}</>;
}

// Picker-ready candidates only. The bridge has already applied visibility and
// compatibility filtering, and its original order is authoritative. Searchable:
// typing in the popup's search input filters the list (case-insensitive
// substring) — the shadcn base-mira popup style: a button trigger showing
// the current value, search input inside the popup.
function PresetRow({ label, items, value, onValue, onEdit, disabled, testId, compact = false }: {
  compact?: boolean;
  label: string;
  items: PresetInfo[];
  value: string;
  onValue: (name: string) => void;
  onEdit?: () => void;
  disabled: boolean;
  testId?: string;
}) {
  const [search, setSearch] = useState('');
  if (items.length === 0) return null;
  return (
    <div className={cn(compact ? "min-w-0" : "flex flex-col gap-1 py-1")}>
      <Label className={compact ? "sr-only" : "text-xs text-muted-foreground"}>{label}</Label>
      {/*
        Filtering is items-prop driven in base-ui 1.7 — rendered children are
        NOT auto-filtered. The List's function child becomes a Collection that
        maps the root's filtered items, so search actually narrows the list.
      */}
      <Combobox
        inputValue={search} onInputValueChange={setSearch}
        value={value || null}
        onValueChange={(v) => v != null && onValue(v)}
        items={items.map((p) => p.name)}
        disabled={disabled}
      >
        <div className="flex min-w-0 gap-1">
          {onEdit && <Button
            type="button"
            variant="settings"
            size="icon-sm"
            aria-label="Edit Printer"
            title="Printer settings"
            data-testid="preset-edit-printer"
            disabled={disabled || value.length === 0}
            onClick={onEdit}
          ><SlidersHorizontal /></Button>}
          <ComboboxTrigger
            variant="sidebar"
            aria-label={label}
            title={value}
            className="min-w-0 flex-1"
            data-testid={testId}
            disabled={disabled}
            render={<Button variant="ghost" size="sm" />}
          >
            <span className="min-w-0 flex-1 truncate text-left"><ComboboxValue placeholder="— select —" /></span>
          </ComboboxTrigger>
        </div>
        <ComboboxContent>
          {/* showTrigger={false} — official popup-style anatomy: the only
              ComboboxTrigger is the root button. Rendering the chevron
              trigger inside the popup overwrites the store's triggerElement
              with an element INSIDE the popup, so the positioner anchors to
              itself and oscillates forever (2026-08-16). */}
          <ComboboxInput placeholder="Search presets…" showTrigger={false} searchValue={search} onClearSearch={() => setSearch('')} />
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
