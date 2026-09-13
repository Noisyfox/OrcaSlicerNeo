// Top-of-viewport scene toolbar: Add Model first (OrcaSlicer's scene toolbar
// placement), then the Move / Rotate / Scale gizmo toggles. The gizmos never
// auto-open on selection — arming happens here, and an emptied selection
// auto-closes them (see SceneInteractionController.toggleGizmo). The toolbar
// overlays the canvas (outside the R3F tree), so it subscribes through the
// explicit-controller hook, like the transform panels.
import { FolderPlus, Move, Rotate3d, Scaling } from 'lucide-react';
import { usePlatform } from '@orca/platform-contract';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '../../../stores/useSettingsStore';
import { addModel } from '../actions/sceneActions';
import { useSceneInteractionVersion } from './SceneInteractionContext';
import type { OpenGizmo, SceneInteractionController } from './SceneInteractionController';

const GIZMO_BUTTONS: ReadonlyArray<{
  mode: Exclude<OpenGizmo, null>;
  label: string;
  icon: typeof Move;
  testId: string;
}> = [
  { mode: 'move', label: 'Move', icon: Move, testId: 'gizmo-btn-move' },
  { mode: 'rotate', label: 'Rotate', icon: Rotate3d, testId: 'gizmo-btn-rotate' },
  { mode: 'scale', label: 'Scale', icon: Scaling, testId: 'gizmo-btn-scale' },
];

export function GizmoToolbar({
  sceneInteraction,
}: {
  sceneInteraction: SceneInteractionController | null;
}) {
  useSceneInteractionVersion(sceneInteraction ?? undefined);
  const platform = usePlatform();
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
  // The tower is a tagged shared scene volume.  Its identity restricts the
  // ordinary toolbar to Move; Rotate and Scale remain unavailable.
  return (
    <div
      className="absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md border bg-card/90 p-1 backdrop-blur"
      data-testid="gizmo-toolbar"
    >
      <Button
        size="icon"
        variant="ghost"
        onClick={() => void addModel(platform, sceneInteraction)}
        disabled={!presetsLoaded}
        title="Add Model"
        aria-label="Add Model"
        data-testid="btn-add-model"
      >
        <FolderPlus />
      </Button>
      <div className="mx-0.5 h-4 w-px bg-border/60" aria-hidden="true" />
      {GIZMO_BUTTONS.map(({ mode, label, icon: Icon, testId }) => {
        const towerMode = towerSelected && mode === 'move';
        const armed = sceneInteraction.gizmo === mode;
        const disabled = towerSelected ? !towerMode : sceneInteraction.selection.empty;
        return (
          <Button
            key={mode}
            variant="ghost"
            size="icon"
            title={label}
            aria-pressed={armed}
            disabled={disabled}
            data-testid={testId}
            className={cn(armed && 'bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground')}
            onClick={() => sceneInteraction.toggleGizmo(mode)}
          >
            <Icon />
          </Button>
        );
      })}
    </div>
  );
}
