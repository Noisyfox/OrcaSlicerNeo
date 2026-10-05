import { describe, expect, it } from 'vitest';
import { optionTooltip } from './optionTooltip';

describe('Orca option tooltip ranges', () => {
  it.each([
    ['float', 'mm', '0.2', 'Range: [0.1235mm, 100mm]'],
    ['ints', 'layers', '2', 'Range: [0.1235 layers, 100 layers]'],
    ['percent', '%', '20%', 'Range: [0.1235%, 100%]'],
    ['float_or_percent', 'mm or %', '20%', 'Range: [0.1235%, 100%]'],
    ['floats_or_percents', 'mm or %', '2,3%', 'Range: [0.1235mm, 100mm]'],
  ] as const)('formats %s with native units and four-digit precision', (type, sidetext, source, range) => {
    expect(optionTooltip({ type, sidetext, min: 0.123456, max: 100, tooltip: 'Help' }, '', source))
      .toBe(`Help\n\n${range}`);
  });

  it.each([
    { min: 0 }, { max: 100 }, { min: -3.4028234663852886e38, max: 100 },
    { min: 0, max: 3.4028234663852886e38 }, { min: -Infinity, max: 100 },
    { min: 0, max: NaN },
  ])('omits ranges without two finite Orca bounds: %j', (bounds) => {
    expect(optionTooltip({ type: 'float', tooltip: 'Help', ...bounds })).toBe('Help');
  });

  it('does not show ranges for nonnumeric options and retains fallback labels', () => {
    expect(optionTooltip({ type: 'enum', min: 0, max: 2 }, 'Label')).toBe('Label');
    expect(optionTooltip(undefined, 'Label')).toBe('Label');
    expect(optionTooltip({ type: 'int', min: 0, max: 2 })).toBe('Range: [0, 2]');
  });
});
