import { expect, it } from 'vitest';
import { colorSwatchForeground, colorSwatchStyle } from './color-swatch';

it.each([
  ['#ffffff00', '#171717'], ['#00000000', '#171717'],
  ['#00000040', '#171717'], ['#00000080', '#ffffff'],
  ['#ffffff80', '#171717'], ['#000000', '#ffffff'], ['#ffffff', '#171717'],
])('chooses readable text over %s composited on the light checkerboard', (color, expected) => {
  expect(colorSwatchForeground(color)).toBe(expected);
});

it('preserves independent alpha and source order in gradients and hard partitions', () => {
  const colors = ['#ffffff00', '#00000080', '#ff0000'];
  const gradient = colorSwatchStyle({ mode: 'gradient', colors });
  const partition = colorSwatchStyle({ mode: 'multicolor', colors });
  expect(gradient.backgroundImage).toContain('linear-gradient(90deg, #ffffff00, #00000080, #ff0000)');
  expect(partition.backgroundImage).toContain('#00000080 33.33333333333333%, #00000080 66.66666666666666%');
  for (const style of [gradient, partition]) {
    expect(style.backgroundColor).toBe('var(--color-swatch-background)');
    expect(style.backgroundImage).toContain('var(--color-swatch-checkerboard)');
    expect(style.backgroundRepeat).toBe('no-repeat, repeat');
  }
});
