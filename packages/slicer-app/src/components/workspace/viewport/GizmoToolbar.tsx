import { glVolumeCollection } from './GLVolume';
import { meshBooleanTarget } from './gizmo/meshBoolean/MeshBooleanSession';
// Left-side vertical scene toolbar: Add Model first, followed by arrangement
// and the Move / Rotate / Scale gizmo toggles. The gizmos never
// auto-open on selection — arming happens here, and an emptied selection
// auto-closes them (see SceneInteractionController.toggleGizmo). The toolbar
// overlays the canvas (outside the R3F tree). Selection and the armed gizmo
// are observed separately so transform frames do not rerender the toolbar.
import { FolderPlus, Move, Rotate3d, Scaling, Combine, Paintbrush, Scissors, Sparkles, Blocks, Ruler } from 'lucide-react';
import type { PaintingChannel } from '@slicer/client';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { TooltipFor } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { addModel } from '../actions/sceneActions';
import type { OpenGizmo, SceneInteractionController } from './SceneInteractionController';
import { paintingTarget, usePaintingController, usePaintingState } from './gizmo/painting/PaintingProvider';
import { useFilamentSessionStore } from '@/stores/useFilamentSessionStore';
import { ArrangementButton } from '../arrangement/ArrangementControls';
import { closeMeasureForCommand, measureSessionActive } from './gizmo/measure/projectCommands';

const GIZMO_BUTTONS: ReadonlyArray<{
  mode: Exclude<OpenGizmo, null>;
  label: string;
  icon: typeof Move;
  testId: string;
}> = [
  { mode: 'move', label: 'Move', icon: Move, testId: 'gizmo-btn-move' },
  { mode: 'rotate', label: 'Rotate', icon: Rotate3d, testId: 'gizmo-btn-rotate' },
  { mode: 'scale', label: 'Scale', icon: Scaling, testId: 'gizmo-btn-scale' },
  { mode: 'mesh-boolean', label: 'Mesh Boolean', icon: Combine, testId: 'gizmo-btn-mesh-boolean' },
  { mode: 'measure', label: 'Measure', icon: Ruler, testId: 'gizmo-btn-measure' },
];

