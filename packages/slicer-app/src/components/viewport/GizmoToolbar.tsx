// Top-of-viewport gizmo toolbar: Move / Rotate / Scale toggles. The gizmos
// never auto-open on selection — arming happens here, and an emptied
// selection auto-closes them (see SceneInteractionController.toggleGizmo).
// The toolbar overlays the canvas (outside the R3F tree), so it subscribes
// through the explicit-controller hook, like the transform panels.
import { Move, Rotate3d, Scaling } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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

export function GizmoToolbar({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  useSceneInteractionVersion(sceneInteraction ?? undefined);
  if (!sceneInteraction) return null;
  // The gizmos can only arm with a non-empty selection — the controller's
  // toggleGizmo also refuses, and the buttons' disabled state surfaces it.
  const disabled = sceneInteraction.selection.empty;
  return (
    <div
      className="absolute top-2 left-1/2 flex -translate-x-1/2 gap-1 rounded-md border bg-card/90 p-1 backdrop-blur"
      data-testid="gizmo-toolbar"
    >
      {GIZMO_BUTTONS.map(({ mode, label, icon: Icon, testId }) => {
        const armed = sceneInteraction.gizmo === mode;
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
