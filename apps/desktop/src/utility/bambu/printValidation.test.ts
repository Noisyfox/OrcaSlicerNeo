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
it('keeps the full catalog filament name for nozzle-specific prohibitions', () => {
  const r = printRequest(); r.requirements.materials[0].presetId = 'OFlfuj2k'; r.requirements.materials[0].type = 'TPU';
  const p = prepareBambuPrint(r, printContext({ ams: { ams: [] } }), 'lan');
  expect(p.issues.find(i => i.id.startsWith('filament-rule:28:'))?.severity).toBe('block');
});
it('serializes mixed AMS Lite slots at 24 and preserves hidden shared-PA behavior', () => {
  const r = printRequest(), c = printContext(), p = prepareBambuPrint(r, c, 'lan');
  expect(p.optionDescriptors.some(d => d.key === 'sharedPressureAdvance')).toBe(false);
  expect(p.options.sharedPressureAdvance).toBe(true);
  const native = printParameters({ ...r, requestId: id('request'), acknowledgedIssues: [] }, p, 'job', { ams: { ams: [{ id: 0, info: '5' }] } });
  expect(JSON.parse(native.ams_mapping!)[0]).toBe(24); expect(native.extruder_cali_manual_mode).toBe(0); expect(native.task_bed_type).toBe('auto');
});
it('applies P1 model-confirmation exceptions without waiving the compatibility gate', () => {
  const r = printRequest(); r.requirements.printerModelId = 'C12';
  const c = { ...printContext(), model: 'C11' };
  const p = prepareBambuPrint(r, c, 'lan');
  expect(p.issues.some(i => i.id === 'compatible-model')).toBe(false);
  expect(p.issues.some(i => i.id === 'incompatible-model')).toBe(false);
  r.requirements.printerModelId = 'O1D'; expect(prepareBambuPrint(r, c, 'lan').issues.some(i => i.id === 'incompatible-model')).toBe(true);
});
it('warns for high chamber temperatures and only warns about drying in selected AMS units', () => {
  const r = printRequest(); r.requirements.materials[0].chamberTemperature = 60;
  expect(prepareBambuPrint(r, printContext(), 'lan').issues.find(i => i.id === 'high-chamber')?.severity).toBe('warning');
  const context = printContext(); (context.report.ams as { ams: unknown[] }).ams.push({ id: 4, info: '23' });
  expect(prepareBambuPrint(r, context, 'lan').issues.some(i => i.id === 'ams-drying')).toBe(false);
});
it('warns when automatic calibration ignores selected manual PA and when supported blob detection is not Auto', () => {
  const r = printRequest(); r.options.flowCalibration = 'auto'; r.requirements.materials[0].presetId = 'GFA11';
  const c = printContext({ fun2: '8008' });
  (c.report.ams as { ams: { tray: Record<string, unknown>[] }[] }).ams[0].tray[0].cali_idx = 1;
  const p = prepareBambuPrint(r, c, 'lan');
  expect(p.issues.some(i => i.id === 'manual-pa-not-used')).toBe(true);
  expect(p.issues.some(i => i.id === 'smart-nozzle-blob')).toBe(true);
});
