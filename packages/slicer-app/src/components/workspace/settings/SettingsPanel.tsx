import { paintingCommandAllowed } from '../viewport/gizmo/painting/projectCommands';
// packages/slicer-app/src/components/settings/SettingsPanel.tsx
import { useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, SlidersHorizontal, RefreshCw } from 'lucide-react';
import { ObjectList } from '../objectList/ObjectList';
import { PlateToolbar } from '../PlateToolbar';
import { unstable_batchedUpdates } from 'react-dom';
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
import { PresetCombobox, type PresetComboItem } from '../PresetCombobox';
import type { PrinterTransitionSuccess } from '@orca/slicer-runtime';
import { useHistoryNavigationStore } from '@/stores/useHistoryNavigationStore';

type PresetKind = 'printer' | 'print';

export function SettingsPanel({ sceneInteraction, onEditPrinter, platesContent, renderLayout }: {
  sceneInteraction: SceneInteractionController | null;
  onEditPrinter?: (canonicalName: string) => void;
  platesContent?: ReactNode;
  renderLayout?: (panels: { printer: ReactNode; settings: ReactNode }) => ReactNode;
}) {
  const platform = usePlatform();
  const metadata = useSettingsStore((s) => s.metadata);
  const printerPicker = useSettingsStore((s) => s.printerPicker);
  const nozzleDiameter = useSettingsStore((s) => s.values.nozzle_diameter);
  const nozzleVolumeType = useSettingsStore((s) => s.values.nozzle_volume_type);
  const prints = useSettingsStore((s) => s.prints);
  const selectedPrinter = useSettingsStore((s) => s.selectedPrinter);
  const printerModified = useSettingsStore((s) => s.modifiedPresets.printer.includes(s.selectedPrinter));
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
  const [printerTab, setPrinterTab] = useState<'device' | 'multi'>('device');
  const [toolhead, setToolhead] = useState(0);

  if (printerPicker === null) throw new Error('SettingsPanel requires an initialized profile snapshot');

  const controlsDisabled = presetTransitionPending || mutationPending ||
    (slicing && platform.runtime.getRuntimeExecutionState().threaded === false) ||
    ['loading', 'saving', 'model-import', 'waiting-for-dirty-decision'].includes(projectOperation);
  const bedVisible = bedType?.supportsSelection && bedType.choices.length > 0;
  const bedValue = globalBed ?? bedType?.defaultValue ?? '';
  const bedLabel = bedType?.choices.find(choice => choice.value === bedValue)?.label ?? '—';
  const nozzleDiameters = nozzleDiameter ? nozzleDiameter.split(',').map(value => value.trim()) : [];
  const nozzleVolumeTypes = nozzleVolumeType ? nozzleVolumeType.split(',').map(value => value.trim()) : [];
  const multiExtruder = nozzleDiameters.length > 1;
  const activeToolhead = Math.min(toolhead, Math.max(0, nozzleDiameters.length - 1));
  const activePrinterTab = multiExtruder ? printerTab : 'device';
  const flowLabels: Record<string, string> = {
    Standard: 'SF', 'High Flow': 'HF', 'Extra High Flow': 'XHF',
    'TPU High Flow': 'TPU HF', Hybrid: 'Hybrid', 'E3D High Flow': 'E3D HF',
  };

  async function handleToolheadDiameter(value: string) {
    if (selectionPending.current || controlsDisabled || !paintingCommandAllowed() ||
        Number(value) === Number(nozzleDiameters[activeToolhead])) return;
    const history = useHistoryNavigationStore.getState().status;
    if (!history) { setError('Toolhead configuration requires initialized project history'); return; }
    selectionPending.current = true;
    setPresetTransitionPending(true);
    try {
      await runProjectMutationOperation(async () => {
        const transition = await platform.runtime.setToolheadDiameter(activeToolhead, Number(value), history.revision);
        if (!transition.ok) throw new Error(transition.error);
        publishPrinterTransition(transition);
        await rememberPrinterTransition(transition);
      });
    } catch (error) { setError(`select toolhead diameter: ${String(error)}`); }
    finally { selectionPending.current = false; setPresetTransitionPending(false); }
  }

  async function handleSelectBed(value: string) {
    if (selectionPending.current || controlsDisabled || !paintingCommandAllowed() || value === bedValue) return;
    selectionPending.current = true;
    setPresetTransitionPending(true);
    try { await commitGlobalBedType(platform, value); }
    catch (error) { setError(`select bed type: ${String(error)}`); }
    finally { selectionPending.current = false; setPresetTransitionPending(false); }
  }

  function publishPrinterTransition(transition: PrinterTransitionSuccess) {
    // This command already committed the single native history entry.
    // Publish its receipt directly; do not issue a second rack edit,
    // revision bump, profile read, or scoped-config revalidation.
    unstable_batchedUpdates(() => {
      const status = projectHistoryStatus(transition.historyStatus);
      if (status.revision === transition.historyStatus.revision) {
        const configurationMode = useSettingsStore.getState().configurationMode;
        useSettingsStore.getState().hydrateProfileSnapshot(transition.profileSnapshot);
        if (transition.mutation.kind === 'set-toolhead-diameter')
          useSettingsStore.getState().setConfigurationMode(configurationMode);
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

  }

  async function rememberPrinterTransition(transition: PrinterTransitionSuccess) {
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

          publishPrinterTransition(transition);
          await rememberPrinterTransition(transition);
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
        {multiExtruder ? <div role="tablist" aria-label="Printer configuration" className="flex">
          {(['device', 'multi'] as const).map(tab => <Button key={tab} role="tab" type="button"
            variant="ghost" size="xs" aria-selected={activePrinterTab === tab}
            aria-controls={`printer-${tab}-content`} data-testid={`printer-tab-${tab}`}
            className={cn('h-5 w-[68px] rounded-b-none rounded-t-sm px-0 text-module leading-none font-normal',
              activePrinterTab === tab ? 'bg-card text-foreground hover:bg-card' : 'text-muted-foreground')}
            onClick={() => setPrinterTab(tab)}>{tab === 'device' ? 'Device' : 'Multi.'}</Button>)}
        </div> : <h2 className="sidebar-section-title">Printer</h2>}
        <Button className="absolute right-0 bottom-0" variant="panel-toggle" size="icon-xs"
          data-testid="printer-section-toggle" onClick={() => setPrinterExpanded((value) => !value)}
          aria-label={printerExpanded ? 'Collapse printer' : 'Expand printer'} aria-expanded={printerExpanded}
          aria-controls="printer-section-content">
          {printerExpanded ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </div>
      <div id="printer-section-content" hidden={!printerExpanded} className="px-2 pt-1">
        <div id="printer-device-content" hidden={activePrinterTab !== 'device'}>
        <div data-testid="printer-bed-row" className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1">
            <PresetRow
              compact
              label="Printer"
              modified={printerModified}
              items={printerPicker.items.map(item => ({ id: item.id, name: item.preset, label: item.label }))}
              value={printerPicker.selectedId}
              onValue={(id) => {
                const target = printerPicker.items.find(item => item.id === id);
                if (target && target.preset !== selectedPrinter) void handleSelectPreset('printer', target.preset);
              }}
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
        <div data-testid="printer-nozzle-row" className={cn('flex min-w-0 items-center gap-1 pt-1', multiExtruder && 'printer-nozzle-multi-row')}>
          <Button type="button" variant="settings" size="icon-sm"
            aria-label="Sync nozzle" title="Sync nozzle" data-testid="nozzle-sync-placeholder"
            disabled={controlsDisabled}><RefreshCw data-icon="inline-start" /></Button>
          <div className={cn('flex min-w-0 flex-1 items-center', multiExtruder ? 'gap-1 printer-nozzle-multi-controls' : 'printer-nozzle-single-controls', !multiExtruder && bedVisible && 'printer-nozzle-align-bed')}>
          <Select items={printerPicker.variants.map(item => ({ value: item.value, label: item.value }))}
            value={printerPicker.selectedVariant || null}
            disabled={controlsDisabled || printerPicker.variants.length === 0}
            onValueChange={(value) => {
              const target = printerPicker.variants.find(item => item.value === value);
              if (!target) throw new Error('Nozzle variant has no canonical profile target');
              if (value !== printerPicker.selectedVariant)
                void handleSelectPreset('printer', target.preset);
            }}>
            <SelectTrigger variant="sidebar" className={cn('min-w-0 flex-1', multiExtruder && 'printer-nozzle-multi-selector')} data-testid="nozzle-variant-select"
              aria-label="Nozzle diameter and variant" title={printerPicker.selectedVariant}>
              <span className="shrink-0 text-muted-foreground font-semibold">Nozzle</span>
              <SelectValue className={multiExtruder ? undefined : 'pl-4'}>{printerPicker.selectedVariant || '—'}</SelectValue>
            </SelectTrigger>
            <SelectContent><SelectGroup>{printerPicker.variants.map(item =>
              <SelectItem key={item.value} value={item.value}>{item.value}</SelectItem>
            )}</SelectGroup></SelectContent>
          </Select>
          {!multiExtruder && <Select value={nozzleVolumeTypes[0] ?? null} disabled>
            <SelectTrigger variant="sidebar" className="min-w-0 flex-1 printer-flow-selector" aria-label="Nozzle flow type"
              data-testid="nozzle-flow-select" title="Flow type selection is not available yet">
              <SelectValue>{nozzleVolumeTypes[0] ?? '—'}</SelectValue>
            </SelectTrigger>
          </Select>}
          {multiExtruder && <div className="printer-nozzle-extruders" aria-label="Extruder nozzles">
            {nozzleDiameters.map((diameter, index) => {
              // Native ConfigOptionVector::get_at repeats its first value for
              // extruders beyond the serialized vector length.
              const flow = nozzleVolumeTypes[index] ?? nozzleVolumeTypes[0];
              return <div key={index} data-testid={`nozzle-extruder-${index + 1}`} className="printer-nozzle-extruder"
                title={`Extruder ${index + 1}: ${diameter} mm${flow ? `, ${flow}` : ''}`}>
                <span className="text-foreground">{index + 1}</span>
                <span>{diameter}</span>
                <span>{flow ? flowLabels[flow] ?? flow : '—'}</span>
              </div>;
            })}
          </div>}
          </div>
        </div>
        </div>
        {multiExtruder && <div id="printer-multi-content" hidden={activePrinterTab !== 'multi'} className="flex flex-col gap-1">
          <Label className="text-muted-foreground font-semibold">Toolheads</Label>
          <div className="printer-toolhead-list" role="group" aria-label="Toolheads">
            {nozzleDiameters.map((diameter, index) => {
              const flow = nozzleVolumeTypes[index] ?? nozzleVolumeTypes[0];
              return <Button key={index} type="button" variant="ghost"
                className="printer-nozzle-extruder printer-toolhead" data-active={activeToolhead === index}
                data-testid={`toolhead-${index + 1}`} aria-pressed={activeToolhead === index}
                aria-label={`Toolhead ${index + 1}: ${diameter} mm${flow ? `, ${flow}` : ''}`}
                onClick={() => setToolhead(index)} disabled={controlsDisabled}>
                <span className="text-foreground">{index + 1}</span><span>{diameter}</span>
                <span>{flow ? flowLabels[flow] ?? flow : '—'}</span>
              </Button>;
            })}
          </div>
          <div className="flex min-w-0 gap-2">
            <Select items={printerPicker.nozzleDiameters.map(diameter => ({ value: String(diameter), label: String(diameter) }))}
              value={nozzleDiameters[activeToolhead]} disabled={controlsDisabled}
              onValueChange={value => value !== null && void handleToolheadDiameter(value)}>
              <SelectTrigger variant="sidebar" className="min-w-0 flex-1" aria-label="Toolhead nozzle diameter"
                data-testid="toolhead-diameter-select"><SelectValue>{nozzleDiameters[activeToolhead]}</SelectValue></SelectTrigger>
              <SelectContent><SelectGroup>{printerPicker.nozzleDiameters.map(diameter =>
                <SelectItem key={diameter} value={String(diameter)}>{diameter}</SelectItem>
              )}</SelectGroup></SelectContent>
            </Select>
            <Select value={nozzleVolumeTypes[activeToolhead] ?? nozzleVolumeTypes[0] ?? null} disabled>
              <SelectTrigger variant="sidebar" className="min-w-0 flex-1" aria-label="Toolhead flow type"
                data-testid="toolhead-flow-select" title="Flow type selection is not available yet">
                <SelectValue>{nozzleVolumeTypes[activeToolhead] ?? nozzleVolumeTypes[0] ?? '—'}</SelectValue>
              </SelectTrigger>
            </Select>
          </div>
        </div>}
      </div>
    </section>
  );
  const settings = !metadata ? <div className="p-3 text-xs text-muted-foreground">Loading presets…</div> : (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden px-2 pb-2">
      <ScopedConfigurationPanel
        bedTypeDisabled={controlsDisabled}
        sceneInteraction={sceneInteraction}
        projectContent={<PresetRow compact modified={false} label="Process" items={prints.map(preset => ({ id: preset.name, name: preset.source_name ?? preset.name, label: preset.label }))} value={selectedPrint} onValue={(v) => handleSelectPreset('print', v)} disabled={controlsDisabled} testId="process-preset-select" />}
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
function PresetRow({ label, items, value, onValue, onEdit, disabled, testId, compact = false, modified }: {
  modified: boolean;
  compact?: boolean;
  label: string;
  items: PresetComboItem[];
  value: string;
  onValue: (id: string) => void;
  onEdit?: () => void;
  disabled: boolean;
  testId?: string;
}) {
  if (items.length === 0) return null;
  return <div className={cn(compact ? "min-w-0" : "flex flex-col gap-1 py-1")}>
    <Label className={compact ? "sr-only" : "text-xs text-muted-foreground"}>{label}</Label>
    <PresetCombobox items={items} value={value} onValue={onValue} disabled={disabled} modified={modified}
      ariaLabel={label} testId={testId} searchPlaceholder="Search presets…" emptyText="No matching presets"
      leading={onEdit && <Button type="button" variant="settings" size="icon-sm"
        aria-label="Edit Printer" title="Printer settings" data-testid="preset-edit-printer"
        disabled={disabled || value.length === 0} onClick={onEdit}><SlidersHorizontal /></Button>} />
  </div>;
}
