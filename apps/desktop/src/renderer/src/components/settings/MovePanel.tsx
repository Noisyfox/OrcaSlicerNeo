// Scene-selection move panel. X/Y/Z are the aggregate selection pivot; a
// numeric edit translates the whole selection by the corresponding delta.
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { formatPosition, parseNumberInput } from '../viewport/transformMath';
import { useSceneInteractionVersion } from '../viewport/SceneInteractionContext';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import type { Vec3 } from '../../lib/vec3';

const AXES = ['x', 'y', 'z'] as const;

export function MovePanel({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const version = useSceneInteractionVersion(sceneInteraction ?? undefined);
  const pivot = sceneInteraction?.selectionPivot() ?? null;
  const current = pivot ? pivot.toArray() as Vec3 : null;
  const [draft, setDraft] = useState<[string, string, string] | null>(null);
  const currentKey = current?.join(',') ?? '';

  useEffect(() => { setDraft(null); }, [currentKey]);

  if (!sceneInteraction || !current) return null;

  const moveTo = (next: Vec3) => {
    sceneInteraction.moveSelectionToPivot(new THREE.Vector3(...next));
  };

  const submitAxis = (axis: number, text: string) => {
    const parsed = parseNumberInput(text);
    if (parsed === null) {
      setDraft(null);
      return;
    }
    const next = [...current] as Vec3;
    next[axis] = parsed;
    moveTo(next);
  };

  return (
    <section data-testid="move-panel" data-selection-version={version}>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Move</h2>
      <div className="space-y-1">
        {AXES.map((axis, i) => (
          <div key={axis} className="flex items-center gap-2 py-1">
            <Label className="w-10 shrink-0 text-xs text-muted-foreground">{axis.toUpperCase()}</Label>
            <Input
              data-testid={`move-${axis}`}
              className="flex-1"
              value={draft?.[i] ?? formatPosition(current[i])}
              onChange={(event) => {
                const nextDraft = [...(draft ?? current.map(formatPosition))] as [string, string, string];
                nextDraft[i] = event.target.value;
                setDraft(nextDraft);
              }}
              onBlur={(event) => submitAxis(i, event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="secondary"
          data-testid="move-drop-bed"
          onClick={() => sceneInteraction.dropSelectionToBed()}
        >
          Drop to bed
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="move-reset"
          onClick={() => sceneInteraction.resetSelection()}
        >
          Reset
        </Button>
      </div>
    </section>
  );
}
