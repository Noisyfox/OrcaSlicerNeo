import { expect, it } from 'vitest';
import { prepareBambuPrint } from './printValidation';
import { printParameters } from './printParameters';
import { printContext, printRequest } from './printFixtures';
import { id } from './telemetry';
const blocks = (p: ReturnType<typeof prepareBambuPrint>) => p.issues.filter(i => i.severity === 'block');
it('maps sparse materials to H2D physical tools and serializes native protocol arrays without compacting indices', () => {
  const r = printRequest(), p = prepareBambuPrint(r, printContext(), 'lan');
  expect(blocks(p)).toEqual([]);
  expect(p.bindings).toEqual([{ materialKey: 'filament-0', pathId: 'path:0:0:0' }, { materialKey: 'filament-2', pathId: 'path:1:0:1' }]);
  const native = printParameters({ ...r, requestId: id('request'), acknowledgedIssues: [] }, p, 'job');
  expect(JSON.parse(native.ams_mapping!)).toEqual([0, -1, 4]);
  expect(JSON.parse(native.ams_mapping_info!)[2].nozzleId).toBe(1);
  expect(JSON.parse(native.nozzles_info!)).toEqual([{ id: 1, type: null, diameter: .4, flowSize: 'standard_flow' }, { id: 0, type: null, diameter: .4, flowSize: 'standard_flow' }]);
});
it('refresh preserves invalid selections and blocks instead of silently changing a source', () => {
  const r = printRequest(), initial = prepareBambuPrint(r, printContext(), 'lan');
  const context = printContext(); context.values.materials.topology.paths = [];
  const p = prepareBambuPrint({ ...r, suggest: false, bindings: initial.bindings }, context, 'lan');
  expect(p.bindings).toEqual(initial.bindings); expect(blocks(p).length).toBeGreaterThan(0);
});
it('unknown metadata in an occupied AMS remains selectable, but is not automatically chosen', () => {
  const r = printRequest(), context = printContext({ vir_slot: [] });
  context.values.materials.state.slots[0].material = { kind: 'unknown', reason: 'not-reported' };
  const auto = prepareBambuPrint(r, context, 'lan'); expect(auto.bindings.some(b => b.materialKey === 'filament-0')).toBe(false);
  const manual = prepareBambuPrint({ ...r, suggest: false, bindings: [{ materialKey: 'filament-0', pathId: id('path:0:0:0') }, { materialKey: 'filament-2', pathId: id('path:1:0:1') }] }, context, 'lan');
  expect(blocks(manual)).toEqual([]); expect(manual.issues.some(i => i.id.startsWith('unknown-material:'))).toBe(true);
});
it('sole external candidate is suggested despite type mismatch and mismatch is only a warning', () => {
  const context = printContext({ ams: { ams: [] } });
  const p = prepareBambuPrint(printRequest(), context, 'lan');
  expect(p.bindings[0].pathId).toBe('path:255:0:0');
  expect(blocks(p)).toEqual([]); expect(p.issues.find(i => i.id.startsWith('material-type:'))?.severity).toBe('warning');
});
it('stale state, busy printer, required upgrade, racks and invalid flow block independently', () => {
  const r = printRequest();
  for (const context of [ { ...printContext(), fresh: false }, printContext({ gcode_state: 'RUNNING' }), printContext({ cfg: '4' }), printContext({ fun: (1n << 60n).toString(16) }) ]) expect(blocks(prepareBambuPrint(r, context, 'lan')).length).toBeGreaterThan(0);
  const context = printContext(); context.values.descriptor.topology.nozzles[0].flowType = null;
  expect(blocks(prepareBambuPrint(r, context, 'lan')).some(i => i.id.startsWith('flow:'))).toBe(true);
});
it('unknown hardness is advisory; a known insufficient nozzle blocks', () => {
  const r = printRequest(), context = printContext(); r.requirements.materials[0].requiredNozzleHardness = 60;
  expect(blocks(prepareBambuPrint(r, context, 'lan')).some(i => i.id.startsWith('hardness:'))).toBe(true);
  context.values.descriptor.topology.nozzles.find(n => n.id === 'nozzle:0')!.constructionMaterial = null;
  expect(blocks(prepareBambuPrint(r, context, 'lan'))).toEqual([]);
});
it('storage fallback changes only effective options and abnormal override never bypasses read-only storage', () => {
  const r = printRequest(); r.options = { timelapse: true, timelapseStorage: 'external', flowCalibration: 'off' };
  const p = prepareBambuPrint(r, printContext({ aux: '0' }), 'cloud');
  expect(p.options.timelapseStorage).toBe('internal'); expect(r.options.timelapseStorage).toBe('external');
  expect(p.optionDescriptors.some(o => o.key === 'sharedPressureAdvance')).toBe(true);
  expect(blocks(prepareBambuPrint({ ...r, allowAbnormalStorage: true }, printContext({ aux: '3000' }), 'lan')).some(i => i.id === 'storage-unavailable')).toBe(true);
  expect(blocks(prepareBambuPrint({ ...r, allowAbnormalStorage: true }, printContext({ aux: '2000' }), 'lan'))).toEqual([]);
});
