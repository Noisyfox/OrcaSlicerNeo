// The scale panel is part of the scale gizmo: it renders only while the gizmo
// is armed. Contents: World/Local handle-space toggle (disabled while
// multi-selected — a group scales in world space), X/Y/Z scale factors in %
// of the original size, X/Y/Z size inputs (mm — the dimensions the selection
// is scaled to), and Reset. Single selection shows the real values;
// multi-selection shows 100% factors (edits apply relatively) and the
// aggregate bounding-box size (edits scale the whole selection to it).
import { useEffect, useState } from 'react';
import * as THREE from 'three';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { formatPercent, formatPosition, parseNumberInput } from '../viewport/transformMath';
import { useSceneInteractionVersion } from '../viewport/SceneInteractionContext';
import type { SceneInteractionController } from '../viewport/SceneInteractionController';
import type { Vec3 } from '../../../lib/vec3';

const AXES = ['x', 'y', 'z'] as const;

export function ScalePanel({ sceneInteraction }: { sceneInteraction: SceneInteractionController | null }) {
  const version = useSceneInteractionVersion(sceneInteraction ?? undefined);
  const [factorDraft, setFactorDraft] = useState<[string, string, string] | null>(null);
  const [sizeDraft, setSizeDraft] = useState<[string, string, string] | null>(null);
  const multi = sceneInteraction ? sceneInteraction.selectionInstanceCount > 1 : false;
  const first = sceneInteraction?.selectedVolumes()[0];
  const factor: Vec3 = first
    ? [
      first.instanceTransform.scale[0] / first.buffer.instanceTransform.scale[0],
      first.instanceTransform.scale[1] / first.buffer.instanceTransform.scale[1],
      first.instanceTransform.scale[2] / first.buffer.instanceTransform.scale[2],
    ]
    : [1, 1, 1];
  // Multi-selection shows the neutral 100% baseline (relative editing).
  const displayedFactor = multi ? ([1, 1, 1] as Vec3) : factor;
  const bounds = sceneInteraction?.selectionBounds() ?? null;
  const size: Vec3 = bounds
    ? bounds.getSize(new THREE.Vector3()).toArray() as Vec3
    : [0, 0, 0];
  const factorKey = displayedFactor.join(',');
  const sizeKey = size.join(',');

  useEffect(() => { setFactorDraft(null); }, [factorKey]);
  useEffect(() => { setSizeDraft(null); }, [sizeKey]);
  if (!sceneInteraction || sceneInteraction.gizmo !== 'scale') return null;

  const commitFactor = (axis: number, text: string) => {
    const parsed = parseNumberInput(text);
    if (parsed === null || parsed <= 0) {
      setFactorDraft(null);
      return;
    }
    // Delta relative to the displayed baseline: single selection sets the
    // absolute factor, multi-selection scales by the entered percent.
    const factorDelta = [1, 1, 1] as Vec3;
    factorDelta[axis] = (parsed / 100) / displayedFactor[axis];
    sceneInteraction.scaleSelectionBy(factorDelta);
  };

  const commitSize = (axis: number, text: string) => {
    const parsed = parseNumberInput(text);
    if (parsed === null || parsed <= 0) {
      setSizeDraft(null);
      return;
    }
    sceneInteraction.scaleSelectionToSize(axis as 0 | 1 | 2, parsed);
  };

  const factorInput = (axis: 'x' | 'y' | 'z', i: number) => (
    <div key={`f-${axis}`} className="flex items-center gap-2 py-1">
      <Label className="w-10 shrink-0 text-xs text-muted-foreground">{axis.toUpperCase()}</Label>
      <Input
        data-testid={`scale-factor-${axis}`}
        className="flex-1"
        value={factorDraft?.[i] ?? formatPercent(displayedFactor[i])}
        onChange={(event) => {
          const nextDraft = [...(factorDraft ?? displayedFactor.map(formatPercent))] as [string, string, string];
          nextDraft[i] = event.target.value;
          setFactorDraft(nextDraft);
        }}
        onBlur={(event) => commitFactor(i, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
      <span className="w-6 shrink-0 text-xs text-muted-foreground">%</span>
    </div>
  );

  const sizeInput = (axis: 'x' | 'y' | 'z', i: number) => (
    <div key={`s-${axis}`} className="flex items-center gap-2 py-1">
      <Label className="w-10 shrink-0 text-xs text-muted-foreground">{axis.toUpperCase()}</Label>
      <Input
        data-testid={`scale-size-${axis}`}
        className="flex-1"
        value={sizeDraft?.[i] ?? formatPosition(size[i])}
        onChange={(event) => {
          const nextDraft = [...(sizeDraft ?? size.map(formatPosition))] as [string, string, string];
          nextDraft[i] = event.target.value;
          setSizeDraft(nextDraft);
        }}
        onBlur={(event) => commitSize(i, event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
      />
      <span className="w-6 shrink-0 text-xs text-muted-foreground">mm</span>
    </div>
  );

  return (
    <section data-testid="scale-panel" data-selection-version={version}>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scale</h2>
      <div className="space-y-1 pb-1">
        <Label className="text-xs text-muted-foreground">Coord</Label>
        <div className="flex gap-1">
          {(['world', 'local'] as const).map((space) => (
            <Button
              key={space}
              size="sm"
              variant="ghost"
              data-testid={`scale-space-${space}`}
              disabled={multi}
              aria-pressed={sceneInteraction.scaleSpace === space}
              className={cn(
                'capitalize',
                sceneInteraction.scaleSpace === space && 'bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground',
              )}
              onClick={() => sceneInteraction.setScaleSpace(space)}
            >
              {space}
            </Button>
          ))}
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">Scale factor</Label>
        {AXES.map(factorInput)}
        <Label className="pt-1 text-xs text-muted-foreground">Size</Label>
        {AXES.map(sizeInput)}
      </div>
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          variant="secondary"
          data-testid="scale-reset"
          onClick={() => {
            sceneInteraction.resetSelectionScale();
          }}
        >
          Reset
        </Button>
      </div>
    </section>
  );
}
