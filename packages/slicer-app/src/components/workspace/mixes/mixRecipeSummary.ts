import type { FilamentSessionSlot } from '@slicer/client';

export function mixRecipeSummary(mix: NonNullable<FilamentSessionSlot['mix']>) {
  const components = mix.components.map((id, index) => ({
    id,
    ratio: mix.gradient ? '' : ` · ${mix.ratios[index]}%`,
  }));
  if (
    mix.gradient &&
    (mix.points.length ? mix.points[0].y < mix.points[mix.points.length - 1].y : mix.reverse)
  )
    components.reverse();

  const summary = components
    .map(({ id, ratio }) => `${id || 'Missing filament'}${ratio}`)
    .join(mix.gradient ? ' → ' : ', ');
  return { components, description: mix.error ? `${summary}. ${mix.error}` : summary };
}
