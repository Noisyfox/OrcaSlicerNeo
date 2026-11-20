import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { usePlatform } from '@orca/platform-contract';
import type { MixedFilamentPoint, MixedFilamentRecipe } from '@slicer/client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function PercentageInput({
  value,
  min,
  max,
  label,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  onChange: (n: number) => void;
}) {
  const [typing, setTyping] = useState<string>();
  return (
    <Input
      aria-label={label}
      className="h-6 w-16 tabular-nums"
      type="number"
      min={min}
      max={max}
      disabled={disabled}
      value={typing ?? value}
      onChange={(e) => {
        const text = e.currentTarget.value,
          next = e.currentTarget.valueAsNumber;
        setTyping(text);
        if (next >= min && next <= max) onChange(next);
      }}
      onBlur={(e) => {
        const n = e.currentTarget.valueAsNumber;
        const next = Math.min(max, Math.max(min, n));
        if (Number.isFinite(next) && next !== value) onChange(next);
        setTyping(undefined);
      }}
    />
  );
}

export function setRatio(ratios: number[], index: number, value: number) {
  const next = [...ratios];
  const others = next.map((_, i) => i).filter((i) => i !== index);
  next[index] = Math.max(10, Math.min(100 - others.length * 10, Math.round(value)));
  let remainder = 100 - next[index];
  if (others.length === 2) {
    const [a, b] = others;
    next[a] = Math.max(
      10,
      Math.min(remainder - 10, Math.round((remainder * ratios[a]) / (ratios[a] + ratios[b]))),
    );
    remainder -= next[a];
  }
  next[others[others.length - 1]] = remainder;
  return next;
}

export function RatioTriangle({
  ratios,
  colours,
  disabled,
  onChange,
}: {
  ratios: number[];
  colours: (string | undefined)[];
  disabled: boolean;
  onChange: (value: number[]) => void;
}) {
  const { runtime } = usePlatform();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [first, second, third] = colours;
  useEffect(() => {
    const surface = canvas.current;
    if (!surface) return;
    const context = surface.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, surface.width, surface.height);
    if (!first || !second || !third) return;

    let active = true;
    void runtime.getMixTrianglePalette([first, second, third]).then(({ width, height, pixels }) => {
      if (!active) return;
      surface.width = width;
      surface.height = height;
      const image = context.createImageData(width, height);
      image.data.set(pixels);
      context.putImageData(image, 0, 0);
    }).catch(() => {
      // Keep the outline and component markers available if the palette fails.
    });
    return () => { active = false; };
  }, [runtime, first, second, third]);

  function move(e: PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) * 100 / rect.width;
    const y = (e.clientY - rect.top) * 80 / rect.height;
    const top = (79 - y) / 78;
    const right = (x - 1) / 98 - top / 2;
    const weights = [top, 1 - top - right, right].map((w) => Math.max(0, w));
    const sum = weights.reduce((a, b) => a + b, 0);
    const [a, b] = weights.map((w) => Math.round((70 * w) / sum));
    const left = Math.min(b, 70 - a);
    onChange([10 + a, 10 + left, 80 - a - left]);
  }
  const y = (ratios[0] - 10) / 70;
  const x = (ratios[2] - 10) / 70 + y / 2;
  return (
    <div className="relative mx-auto aspect-[5/4] w-36">
      <canvas ref={canvas} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />
      <svg
        viewBox="0 0 100 80"
        className="relative block size-full touch-none"
        role="img"
        aria-label="Drag to set the three component percentages"
        onPointerDown={(e) => {
          if (disabled) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          move(e);
        }}
        onPointerMove={(e) => {
          if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) move(e);
        }}
      >
        <polygon points="50,1 1,79 99,79" className="fill-none stroke-border" />
        {[
          [50, 3],
          [3, 77],
          [97, 77],
        ].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="3" fill={colours[i] ?? 'transparent'} />
        ))}
        <circle cx={1 + 98 * x} cy={79 - 78 * y} r="4" className="fill-primary-foreground stroke-background" />
      </svg>
    </div>
  );
}

export function gradientPoints(recipe: MixedFilamentRecipe): MixedFilamentPoint[] {
  return recipe.points.length
    ? recipe.points
    : [
        { x: 0, y: recipe.reverse ? 0.1 : 0.9, in: null, out: null },
        { x: 1, y: recipe.reverse ? 0.9 : 0.1, in: null, out: null },
      ];
}

