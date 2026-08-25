// The rotate panel is part of the rotate gizmo: it renders only while the
// gizmo is armed. X/Y/Z inputs in degrees (stored as radians, ZYX order).
// Single selection shows the object's rotation; multi-selection always shows
// 0 and edits apply as relative deltas to every selected object, preserving
// relative orientations.
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  degreesToRadians,
  formatDegrees,
  parseNumberInput,
  radiansToDegrees,
} from '../viewport/transformMath';
import { useSceneInteractionVersion } from '../viewport/SceneInteractionContext';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import type { Vec3 } from '../../../lib/vec3';
import { persistSettledModelTransforms } from '../actions/persistModelTransforms';
import { usePlatform } from '@orca/platform-contract';

const AXES = ['x', 'y', 'z'] as const;

export function RotatePanel({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const platform = usePlatform();
  const version = useSceneInteractionVersion(sceneInteraction ?? undefined);
  const [draft, setDraft] = useState<[string, string, string] | null>(null);
  const multi = sceneInteraction ? sceneInteraction.selectionInstanceCount > 1 : false;
  const first = sceneInteraction?.selectedVolumes()[0];
  const radians: Vec3 = first ? first.instanceTransform.rotation : [0, 0, 0];
  // Multi-selection always shows the neutral 0 baseline (relative editing).
  const current = multi ? ([0, 0, 0] as Vec3) : radiansToDegrees(radians);
  const currentKey = current.join(',');

  useEffect(() => { setDraft(null); }, [currentKey]);
  if (!sceneInteraction || sceneInteraction.gizmo !== 'rotate') return null;

  const commit = (axis: number, text: string) => {
    const parsed = parseNumberInput(text);
    if (parsed === null) {
      setDraft(null);
      return;
    }
    const delta = [0, 0, 0] as Vec3;
    delta[axis] = parsed - current[axis];
    if (sceneInteraction.rotateSelectionBy(degreesToRadians(delta))) {
      void persistSettledModelTransforms(platform.runtime);
    }
  };

  return (
    <section data-testid="rotate-panel" data-selection-version={version}>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Rotate</h2>
      <div className="space-y-1">
        {AXES.map((axis, i) => (
          <div key={axis} className="flex items-center gap-2 py-1">
            <Label className="w-10 shrink-0 text-xs text-muted-foreground">{axis.toUpperCase()}</Label>
            <Input
              data-testid={`rotate-${axis}`}
              className="flex-1"
              value={draft?.[i] ?? formatDegrees(current[i])}
              onChange={(event) => {
                const nextDraft = [...(draft ?? current.map(formatDegrees))] as [string, string, string];
                nextDraft[i] = event.target.value;
                setDraft(nextDraft);
              }}
              onBlur={(event) => commit(i, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              }}
            />
            <span className="w-6 shrink-0 text-xs text-muted-foreground">°</span>
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="secondary"
          data-testid="rotate-reset"
          onClick={() => {
            if (sceneInteraction.resetSelectionRotation()) void persistSettledModelTransforms(platform.runtime);
          }}
        >
          Reset
        </Button>
      </div>
    </section>
  );
}
