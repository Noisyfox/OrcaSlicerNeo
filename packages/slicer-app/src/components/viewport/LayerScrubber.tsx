// apps/desktop/src/renderer/src/components/viewport/LayerScrubber.tsx
import { useSlicerStore } from '../../stores/useSlicerStore';
import { Slider } from '@/components/ui/slider';
import { Label } from '@/components/ui/label';

export function LayerScrubber() {
  const layer = useSlicerStore((s) => s.layer);
  const maxLayer = useSlicerStore((s) => s.maxLayer);
  const setLayer = useSlicerStore((s) => s.setLayer);

  if (maxLayer <= 0) return null;

  return (
    <div className="absolute bottom-3 left-1/2 w-96 -translate-x-1/2 rounded-md border bg-card/90 p-3 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">Layer</Label>
        <span className="text-xs tabular-nums text-muted-foreground">
          {layer + 1} / {maxLayer + 1}
        </span>
      </div>
      <Slider
        min={0}
        max={maxLayer}
        step={1}
        value={[layer]}
        onValueChange={(v) => setLayer(Array.isArray(v) ? v[0] : v)}
        data-testid="layer-scrubber"
      />
    </div>
  );
}
