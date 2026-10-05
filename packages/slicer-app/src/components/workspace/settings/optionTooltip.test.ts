import { describe, expect, it } from 'vitest';
import { optionTooltip } from './optionTooltip';

describe('Orca option tooltip details', () => {
  it.each([
    ['float', 'mm', '0.2', '0.2mm', 'Range: [0.1235mm, 100mm]'],
    ['ints', 'layers', '2,3', '2 layers', 'Range: [0.1235 layers, 100 layers]'],
    ['percent', '%', '20%', '20%', 'Range: [0.1235%, 100%]'],
    ['float_or_percent', 'mm or %', '20%', '20%', 'Range: [0.1235%, 100%]'],
    ['floats_or_percents', 'mm or %', '2,3%', '2mm', 'Range: [0.1235mm, 100mm]'],
  ] as const)('formats %s with native parent default and units', (type, sidetext, source, defaultText, range) => {
    expect(optionTooltip({ type, sidetext, min: 0.123456, max: 100, tooltip: 'Help', default: '999' }, 'option', '', source))
      .toBe(`Help\n\nparameter name: option\n\nDefault: ${defaultText}\n${range}`);
  });

  it.each([
    { min: 0 }, { max: 100 }, { min: -3.4028234663852886e38, max: 100 },
    { min: 0, max: 3.4028234663852886e38 }, { min: -Infinity, max: 100 },
    { min: 0, max: NaN },
  ])('omits unbounded ranges: %j', (bounds) => {
    expect(optionTooltip({ type: 'float', tooltip: 'Help', ...bounds }, 'option', '', '0.2'))
      .toBe('Help\n\nparameter name: option\n\nDefault: 0.2');
  });

  it('always shows the parameter name and omits defaults without a native parent', () => {
    expect(optionTooltip({ type: 'int', min: 0, max: 2, default: '1' }, 'option', 'Label'))
      .toBe('Label\n\nparameter name: option');
    expect(optionTooltip(undefined, 'option')).toBe('parameter name: option');
    expect(optionTooltip({ type: 'enum', min: 0, max: 2 }, 'option', '', '1')).toBe('parameter name: option');
  });

  it('uses indexed parent elements and preserves nullable numeric ranges', () => {
    expect(optionTooltip({ type: 'floats_or_percents', sidetext: 'mm or %', min: 0, max: 100 }, 'option#1', '', '2,3%'))
      .toBe('parameter name: option[1]\n\nDefault: 3%\nRange: [0%, 100%]');
    expect(optionTooltip({ type: 'floats', min: 0, max: 100 }, 'option#0', '', 'nil'))
      .toBe('parameter name: option[0]\nRange: [0, 100]');
  });

  it('formats booleans, empty strings and escaped string vectors like Orca', () => {
    expect(optionTooltip({ type: 'bool' }, 'option', '', '0')).toBe('parameter name: option\n\nDefault: false');
    expect(optionTooltip({ type: 'bools' }, 'option#1', '', '0,1')).toBe('parameter name: option[1]\n\nDefault: true');
    expect(optionTooltip({ type: 'string' }, 'option', '', '')).toBe('parameter name: option\n\nDefault: Empty string');
    expect(optionTooltip({ type: 'strings' }, 'option#1', '', 'PLA;"G28;\\nG1"'))
      .toBe('parameter name: option[1]\n\nDefault: G28;\nG1');
    expect(optionTooltip({ type: 'strings' }, 'option#0', '', ';PLA'))
      .toBe('parameter name: option[0]\n\nDefault: Empty string');
    expect(optionTooltip({ type: 'floats' }, 'option#5', '', '1,2'))
      .toBe('parameter name: option[5]\n\nDefault: 1');
  });
});
