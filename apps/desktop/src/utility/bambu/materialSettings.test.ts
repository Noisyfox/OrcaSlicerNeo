import { expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import type { CommandContext } from './controlContext';
import { BambuTelemetry } from './telemetry';
import { BambuMaterialSettings, materialConfigurationTargets, prepareMaterialConfiguration } from './materialSettings';
import { filamentCatalog } from './printResources';
import { isBambuCommandPayload } from '../../shared/bambuCommandValidation';

const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
const [materialId, material] = Object.entries(filamentCatalog).find(([, item]) => item.name.includes('Bambu PLA Basic'))!;
const preset: D.MaterialPresetConfiguration = { key: 'Bambu PLA Basic', label: 'Bambu PLA Basic', manufacturer: 'Bambu Lab', materialType: 'PLA',
  catalogRefs: [{ namespace: 'orca-filament', value: materialId }], presetRef: { namespace: 'orca-filament-setting', value: 'profile-setting' }, nozzleTemperatureRangeC: { min: 190, max: 230 } };
function fixture(patch: Record<string, unknown> = {}, model = 'H2D') {
  const telemetry = new BambuTelemetry(() => 100);
  const tray = (id: number) => ({ id, tray_info_idx: material.bambu_id, tray_type: 'PLA', tray_color: '112233FF', tag_uid: '0000', nozzle_temp_min: 190, nozzle_temp_max: 230, cali_idx: -1, k: .5 });
  telemetry.accept(JSON.stringify({ print: { command: 'push_status', msg: 0, gcode_state: 'IDLE', cali_version: 1, cfg: '0', fun: '0', aux: '0', stat: '0',
    device: { type: 1, extruder: { state: 0, info: [{ id: 0, hnow: 0, snow: 0, star: 0, stat: 0 }, { id: 1, hnow: 0, snow: 0x100, star: 0x100, stat: 0 }] },
      nozzle: { info: [{ id: 0, type: 'HS00', diameter: .4 }, { id: 16, type: 'HS00', diameter: .4 }] } },
    ams: { tray_exist_bits: '1', ams: [{ id: 0, info: '3', tray: [tray(0)] }] }, vir_slot: [tray(255), tray(254)], ...patch } }));
  const context = (): CommandContext => ({ ...telemetry.project(target, { id: target.printerId, displayName: 'Printer', model, manufacturer: 'Bambu Lab', serialNumber: 'a', externalRefs: [] }),
    target, model, configurationRevision: 'r1' });
  return { telemetry, context };
}
const confirm = (slotId = 'slot:0:0'): Extract<D.PrinterCommandSpecs['materials.configure']['params'], { intent: 'confirm' }> =>
  ({ slotId: slotId as D.Id<'slot'>, intent: 'confirm', preset, color: { kind: 'solid', rgba: '#AABBCC80' }, acknowledgedWarningIds: [] });
const reset = (slotId = 'slot:0:0'): D.PrinterCommandSpecs['materials.configure']['params'] =>
  ({ slotId: slotId as D.Id<'slot'>, intent: 'reset', acknowledgedWarningIds: [] });
function prepared(context: CommandContext, params: D.PrinterCommandSpecs['materials.configure']['params'] = confirm()) {
  const result = prepareMaterialConfiguration(context, params);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

it.each([['slot:0:0', 0, 0, 0], ['slot:255:0', 255, 254, 255], ['slot:254:0', 254, 254, 254]])('writes %s with independent metadata/calibration addresses', (slot, unit, tray, calibrationTray) => {
  const value = prepared(fixture().context(), confirm(String(slot)));
  expect(value.continueOnFailure).toBe(true);
  expect(value.commands.map(command => command.fields)).toEqual([
    { command: 'ams_filament_setting', ams_id: unit, slot_id: 0, tray_id: tray, tray_info_idx: material.bambu_id, setting_id: 'profile-setting', tray_color: 'AABBCC80', tray_type: 'PLA', nozzle_temp_min: 190, nozzle_temp_max: 230 },
    { command: 'extrusion_cali_sel', ams_id: unit, slot_id: 0, tray_id: calibrationTray, cali_idx: -1, filament_id: material.bambu_id, nozzle_diameter: '0.4' },
  ]);
});
it('clears information without pretending that the spool was physically removed', () => {
  const value = prepared(fixture().context(), reset());
  expect(value.commands[0].fields).toMatchObject({ tray_info_idx: '', setting_id: '', tray_color: 'FFFFFF00', tray_type: '', nozzle_temp_min: 0, nozzle_temp_max: 0 });
  expect(value.commands[1].fields).toMatchObject({ cali_idx: -1, filament_id: material.bambu_id });
});
it('keeps RFID information read-only while Confirm/Reset still execute calibration actions', () => {
  const f = fixture({ vir_slot: [{ id: 254, tray_info_idx: material.bambu_id, tray_type: 'PLA', tag_uid: '1234', cali_idx: -1 }] });
  expect(materialConfigurationTargets(f.context()).find(slot => slot.slotId === 'slot:254:0')).toMatchObject({ informationWritable: false, catalogue: { toolIndex: 0 } });
  for (const params of [confirm('slot:254:0'), reset('slot:254:0')]) {
    const value = prepared(f.context(), params);
    expect(value.commands).toHaveLength(1);
    expect(value.commands[0].fields).toMatchObject({ command: 'extrusion_cali_sel', ams_id: 254, slot_id: 0 });
  }
});
it('retains only an existing matching material/tool/flow calibration association', () => {
  const f = fixture({ vir_slot: [{ id: 255, tray_info_idx: material.bambu_id, tray_type: 'PLA', cali_idx: 7 }] });
  const context = { ...f.context(), calibrationHistory: [{ cali_idx: 7, filament_id: material.bambu_id, extruder_id: 0, nozzle_id: 'HS00-0.4' }] };
  expect(prepared(context, confirm('slot:255:0')).commands[1].fields.cali_idx).toBe(7);
  expect(prepared({ ...context, calibrationHistory: [{ ...context.calibrationHistory[0], extruder_id: 1 }] }, confirm('slot:255:0')).commands[1].fields.cali_idx).toBe(-1);
  expect(prepared({ ...context, calibrationHistory: [{ ...context.calibrationHistory[0], nozzle_id: 'HH00-0.4' }] }, confirm('slot:255:0')).commands[1].fields.cali_idx).toBe(-1);
  const other = { ...preset, catalogRefs: [{ namespace: 'bambu-filament', value: 'other-material' }] };
  expect(prepared(context, { ...confirm('slot:255:0'), intent: 'confirm', preset: other, color: { kind: 'solid', rgba: '#FFFFFFFF' } }).commands[1].fields.cali_idx).toBe(-1);
});
it('follows legacy K writes, reference validation and the external sentinel', () => {
  const f = fixture({ cali_version: -1, cfg: undefined }, 'C12');
  expect(prepared(f.context(), confirm('slot:255:0')).commands[1].fields).toEqual({ command: 'extrusion_cali_set', tray_id: 254, k_value: .5, n_coef: 1.4 });
  expect(prepared(f.context(), reset('slot:255:0')).commands[1].fields).toMatchObject({ k_value: 0, n_coef: 1.4 });
});
it('enforces processing and in-print firmware restrictions without inventing a busy-state policy', () => {
  expect(prepareMaterialConfiguration(fixture({ gcode_state: 'RUNNING' }).context(), confirm())).toMatchObject({ ok: false, error: { code: 'busy' } });
  expect(prepareMaterialConfiguration(fixture({ gcode_state: 'PAUSE' }).context(), confirm())).toMatchObject({ ok: false, error: { code: 'busy' } });
  expect(prepareMaterialConfiguration(fixture({ gcode_state: 'RUNNING', flag3: '8' }).context(), confirm()).ok).toBe(true);
  const f = fixture(); const context = f.context();
  expect(prepareMaterialConfiguration({ ...context, machine: { ...context.machine, fdmMode: false } }, confirm())).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  expect(prepareMaterialConfiguration(context, confirm('missing'))).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
});
it('distinguishes blocking material rules from warnings which need explicit acknowledgement', () => {
  const context = fixture().context();
  const tpu = { ...preset, key: 'Generic TPU', label: 'Generic TPU', materialType: 'TPU', manufacturer: 'Generic', catalogRefs: [{ namespace: 'bambu-filament', value: 'GFU00' }] };
  expect(prepareMaterialConfiguration(context, { ...confirm(), intent: 'confirm', preset: tpu, color: { kind: 'solid', rgba: '#FFFFFFFF' } })).toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
  expect(prepared(context, { ...confirm('slot:255:0'), intent: 'confirm', preset: tpu, color: { kind: 'solid', rgba: '#FFFFFFFF' } }).warnings).toEqual([
    expect.objectContaining({ id: expect.any(String), message: expect.stringContaining('cold pull') }),
    expect.objectContaining({ id: expect.any(String), message: 'How to feed TPU filament.', helpUrl: expect.stringMatching(/^https:\/\//) }),
  ]);
  expect(isBambuCommandPayload({ type: 'materials.configure', params: confirm() })).toBe(true);
  expect(isBambuCommandPayload({ type: 'materials.configure', params: { ...confirm(), k_value: .2 } })).toBe(false);
});
it('updates only the addressed reply fields and never refreshes status or infers empty presence', () => {
  const f = fixture(), generation = f.telemetry.generation;
  expect(f.telemetry.accept(JSON.stringify({ print: { command: 'ams_filament_setting', ams_id: 254, slot_id: 0, tray_id: 254,
    tray_info_idx: '', setting_id: '', tray_color: 'FFFFFF00', tray_type: '', nozzle_temp_min: 0, nozzle_temp_max: 0 } }))).toBe('updated');
  const inventory = f.context().values.materials;
  expect(inventory.state.slots.find(slot => slot.slotId === 'slot:254:0')?.material).toMatchObject({ kind: 'known', value: { catalogRefs: [], nozzleTemperatureRangeC: null, color: { rgba: '#FFFFFF00' } } });
  expect(inventory.state.slots.find(slot => slot.slotId === 'slot:255:0')?.material).toMatchObject({ kind: 'known', value: { catalogRefs: expect.arrayContaining([{ namespace: 'bambu-filament', value: material.bambu_id }]) } });
  expect(inventory.state.slots.find(slot => slot.slotId === 'slot:254:0')?.presence.kind).toBe('unknown');
  expect(f.telemetry.generation).toBe(generation);
  const before = JSON.stringify(f.context().values.materials);
  f.telemetry.accept(JSON.stringify({ print: { command: 'ams_filament_setting', result: 'fail', ams_id: 255, slot_id: 0, tray_color: '000000FF' } }));
  expect(JSON.stringify(f.context().values.materials)).toBe(before);
});
it.each(['slot:0:0', 'slot:254:0', 'slot:255:0'])('writes ordered alpha gradients for capable firmware at %s and requires the full tuple to confirm', slotId => {
  const f = fixture({ fun2: '800000' });
  expect(materialConfigurationTargets(f.context()).find(slot => slot.slotId === slotId)?.maxGradientColors).toBe(4);
  const colors = ['#12345600', '#ABCDEF80', '#12345600', '#FFFFFFFE'];
  const command = prepared(f.context(), { ...confirm(slotId), color: { kind: 'gradient', rgba: colors } }).commands[0];
  expect(command.fields).toMatchObject({ tray_color: '12345600', cols: colors.map(color => color.slice(1)), ctype: 0 });
  expect(command.responseConfirmed?.({ ...command.fields })).toBe(true);
  for (const mismatch of [{ cols: undefined }, { cols: ['12345600', 'ABCDEF80'] }, { ctype: 1 },
    { cols: ['12345600', '12345600', 'ABCDEF80', 'FFFFFFFE'] }, { cols: ['12345600', 'ABCDEFFF', '12345600', 'FFFFFFFE'] }]) {
    expect(command.responseConfirmed?.({ ...command.fields, ...mismatch })).toBe(false);
  }
  f.telemetry.accept(JSON.stringify({ print: command.fields }));
  expect(command.confirmed?.(f.context())).toBe(true);
  const state = f.context().values.materials.state.slots.find(slot => slot.slotId === slotId)?.material;
  expect(state).toMatchObject({ kind: 'known', value: { color: { kind: 'multiple', rgba: colors, representativeRgba: colors[0], appearance: 'gradient' } } });
});
it('keeps solid alpha available without the capability, emits singleton tuples only with it and omits tuples on reset', () => {
  const legacy = fixture(), capable = fixture({ fun2: '800000' });
  expect(materialConfigurationTargets(legacy.context())[0].maxGradientColors).toBeNull();
  expect(prepared(legacy.context()).commands[0].fields).toMatchObject({ tray_color: 'AABBCC80' });
  expect(prepared(legacy.context()).commands[0].fields).not.toHaveProperty('cols');
  expect(prepared(capable.context()).commands[0].fields).toMatchObject({ cols: ['AABBCC80'], ctype: 2 });
  for (const f of [legacy, capable]) {
    expect(prepared(f.context(), reset()).commands[0].fields).not.toHaveProperty('cols');
    expect(prepared(f.context(), reset()).commands[0].fields).not.toHaveProperty('ctype');
  }
  expect(prepareMaterialConfiguration(legacy.context(), { ...confirm(), color: { kind: 'gradient', rgba: ['#00000000', '#FFFFFFFF'] } }))
    .toMatchObject({ ok: false, error: { code: 'precondition-failed' } });
});
it.each([0, 1])('retains an unedited reported seven-color tuple and its type %s without truncation or deduplication', ctype => {
  const cols = ['12345600', 'ABCDEF80', '12345600', 'FFFFFFFE', '000000FF', '11223344', 'ABCDEF80'];
  const f = fixture({ fun2: '800000', vir_slot: [{ id: 254, tray_color: 'FF00FF40', cols, ctype, cali_idx: -1 }] });
  const command = prepared(f.context(), { ...confirm('slot:254:0'), color: null }).commands[0];
  expect(command.fields).toMatchObject({ tray_color: 'FF00FF40', cols, ctype });
  f.telemetry.accept(JSON.stringify({ print: { command: 'ams_filament_setting', ams_id: 254, slot_id: 0, tray_type: 'PETG' } }));
  expect(prepared(f.context(), { ...confirm('slot:254:0'), color: null }).commands[0].fields).toMatchObject({ tray_color: 'FF00FF40', cols, ctype });
  f.telemetry.accept(JSON.stringify({ print: { command: 'ams_filament_setting', ams_id: 254, slot_id: 0, tray_color: 'FF00FF40' } }));
  expect(prepared(f.context(), { ...confirm('slot:254:0'), color: null }).commands[0].fields).toMatchObject({ tray_color: 'FF00FF40', cols, ctype });
  f.telemetry.accept(JSON.stringify({ print: command.fields }));
  expect(f.context().values.materials.state.slots.find(slot => slot.slotId === 'slot:254:0')?.material)
    .toMatchObject({ kind: 'known', value: { color: { rgba: cols.map(color => `#${color}`), appearance: ctype === 0 ? 'gradient' : 'parallel' } } });
});
it('validates explicit color shape at IPC and provider boundaries without accepting legacy payloads or oversized new gradients', () => {
  const context = fixture({ fun2: '800000' }).context();
  for (const color of [{ kind: 'gradient', rgba: ['#000000FF'] }, { kind: 'gradient', rgba: Array(5).fill('#000000FF') },
    { kind: 'gradient', rgba: ['#000000FF', '#FFFFFF'] }, { kind: 'parallel', rgba: ['#000000FF', '#FFFFFFFF'] }]) {
    const params = { ...confirm(), color };
    expect(isBambuCommandPayload({ type: 'materials.configure', params })).toBe(false);
    expect(prepareMaterialConfiguration(context, params as ReturnType<typeof confirm>)).toMatchObject({ ok: false, error: { code: 'invalid-request' } });
  }
  for (const color of [null, { kind: 'solid', rgba: '#12345600' }, { kind: 'gradient', rgba: ['#12345600', '#ABCDEF80'] }])
    expect(isBambuCommandPayload({ type: 'materials.configure', params: { ...confirm(), color } })).toBe(true);
  const { color: _color, ...rest } = confirm();
  expect(isBambuCommandPayload({ type: 'materials.configure', params: { ...rest, colorRgba: '#FFFFFFFF' } })).toBe(false);
});
it('reads the current calibration table once per configuration/version and keeps it host-private', async () => {
  const f = fixture({ vir_slot: [{ id: 255, tray_info_idx: material.bambu_id, cali_idx: 7 }] });
  let owner!: BambuMaterialSettings;
  const send = vi.fn(async (_section: string, fields: Record<string, unknown>) => {
    setImmediate(() => owner.onEvent({ type: 'local-message', args: ['a', JSON.stringify({ print: { command: 'extrusion_cali_get', sequence_id: fields.sequence_id,
      filaments: [{ cali_idx: 7, filament_id: material.bambu_id, extruder_id: 0, nozzle_id: 'HS00-0.4' }] } })] })); return 0;
  });
  owner = new BambuMaterialSettings({ context: async () => ({ ok: true, value: f.context() }), dispatch: async (_target, work) => work(f.context(), send) });
  try {
    await owner.prepare(target, confirm('slot:255:0')); await owner.prepare(target, confirm('slot:255:0'));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][1]).toMatchObject({ command: 'extrusion_cali_get', extruder_id: 0, nozzle_id: 'HS00-0.4' });
    expect(owner.history(f.context())).toHaveLength(1);
    expect(owner.history({ ...f.context(), configurationRevision: 'new' })).toEqual([]);
  } finally { owner.close(); }
});
