// Top-of-viewport gizmo toolbar. One toggle: the move gizmo. The gizmo never
// auto-opens on selection — arming happens here, and an emptied selection
// auto-closes it (see SceneInteractionController.toggleGizmo). The toolbar
// overlays the canvas (outside the R3F tree), so it subscribes through the
// explicit-controller hook, like MovePanel.
import { Move } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSceneInteractionVersion } from './SceneInteractionContext';
import type { SceneInteractionController } from './SceneInteractionController';

export function GizmoToolbar({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  useSceneInteractionVersion(sceneInteraction ?? undefined);
  if (!sceneInteraction) return null;
  const armed = sceneInteraction.gizmo === 'move';
  return (
    <div
      className="absolute top-2 left-1/2 flex -translate-x-1/2 gap-1 rounded-md border bg-card/90 p-1 backdrop-blur"
      data-testid="gizmo-toolbar"
    >
      <Button
        variant="ghost"
        size="icon"
        title="Move"
        aria-pressed={armed}
        data-testid="gizmo-btn-move"
        className={cn(armed && 'bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground')}
        onClick={() => sceneInteraction.toggleGizmo()}
      >
        <Move />
      </Button>
    </div>
  );
}
