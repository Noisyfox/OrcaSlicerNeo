import { expect, it } from 'vitest';
import { hexToRgba, hslaToRgba, rgbaToHex, rgbaToHsla, spectrumColor, spectrumPosition } from './color-picker-model';

it('round trips RGB through HSL across the color cube, including blue', () => {
  for (const r of [0, 31, 128, 255]) for (const g of [0, 57, 160, 255]) for (const b of [0, 93, 224, 255]) {
    const rgb = { r, g, b, a: 0.3 };
    expect(rgbaToHex(hslaToRgba(rgbaToHsla(rgb)))).toBe(rgbaToHex(rgb));
  }
  expect(rgbaToHex(hslaToRgba({ h: 240, s: 100, l: 50, a: 1 }))).toBe('#0000FF');
});
it('retains RGB at zero alpha and round trips all alpha bytes', () => {
  for (let a = 0; a <= 255; a++) {
    const hex = '#123456' + a.toString(16).padStart(2, '0').toUpperCase();
    expect(rgbaToHex(hexToRgba(hex)!, true)).toBe(hex);
  }
  expect(hexToRgba('bad!')).toBeNull();
});
it('preserves hue for gray and hue/saturation at lightness endpoints', () => {
  const previous = { h: 210, s: 65, l: 50, a: 1 };
  expect(rgbaToHsla({ r: 128, g: 128, b: 128, a: 1 }, previous)).toMatchObject({ h: 210, s: 0 });
  expect(rgbaToHsla({ r: 0, g: 0, b: 0, a: 0 }, previous)).toMatchObject({ h: 210, s: 65, a: 0 });
});
it('maps spectrum boundaries analytically and keeps hue 360 on the right', () => {
  const color = spectrumColor(1, 0.25, 35, 0.5);
  expect(color).toEqual({ h: 360, s: 35, l: 75, a: 0.5 });
  expect(spectrumPosition(color)).toEqual({ x: 1, y: 0.25 });
  expect(rgbaToHex(hslaToRgba({ ...color, s: 100, l: 50 }))).toBe('#FF0000');
});
