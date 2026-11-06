import { describe, expect, it, vi } from 'vitest';
import type * as D from './domain';
import { readU1Preparation, prepareU1Submission, type U1PreparationSnapshot } from './snapmaker-preparation';
import { MoonrakerHttp } from './moonraker-http';
import { normalizePrinterConfigurationDocument } from './configuration';
import { u1MaterialInventory, u1PathId } from './snapmaker-observation';

const target = { printerId: 'u1' as D.Id<'printer'>, routeId: 'snapmaker:u1' as D.Id<'route'> };
const material = (index: number, toolIndex = 0): D.PrintMaterialRequirement => ({ key: `filament-${index}`, index, toolIndex,
  type: 'PLA', color: '#FF0000', presetId: 'pla', presetName: 'PLA', brand: 'Generic', nozzleDiameter: .4, nozzleFlowType: 'Standard',
  nozzleTemperature: 210, initialLayerNozzleTemperature: 215, chamberTemperature: 0, softeningTemperature: 55,
  requiredNozzleHardness: 0, usedGrams: 1, usedMeters: .3 });
function fixture() {
  const snapshot: U1PreparationSnapshot = { receivedAtMs: 100, inventory: u1MaterialInventory({ print_task_config: {
    filament_exist: [true, true, false, true], filament_type: ['PLA', 'PLA', 'PLA', 'PETG'],
    filament_color_rgba: ['0000ffff', 'ff0000ff', 'ff0000ff', 'ff0000ff'],
  }, 'filament_motion_sensor e0_filament': { enabled: true, filament_detected: false } }, target, 'revision'),
  commands: ['SET_PRINT_EXTRUDER_MAP', 'SET_PRINT_USED_EXTRUDERS', 'SET_PRINT_PREFERENCES'],
  tools: [0, 1, 2, 3].map(() => ({ diameter: .4, flow: 'standard', hardness: null })) };
  const request: D.PrintPreparationRequest = { target, suggest: true, bindings: [], options: {}, allowAbnormalStorage: false,
    requirements: { contentId: 'receipt', plateId: 'plate', printerModel: 'Snapmaker U1', printerModelId: 'U1', materials: [material(5)],
      nozzleDiameters: [.4, .4, .4, .4], nozzleFlowTypes: ['Standard', 'Standard', 'Standard', 'Standard'], filamentMap: [1, 1, 1, 1, 1, 1],
      requiresDynamicMapping: false, bedType: 'plate', durationSeconds: 60, layerCount: 10, weightGrams: 1, timelapseWarningCode: 0, toolpathOutside: false, warnings: [] } };
  return { snapshot, request, prepare: () => prepareU1Submission(request, snapshot, 'revision', 100) };
}
describe('U1 structured print preparation', () => {
  it('uses the sliced physical head on open, not the closer color, and preserves manual bindings on refresh', () => {
    const f = fixture();
    expect(f.prepare().bindings).toEqual([{ materialKey: 'filament-5', pathId: u1PathId(0) }]);
    f.request.suggest = false; f.request.bindings = [{ materialKey: 'filament-5', pathId: u1PathId(3) }];
    expect(f.prepare().bindings).toEqual(f.request.bindings);
    expect(f.prepare().issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'warning', materialKey: 'filament-5', message: expect.stringContaining('PETG') })]));
    expect(f.prepare().issues.some(i => i.severity === 'block')).toBe(false);
  });
  it('only explicitly auto-matches within families and excludes empty heads', () => {
    const f = fixture(); f.request.autoMatch = true;
    expect(f.prepare().bindings[0].pathId).toBe(u1PathId(1));
    f.request.requirements.materials = [{ ...material(5), type: 'ABS' }];
    expect(f.prepare().bindings).toEqual([]);
    expect(f.prepare().issues.some(i => i.id === 'mapping:filament-5')).toBe(true);
  });
  it('allows many-to-one and warns about shared physical filament and different logical temperatures', () => {
    const f = fixture(); f.request.requirements.materials = [material(0), { ...material(5), nozzleTemperature: 230 }];
    const prepared = f.prepare();
    expect(prepared.bindings.map(b => b.pathId)).toEqual([u1PathId(0), u1PathId(0)]);
    expect(prepared.issues.filter(i => i.severity === 'block')).toEqual([]);
    expect(prepared.issues.some(i => i.id.startsWith('shared:'))).toBe(true);
    expect(prepared.issues.some(i => i.id.startsWith('heater:') && i.message.includes('210/215, 230/215'))).toBe(true);
    expect(prepared.calibrationTools).toEqual([{ index: 0, label: 'Toolhead 1', selected: true }]);
  });
  it('treats inserted-but-unloaded as ready for the printer start workflow, never empty or unknown', () => {
    const f = fixture();
    expect(f.prepare().issues.some(i => i.id.startsWith('load:'))).toBe(true);
    f.request.requirements.materials = [material(5, 2)];
    expect(f.prepare().issues.some(i => i.id.startsWith('mapping:') && i.severity === 'block')).toBe(true);
    f.snapshot.inventory.state.slots = f.snapshot.inventory.state.slots.map(s => ({ ...s, presence: { kind: 'unknown', reason: 'not-reported' } }));
    expect(f.prepare().candidates.every(c => c.disabledReason !== null)).toBe(true);
  });
  it.each([-1, 32, 63, 1.5])('blocks logical ID %s even when it is the only used material', index => {
    const f = fixture(); f.request.requirements.materials = [material(index)];
    expect(f.prepare().issues.some(i => i.id.startsWith('logical:') && i.severity === 'block')).toBe(true);
  });
  it('requires acknowledgement for unknown and mismatched hardware without inventing values', () => {
    const f = fixture(); f.snapshot.tools = [{ diameter: .6, flow: 'high_flow', hardness: 0 }];
    f.request.requirements.materials = [{ ...material(5), requiredNozzleHardness: 3 }];
    const warnings = f.prepare().issues.filter(i => i.id.startsWith('hardware:'));
    expect(warnings).toHaveLength(3); expect(warnings.every(i => i.severity === 'warning')).toBe(true);
    f.snapshot.tools = [];
    expect(f.prepare().issues.filter(i => i.message.includes('unreported'))).toHaveLength(3);
  });
  it('checks feature availability and freshness without a firmware-version gate', () => {
    const f = fixture(); f.snapshot.commands = ['SET_PRINT_EXTRUDER_MAP'];
    expect(f.prepare().issues.filter(i => i.id.startsWith('command:'))).toHaveLength(2);
    expect(prepareU1Submission(f.request, f.snapshot, 'revision', 15_101).issues.some(i => i.id === 'offline')).toBe(true);
  });
  it('keeps an explicitly empty calibration subset and rejects unused or duplicate head indices', () => {
    const f = fixture(); f.request.options.calibrationToolIndices = [];
    expect(f.prepare().options.calibrationToolIndices).toEqual([]);
    expect(f.prepare().calibrationTools?.[0].selected).toBe(false);
    f.request.options.calibrationToolIndices = [0, 0, 3];
    expect(f.prepare().issues.some(i => i.id === 'calibration')).toBe(true);
  });
});

