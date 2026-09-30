import { expect, it } from 'vitest';
import * as THREE from 'three';
import type { PaintingDisplay } from './PaintingController';
import { mmuPaintingCursorColor } from './MmuPaintingGizmo';

function display(colours: string[]): PaintingDisplay {
  return { session: { objectId: 1, parts: [{ volumeId: 3 }] }, palette: {
    slots: colours.map((effective, i) => ({ slot: i + 1, colour: { effective } })),
    assignments: { parts: [{ id: 3, effectiveSlot: 1 }], objects: [] },
  } } as unknown as PaintingDisplay;
}
// Independent IEC sRGB transfer equation, rather than the production Three API.
const linear = (channel: number) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
it.each([
  ['#445566', [85 / 255, 106.25 / 255, 127.5 / 255]],
  ['#ffcc80', [1, 1, 160 / 255]],
  ['#000000', [0, 0, 0]], ['#ffffff', [1, 1, 1]], ['#ff0000', [1, 0, 0]],
] as const)('matches Orca encoded-RGB highlight and linear conversion for %s', (source, expected) => {
  const color = mmuPaintingCursorColor(display([source]), 1);
  const encoded = color.clone().convertLinearToSRGB().toArray();
  expected.forEach((channel, i) => {
    // Three's inverse transfer uses exponent 0.41666; the linear values below
    // establish the precise highlight without relying on that approximation.
    expect(encoded[i]).toBeCloseTo(channel, 4);
    expect(color.toArray()[i]).toBeCloseTo(linear(channel), 6);
  });
});
it('uses the selected positive slot from the supplied matched display palette', () => {
  const oldDisplay = display(['#ff0000', '#445566']);
  const nextDisplay = display(['#00ff00', '#000000']);
  expect(mmuPaintingCursorColor(oldDisplay, 1).getHexString()).toBe('ff0000');
  expect(mmuPaintingCursorColor(oldDisplay, 2).getHexString()).toBe('556a80');
  expect(mmuPaintingCursorColor(nextDisplay, 2).getHexString()).toBe('000000');
  expect(mmuPaintingCursorColor(oldDisplay, 2).getHexString()).toBe('556a80');
});