export function GradientControls({
  recipe,
  samples,
  disabled,
  onChange,
}: {
  recipe: MixedFilamentRecipe;
  samples: readonly number[];
  disabled: boolean;
  onChange: (patch: Partial<MixedFilamentRecipe>) => void;
}) {
  const points = gradientPoints(recipe);
  const perPartId = useId();
  const dragging = useRef<number | null>(null);
  function drag(e: PointerEvent<SVGSVGElement>) {
    const i = dragging.current;
    if (i === null || disabled) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width,
      y = 1 - (e.clientY - rect.top) / rect.height;
    onChange({
      points: points.map((p, j) =>
        j !== i
          ? p
          : {
              ...p,
              x:
                i === 0 || i === points.length - 1
                  ? p.x
                  : Math.min(points[i + 1].x - 0.001, Math.max(points[i - 1].x + 0.001, x)),
              y: Math.min(0.9, Math.max(0.1, y)),
            },
      ),
    });
  }
  function update(i: number, axis: 'x' | 'y', percent: number) {
    const min = axis === 'x' ? points[i - 1].x + 0.001 : 0.1;
    const max = axis === 'x' ? points[i + 1].x - 0.001 : 0.9;
    onChange({
      points: points.map((p, j) =>
        j === i ? { ...p, [axis]: Math.min(max, Math.max(min, percent / 100)) } : p,
      ),
    });
  }
  function add() {
    let end = 1;
    for (let i = 2; i < points.length; i++)
      if (points[i].x - points[i - 1].x > points[end].x - points[end - 1].x) end = i;
    const a = points[end - 1],
      b = points[end];
    onChange({
      points: [
        ...points.slice(0, end),
        { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, in: null, out: null },
        ...points.slice(end),
      ],
    });
  }
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 font-medium">Gradient control points</legend>
      <svg
        role="img"
        aria-label="First filament percentage by relative height"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-28 w-full touch-none overflow-visible rounded border bg-muted/30"
        onPointerMove={drag}
        onPointerUp={() => {
          dragging.current = null;
        }}
        onPointerCancel={() => {
          dragging.current = null;
        }}
      >
        <polyline
          fill="none"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          points={samples.map((y, i) => `${(100 * i) / (samples.length - 1)},${100 * (1 - y)}`).join(' ')}
        />
        {points.map((p, i) => (
          <ellipse
            key={i}
            cx={100 * p.x}
            cy={100 * (1 - p.y)}
            rx="1.6"
            ry="4"
            className="cursor-grab fill-primary"
            onPointerDown={(e) => {
              if (disabled) return;
              dragging.current = i;
              e.currentTarget.ownerSVGElement?.setPointerCapture(e.pointerId);
            }}
          />
        ))}
      </svg>
      {points.map((p, i) => (
        <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Label>
            Height %
            <PercentageInput
              value={Number((100 * p.x).toFixed(2))}
              min={0}
              max={100}
              label="Height %"
              disabled={disabled || !i || i === points.length - 1}
              onChange={(v) => update(i, 'x', v)}
            />
          </Label>
          <Label>
            First filament %
            <PercentageInput
              value={Number((100 * p.y).toFixed(2))}
              min={10}
              max={90}
              label="First filament %"
              disabled={disabled}
              onChange={(v) => update(i, 'y', v)}
            />
          </Label>
          {i > 0 && i < points.length - 1 && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onChange({ points: points.filter((_, j) => i !== j) })}
            >
              Remove
            </Button>
          )}
        </div>
      ))}
      <div className="flex gap-2">
        <Button size="xs" variant="secondary" onClick={add}>
          Add point
        </Button>
        <Button
          size="xs"
          variant="secondary"
          onClick={() =>
            onChange({
              reverse: !recipe.reverse,
              points: points.map((p) => ({
                ...p,
                y: Number((1 - p.y).toFixed(12)),
                in: p.in === null ? null : -p.in,
                out: p.out === null ? null : -p.out,
              })),
            })
          }
        >
          Reverse direction
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox
          id={perPartId}
          checked={recipe.perPart}
          disabled={disabled}
          onCheckedChange={(perPart) => onChange({ perPart })}
        />
        <Label htmlFor={perPartId}>Per-part gradient</Label>
      </div>
    </fieldset>
  );
}
