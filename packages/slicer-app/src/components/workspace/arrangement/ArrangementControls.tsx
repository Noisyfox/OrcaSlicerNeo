import { useCallback, useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { LayoutGrid, X } from 'lucide-react';
import { usePlatform, type ArrangementPreferences } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { TooltipFor } from '@/components/ui/tooltip';
import { isSerialSliceBusy } from '@/runtimeExecution';
import {
  arrangementMode, loadArrangementPreferences, resetArrangementPreferences,
  setArrangementAlignY, synchronizeArrangementContext, updateArrangementPreferences, useArrangementStore,
} from '@/stores/useArrangementStore';
import { usePlateSessionStore } from '@/stores/usePlateSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useSlicerStore } from '@/stores/useSlicerStore';
import { arrangeModels } from '../actions/arrangementActions';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import { usePaintingController, usePaintingState } from '../viewport/gizmo/painting/PaintingProvider';

function useArrangementControls(scene: SceneInteractionController) {
  const platform = usePlatform();
  const ready = useArrangementStore((state) => state.ready);
  const active = useArrangementStore((state) => state.active);
  const modelLoaded = useSettingsStore((state) => state.modelLoaded);
  const printer = useSettingsStore((state) => state.selectedPrinter);
  const structure = useSettingsStore((state) => state.values.printer_structure ?? '');
  const sequence = useSettingsStore((state) => state.values.print_sequence);
  const sliceStatus = useSlicerStore((state) => state.status);
  const painting = usePaintingController();
  usePaintingState();
  const subscribe = useCallback((listener: () => void) => scene.subscribe(listener), [scene]);
  const owner = useSyncExternalStore(subscribe, () => scene.owner);

  useLayoutEffect(() => {
    synchronizeArrangementContext(printer, structure, sequence);
  }, [printer, structure, sequence]);
  useEffect(() => { void loadArrangementPreferences(platform.preferences); }, [platform.preferences]);

  return {
    platform, structure, mode: arrangementMode(sequence),
    disabled: !ready || active || !modelLoaded || !!painting?.unfinished || owner !== 'none' ||
      isSerialSliceBusy(platform.runtime, sliceStatus) || platform.runtime.getRuntimeExecutionState().serialSliceActive,
  };
}

export function ArrangementButton({ sceneInteraction, open, onOpenChange }: {
  sceneInteraction: SceneInteractionController;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const controls = useArrangementControls(sceneInteraction);
  const painting = usePaintingController();
  const paintState = usePaintingState();
  const disabled = controls.disabled || (painting?.active === true && !['idle', 'error'].includes(paintState?.phase ?? 'closed'));
  return (
    <TooltipFor content="Arrange models" disabled={disabled}>
      <Button variant="gizmo" size="icon" disabled={disabled}
        aria-label="Arrange models" aria-pressed={open} data-testid="arrange-menu"
        onClick={() => {
          if (open) { onOpenChange(false); return; }
          const activate = () => {
            sceneInteraction.closeGizmo();
            onOpenChange(true);
          };
          if (painting?.active) void painting.close().then((closed) => { if (closed) activate(); });
          else activate();
        }}>
        <LayoutGrid data-icon="inline-start" />
      </Button>
    </TooltipFor>
  );
}

export function ArrangementPanel({ sceneInteraction, onClose }: {
  sceneInteraction: SceneInteractionController;
  onClose: () => void;
}) {
  const { platform, structure, mode, disabled } = useArrangementControls(sceneInteraction);
  const preferences = useArrangementStore((state) => state.preferences);
  const alignY = useArrangementStore((state) => state.alignY);
  const active = useArrangementStore((state) => state.active);
  const printer = useSettingsStore((state) => state.printers.find((item) => item.name === state.selectedPrinter));
  const scansFirstLayer = useSettingsStore((state) => ['1', 'true'].includes(state.values.scan_first_layer));
  const calibrationApplicable = printer?.vendor_id === 'BBL' && scansFirstLayer;
  const [distance, setDistance] = useState(String(preferences[mode].distance));
  useEffect(() => { setDistance(String(preferences[mode].distance)); }, [mode, preferences[mode].distance]);
  useEffect(() => { if (active) onClose(); }, [active, onClose]);
  const validDistance = distance.trim() !== '' && Number.isFinite(Number(distance)) && Number(distance) >= 0;
  const update = (patch: Partial<ArrangementPreferences>) => {
    if (!disabled) void updateArrangementPreferences(platform.preferences, { ...useArrangementStore.getState().preferences, ...patch });
  };
  const updateMode = (patch: Partial<ArrangementPreferences['byLayer']>) => {
    update({ [mode]: { ...useArrangementStore.getState().preferences[mode], ...patch } });
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="arrangement-panel" aria-label="Arrange models">
      <h2 className="text-module font-semibold uppercase tracking-wide text-muted-foreground">Arrange models</h2>
      <FieldGroup>
        <Field data-disabled={disabled} data-invalid={!validDistance}>
          <FieldLabel htmlFor="arrange-distance">Spacing (mm)</FieldLabel>
          <Input id="arrange-distance" data-testid="arrange-distance" type="number" min={0} step="any"
            disabled={disabled} value={distance} aria-invalid={!validDistance}
            aria-describedby="arrange-distance-help"
            onChange={(event) => {
              const value = event.target.value;
              setDistance(value);
              if (value.trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0)
                updateMode({ distance: Number(value) });
            }} />
          <FieldDescription id="arrange-distance-help">Use 0 for automatic spacing.</FieldDescription>
          {!validDistance && <FieldError>Enter a finite distance of 0 mm or greater.</FieldError>}
        </Field>
        <FieldSet>
          <FieldLegend className="sr-only">Arrangement options</FieldLegend>
          <FieldGroup>
            <ArrangementCheckbox id="arrange-rotate" label="Auto rotate" checked={preferences[mode].rotate}
              disabled={disabled} onChange={(rotate) => updateMode({ rotate })} />
            <ArrangementCheckbox id="arrange-align-y" label="Align to Y axis" checked={alignY}
              disabled={disabled || preferences[mode].rotate} onChange={setArrangementAlignY} />
            <ArrangementCheckbox id="arrange-multiple-materials" label="Allow multiple materials on same plate"
              checked={preferences.multipleMaterials} disabled={disabled}
              onChange={(multipleMaterials) => update({ multipleMaterials })} />
            {calibrationApplicable && <ArrangementCheckbox id="arrange-avoid-calibration" label="Avoid extrusion calibration region"
              checked={preferences.avoidCalibration} disabled={disabled}
              onChange={(avoidCalibration) => update({ avoidCalibration })} />}
          </FieldGroup>
        </FieldSet>
      </FieldGroup>
      <div className="flex justify-end gap-2">
        <Button variant="outline" data-testid="arrange-reset" disabled={disabled} onClick={() => {
          setDistance('0');
          void resetArrangementPreferences(platform.preferences, mode, structure);
        }}>Reset</Button>
        <Button data-testid="arrange-all" disabled={disabled || !validDistance} onClick={() => {
          onClose();
          void arrangeModels(platform, sceneInteraction, 'all');
        }}>Arrange all</Button>
      </div>
    </section>
  );
}

function ArrangementCheckbox({ id, label, checked, disabled, onChange }: {
  id: string; label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void;
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled}>
      <Checkbox id={id} data-testid={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}

export function ArrangeCurrentPlateButton({ sceneInteraction, disabled = false, compact = false }: {
  sceneInteraction: SceneInteractionController; disabled?: boolean; compact?: boolean;
}) {
  const controls = useArrangementControls(sceneInteraction);
  const current = usePlateSessionStore((state) => state.snapshot?.plates.find((plate) => plate.plateId === state.snapshot?.currentPlateId));
  return (
    <Button size={compact ? 'sm' : 'xs'} variant="secondary" data-testid="arrange-current-plate" aria-label="Arrange current plate"
      disabled={disabled || controls.disabled || !current || current.locked}
      onClick={() => { void arrangeModels(controls.platform, sceneInteraction, 'current'); }}>
      {compact ? 'Arrange' : 'Arrange current plate'}
    </Button>
  );
}
