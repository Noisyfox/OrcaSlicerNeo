// apps/desktop/src/renderer/src/components/settings/MovePanel.tsx
// Gizmo options panel (sidebar) for the move tool: numeric X/Y/Z position
// inputs (commit on blur/Enter), Drop to bed, Reset. Reads and writes the
// store's per-object transform maps through the shared bridge commit.
import { useEffect, useState } from 'react';
import { useSettingsStore } from '../../stores/useSettingsStore';
import { useSlicerStore } from '../../stores/useSlicerStore';
import { slicerClient } from '../../slicer/slicerClient';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { commitPosition } from '../viewport/gizmo/commitPosition';
import { computeDropZ, formatPosition, parseNumberInput } from '../viewport/transformMath';
import type { Vec3 } from '../../lib/vec3';

const AXES = ['x', 'y', 'z'] as const;

export function MovePanel() {
  const objectIdx = useSettingsStore((s) => s.selectedObject);
  const positions = useSettingsStore((s) => s.positions);
  const initialPositions = useSettingsStore((s) => s.initialPositions);
  const objectMinZ = useSettingsStore((s) => s.objectMinZ);
  const setError = useSlicerStore((s) => s.setError);
  const current = objectIdx != null ? positions[objectIdx] : undefined;
  // Local edit drafts; reset whenever the committed position changes
  // (viewport drags, commits, selection change).
  const [draft, setDraft] = useState<[string, string, string] | null>(null);

  const currentKey = current?.join(',') ?? '';
  useEffect(() => { setDraft(null); }, [objectIdx, currentKey]);

  if (objectIdx == null || !current || objectMinZ[objectIdx] === undefined) return null;

  // Arrow consts (not hoisted function declarations): TS control-flow
  // narrowing from the guard above does not reach hoisted declarations, so
  // `objectIdx`/`current` would stay number|null / Vec3|undefined in them.
  const commitTo = async (pos: Vec3) => {
    await commitPosition(slicerClient, objectIdx, pos, current, (msg) => setError(`move: ${msg}`));
    // commitPosition updates the store (pos on success, current on failure);
    // the draft resyncs through the currentKey effect either way.
  };

  const submitAxis = (axis: number, text: string) => {
    const parsed = parseNumberInput(text);
    if (parsed === null) {
      setDraft(null); // invalid input → show the committed value again
      return;
    }
    const next = [...current] as Vec3;
    next[axis] = parsed;
    void commitTo(next);
  };

  return (
    <section data-testid="move-panel">
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Move</h2>
      <div className="space-y-1">
        {AXES.map((axis, i) => (
          <div key={axis} className="flex items-center gap-2 py-1">
            <Label className="w-10 shrink-0 text-xs text-muted-foreground">{axis.toUpperCase()}</Label>
            <Input
              data-testid={`move-${axis}`}
              className="flex-1"
              value={draft?.[i] ?? formatPosition(current[i])}
              onChange={(e) => {
                const d = [...(draft ?? current.map(formatPosition))] as [string, string, string];
                d[i] = e.target.value;
                setDraft(d);
              }}
              onBlur={(e) => submitAxis(i, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
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
          onClick={() => void commitTo([current[0], current[1], computeDropZ(objectMinZ[objectIdx])])}
        >
          Drop to bed
        </Button>
        <Button
          size="sm"
          variant="secondary"
          data-testid="move-reset"
          onClick={() => void commitTo(initialPositions[objectIdx])}
        >
          Reset
        </Button>
      </div>
    </section>
  );
}
