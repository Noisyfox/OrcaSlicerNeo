import { describe, expect, it } from 'vitest';
import { prepareU1Print, type U1PrintPreparation } from './snapmaker-protocol';

const preparation = (overrides: Partial<U1PrintPreparation> = {}): U1PrintPreparation => ({
  usedFilamentIds: [0, 5, 31],
  bindings: [{ filamentId: 31, toolIndex: 3 }, { filamentId: 5, toolIndex: 1 }, { filamentId: 0, toolIndex: 1 }],
  bedLeveling: true, flowCalibration: true, timelapse: false,
  ...overrides,
});

describe('U1 structured print preparation', () => {
  it('preserves sparse logical IDs and aliases physical heads without renumbering the file', () => {
    expect(prepareU1Print(preparation())).toEqual({
      commands: [
        'SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=0 MAP_EXTRUDER=1',
        'SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=5 MAP_EXTRUDER=1',
        'SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=31 MAP_EXTRUDER=3',
        'SET_PRINT_USED_EXTRUDERS EXTRUDERS=1,3',
        'SET_PRINT_PREFERENCES BED_LEVEL=1 FLOW_CALIBRATE=1 TIME_LAPSE_CAMERA=0 FLOW_CALIBRATE_EXTRUDERS=1,3',
      ], usedToolIndices: [1, 3], calibrationToolIndices: [1, 3],
    });
  });

  it('supports more materials than physical heads', () => {
    const ids = [0, 1, 2, 3, 4, 5];
    const result = prepareU1Print(preparation({ usedFilamentIds: ids,
      bindings: ids.map(filamentId => ({ filamentId, toolIndex: 0 })) }));
    expect(result.usedToolIndices).toEqual([0]);
    expect(result.calibrationToolIndices).toEqual([0]);
    expect(result.commands).toHaveLength(8);
  });

  it.each([-1, 32, 63, 0.5, NaN, Infinity])('rejects unrepresentable logical ID %s even for one used material', filamentId => {
    expect(() => prepareU1Print(preparation({ usedFilamentIds: [filamentId], bindings: [{ filamentId, toolIndex: 0 }] }))).toThrow('logical filament index');
  });

  it.each([-1, 4, 0.5, NaN])('rejects invalid physical head %s', toolIndex => {
    expect(() => prepareU1Print(preparation({ bindings: [{ filamentId: 0, toolIndex }] }))).toThrow('physical tool index');
  });

  it('rejects missing, duplicate and unused assignments before producing commands', () => {
    expect(() => prepareU1Print(preparation({ bindings: [] }))).toThrow('Missing');
    expect(() => prepareU1Print(preparation({ bindings: [{ filamentId: 0, toolIndex: 0 }, { filamentId: 0, toolIndex: 1 }] }))).toThrow('Duplicate');
    expect(() => prepareU1Print(preparation({ bindings: [{ filamentId: 2, toolIndex: 0 }] }))).toThrow('not used');
    expect(() => prepareU1Print(preparation({ usedFilamentIds: [] }))).toThrow('no used filaments');
    expect(() => prepareU1Print(preparation({ usedFilamentIds: [0, 0] }))).toThrow('Duplicate');
  });

  it('uses only the selected used calibration heads and deduplicates them', () => {
    const result = prepareU1Print(preparation({ calibrationToolIndices: [3, 3] }));
    expect(result.calibrationToolIndices).toEqual([3]);
    expect(result.commands.at(-1)).toContain('FLOW_CALIBRATE_EXTRUDERS=3');
    expect(() => prepareU1Print(preparation({ calibrationToolIndices: [2] }))).toThrow('not used');
  });

  it.each([preparation({ calibrationToolIndices: [] }), preparation({ flowCalibration: false })])('does not encode an invalid empty calibration list', request => {
    const result = prepareU1Print(request);
    expect(result.commands.at(-1)).toContain('FLOW_CALIBRATE=0');
    expect(result.commands.at(-1)).not.toContain('FLOW_CALIBRATE_EXTRUDERS');
    expect(result.calibrationToolIndices).toEqual([]);
  });

  it('rejects non-boolean options and snapshots caller-owned arrays', () => {
    expect(() => prepareU1Print(preparation({ timelapse: '0' as unknown as boolean }))).toThrow('print option');
    const bindings = [{ filamentId: 0, toolIndex: 0 }];
    const result = prepareU1Print(preparation({ usedFilamentIds: [0], bindings }));
    bindings[0].toolIndex = 3;
    expect(result.usedToolIndices).toEqual([0]);
    expect(result.commands[0]).toContain('MAP_EXTRUDER=0');
  });
});