it('reads actual extruder hardware, not logical job nozzle settings, and never submits a command while preparing', async () => {
  const request = vi.fn(async ({ url }: { url: string }) => ({ status: 200, json: async () => url.endsWith('/objects/list')
    ? { result: { objects: ['gcode', 'print_task_config', 'extruder', 'filament_motion_sensor e0_filament'] } }
      : { result: { status: { gcode: { commands: { SET_PRINT_EXTRUDER_MAP: {}, SET_PRINT_USED_EXTRUDERS: {}, SET_PRINT_PREFERENCES: {} } }, print_task_config: { filament_exist: [true], nozzle_diameter: [.8] },
        extruder: { nozzle_diameter: .4, nozzle_volume_type: 'standard' } } } } }));
  const printer = normalizePrinterConfigurationDocument({ version: 1, printers: [{ id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer/proxy', apiKey: '', consoleUrl: '' }] }).printers[0];
  const snapshot = await readU1Preparation(new MoonrakerHttp({ request }), printer, target, 'revision');
  expect(snapshot.commands).toEqual(['SET_PRINT_EXTRUDER_MAP', 'SET_PRINT_USED_EXTRUDERS', 'SET_PRINT_PREFERENCES']);
  expect(request.mock.calls.every(([r]) => !r.url.includes('/gcode/help'))).toBe(true);
  expect(snapshot.tools[0]).toEqual({ diameter: .4, flow: 'standard', hardness: null });
  expect(snapshot.tools[1]).toEqual({ diameter: null, flow: null, hardness: null });
  expect(request.mock.calls.map(([r]) => r.url)).toHaveLength(2);
  expect(request.mock.calls[1][0].url).not.toContain('extruder1');
});
