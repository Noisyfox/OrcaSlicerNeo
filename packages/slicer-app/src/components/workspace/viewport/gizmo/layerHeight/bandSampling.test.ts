import { expect, it } from 'vitest';
import { lastPaintedBandCell } from './bandSampling';

it('clamps the transparent tail even when it crosses a row boundary', () => {
  // Three cells per four-texel row. Padding and unused capacity are not cells.
  const pixels = new Uint8Array(3 * 4 * 4);
  for (const texel of [0, 1, 2, 3, 4, 5, 11]) pixels[texel * 4 + 3] = 255;
  expect(lastPaintedBandCell({ cells: 8, width: 4, pixels })).toBe(4);
  // An opaque black last cell is valid, independent of its RGB channels.
  pixels[9 * 4 + 3] = 255;
  expect(lastPaintedBandCell({ cells: 8, width: 4, pixels })).toBe(7);
});