export function GizmoToolbar({
  sceneInteraction,
  onModelAdded,
  arrangementOpen,
  onArrangementOpenChange,
}: {
  sceneInteraction: SceneInteractionController | null;
  onModelAdded?: () => void;
  arrangementOpen: boolean;
  onArrangementOpenChange: (open: boolean) => void;
}) {
  const selection = sceneInteraction?.selection;
  const subscribeSelection = useCallback(
    (listener: () => void) => selection?.subscribe(listener) ?? (() => {}),
    [selection],
  );
  const subscribeGizmo = useCallback(
    (listener: () => void) => sceneInteraction?.subscribe(listener) ?? (() => {}),
    [sceneInteraction],
  );
  useSyncExternalStore(subscribeSelection, () => selection?.revision ?? 0);
  const gizmo = useSyncExternalStore(subscribeGizmo, () => sceneInteraction?.gizmo ?? null);
  const platform = usePlatform();
  const painting = usePaintingController();
  const paintState = usePaintingState();
  const slotCount = useFilamentSessionStore((s) => s.snapshot?.slots.length ?? 0);
  const paintActive = paintState != null && paintState.phase !== 'closed';
  useEffect(() => {
    if (gizmo || paintActive) onArrangementOpenChange(false);
  }, [gizmo, paintActive, onArrangementOpenChange]);
  // Boot loads the printer/process lists and the rack's filament catalogue
  // atomically; until they
  // arrive (or if boot fails) Add Model stays disabled — a model without
  // presets can't be configured or sliced. Unlike the gizmo toggles it is
  // NOT gated on a selection: importing onto an empty plate is the point.
  const presetsLoaded = useSettingsStore(
    (s) => s.printers.length > 0 && s.prints.length > 0 && s.filamentCatalog.length > 0,
  );
  if (!sceneInteraction) return null;
  const towerSelected = sceneInteraction.hasWipeTowerSelection;
  const openPainting = (channel: PaintingChannel) => {
    if (!painting) return;
    const target = paintingTarget(sceneInteraction);
    if (!target) return;
    const closingMeasure = sceneInteraction.gizmo === 'measure' || measureSessionActive();
    sceneInteraction.closeGizmo();
    if (!closingMeasure) { void painting.open(target.objectId, target.instanceId, channel); return; }
    void closeMeasureForCommand().then(() => {
      const current = paintingTarget(sceneInteraction);
      if (sceneInteraction.gizmo === null && current?.objectId === target.objectId && current.instanceId === target.instanceId)
        void painting.open(target.objectId, target.instanceId, channel);
    });
  };
  // The tower is a tagged shared scene volume.  Its identity restricts the
  // ordinary toolbar to Move; Rotate and Scale remain unavailable.
  return (
    <div
      className="pointer-events-auto flex max-h-full shrink-0 flex-col items-center gap-1 overflow-y-auto rounded-md bg-card p-1"
      data-testid="gizmo-toolbar"
      role="toolbar"
      aria-label="Scene tools"
      aria-orientation="vertical"
    >
      <TooltipFor content="Add Model" disabled={!presetsLoaded}>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => { onArrangementOpenChange(false); void addModel(platform, sceneInteraction, onModelAdded); }}
          disabled={!presetsLoaded || !!painting?.unfinished}
          aria-label="Add Model"
          data-testid="btn-add-model"
        >
          <FolderPlus />
        </Button>
      </TooltipFor>
      <Separator className="my-0.5 w-6 shrink-0" />
      <ArrangementButton sceneInteraction={sceneInteraction} open={arrangementOpen} onOpenChange={onArrangementOpenChange} />
      {GIZMO_BUTTONS.map(({ mode, label, icon: Icon, testId }) => {
        const towerMode = towerSelected && mode === 'move';
        const armed = sceneInteraction.gizmo === mode;
        const disabled = (towerSelected ? !towerMode : sceneInteraction.selection.empty) || (paintActive && paintState?.phase !== 'idle') ||
          (mode === 'measure' && !armed && !!platform.runtime.getRuntimeExecutionState?.().serialSliceActive) ||
          (mode === 'mesh-boolean' && ((!armed && !meshBooleanTarget(sceneInteraction.selectedVolumes(), glVolumeCollection.volumes)) ||
            !!platform.runtime.getRuntimeExecutionState?.().sliceActive));
        return (
          <TooltipFor key={mode} content={label} disabled={disabled}>
            <Button
              variant="gizmo"
              size="icon"
              aria-label={label}
              aria-pressed={armed}
              disabled={disabled}
              data-testid={testId}
              onClick={() => {
                onArrangementOpenChange(false);
                if (painting?.active) void painting.close().then((closed) => { if (closed) sceneInteraction.toggleGizmo(mode); });
                else sceneInteraction.toggleGizmo(mode);
              }}
            >
              <Icon />
            </Button>
          </TooltipFor>
        );
      })}
      <TooltipFor content="Support painting">
        <Button size="icon" variant="gizmo" aria-label="Support painting" aria-pressed={paintActive && paintState?.channel === 'support'} data-testid="gizmo-btn-support"
          disabled={paintActive ? paintState?.phase !== 'idle' : !paintingTarget(sceneInteraction) || platform.runtime.getRuntimeExecutionState?.().serialSliceActive}
          onClick={() => {
            if (!painting) return;
            onArrangementOpenChange(false);
            if (painting.active && paintState?.channel === 'support') { void painting.close(); return; }
            openPainting('support');
          }}><Blocks /></Button>
      </TooltipFor>
      <TooltipFor content="Seam painting">
        <Button size="icon" variant="gizmo" aria-label="Seam painting" aria-pressed={paintActive && paintState?.channel === 'seam'} data-testid="gizmo-btn-seam"
          disabled={paintActive ? paintState?.phase !== 'idle' : !paintingTarget(sceneInteraction) || platform.runtime.getRuntimeExecutionState?.().serialSliceActive}
          onClick={() => {
            if (!painting) return;
            onArrangementOpenChange(false);
            if (painting.active && paintState?.channel === 'seam') { void painting.close(); return; }
            openPainting('seam');
          }}><Scissors /></Button>
      </TooltipFor>
      <TooltipFor content="Fuzzy skin painting">
        <Button size="icon" variant="gizmo" aria-label="Fuzzy skin painting" aria-pressed={paintActive && paintState?.channel === 'fuzzy'} data-testid="gizmo-btn-fuzzy"
          disabled={paintActive ? paintState?.phase !== 'idle' : !paintingTarget(sceneInteraction) || platform.runtime.getRuntimeExecutionState?.().serialSliceActive}
          onClick={() => {
            if (!painting) return;
            onArrangementOpenChange(false);
            if (painting.active && paintState?.channel === 'fuzzy') { void painting.close(); return; }
            openPainting('fuzzy');
          }}><Sparkles /></Button>
      </TooltipFor>
      <TooltipFor content="Surface painting">
        <Button size="icon" variant="gizmo" aria-label="Surface painting" aria-pressed={paintActive && paintState?.channel === 'mmu'} data-testid="gizmo-btn-paint"
          disabled={paintActive && paintState?.channel === 'mmu' ? paintState?.phase !== 'idle' : slotCount < 2 || (paintActive ? paintState?.phase !== 'idle' : !paintingTarget(sceneInteraction) || platform.runtime.getRuntimeExecutionState?.().serialSliceActive)}
          onClick={() => {
            if (!painting) return;
            onArrangementOpenChange(false);
            if (painting.active && paintState?.channel === 'mmu') { void painting.close(); return; }
            openPainting('mmu');
          }}><Paintbrush /></Button>
      </TooltipFor>
    </div>
  );
}
