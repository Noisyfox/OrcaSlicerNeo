import type { LayerHeightFrame } from '@slicer/client';

export function bandByteOffset(cell: number, width: number) {
  // The final texel in each row repeats the start of the next row for filtering.
  return 4 * (cell + Math.floor(cell / (width - 1)));
}

export function lastPaintedBandCell({ cells, width, pixels }: Pick<LayerHeightFrame, 'cells' | 'width' | 'pixels'>) {
  // Native layers can end just below the mesh top. Preserve the Z scale and
  // clamp only the unwritten tail, whose alpha is zero.
  let cell = cells - 1;
  while (cell > 0 && pixels[bandByteOffset(cell, width) + 3] === 0) cell--;
  return cell;
}
