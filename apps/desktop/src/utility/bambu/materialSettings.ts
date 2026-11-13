import { createHash } from 'node:crypto';
import type * as D from '@orca/platform-contract';
import type { NativeEvent } from '@orca/bambu-native';
import type { BambuDeviceAccess } from './deviceAccess';
import type { BambuDeviceContext, CommandContext, PreparedCommand, PreparedProtocolCommand } from './controlContext';
import { identifier, number, protocolReport, record, records, text, type Report } from './protocol';
import { filamentCatalog, filamentRules, printerFilamentId, printerPrintProfile } from './printResources';
import { nozzleFlowType } from './telemetry';

type Parameters = D.PrinterCommandSpecs['materials.configure']['params'];
const known = <T>(reading: D.Reading<T>) => reading.kind === 'known' && reading.freshness === 'fresh' ? reading.value : undefined;
const fail = (code: D.ErrorCode, message: string) => ({ ok: false as const, error: { code, message } });
function restriction(context: BambuDeviceContext): D.PrinterError | null {
  if (!context.fresh) return { code: 'offline', message: 'Wait for fresh printer status.' };
  if (context.machine.fdmMode === false) return { code: 'precondition-failed', message: 'Material information is read-only in this processing mode.' };
  const phase = known(context.values.status.printStatus.phase);
  if (!phase) return { code: 'precondition-failed', message: 'Wait for the printer state before configuring material.' };
  if (['printing', 'preparing', 'paused'].includes(phase) && !context.machine.materialEditingDuringPrint)
    return { code: 'busy', message: 'This printer does not support changing material information during a print or resumable task.' };
  if (context.machine.localControlOnly) return { code: 'precondition-failed', message: 'This processing task must be controlled on the printer.' };
  return null;
}
export function materialTray(context: BambuDeviceContext, slotId: string) {
  const slot = context.values.materials.topology.slots.find(slot => slot.id === slotId);
  if (!slot) return undefined;
  const match = /^slot:(\d+):(\d+)$/.exec(slot.id);
  if (!match) return undefined;
  const unit = Number(match[1]), tray = Number(match[2]), p = context.report;
  const external = unit === 254 || unit === 255;
  const value = external ? Array.isArray(p.vir_slot) ? records(p.vir_slot).find(item => number(item.id) === unit || identifier(item.id) === String(unit))
    : unit === 255 ? record(p.vt_tray) : undefined
    : records(records(record(p.ams).ams).find(item => identifier(item.id) === String(unit))?.tray).find(item => identifier(item.id) === String(tray));
  if (!value || !Object.keys(value).length) return undefined;
  const paths = context.values.materials.topology.paths.filter(path => path.slotId === slotId);
  const toolId = paths.find(path => path.toolId === 'tool:0')?.toolId ?? paths[0]?.toolId;
  const tools = context.values.descriptor.topology.tools;
  const tool = tools.find(tool => tool.id === toolId);
  const nozzle = context.values.descriptor.topology.nozzles.find(nozzle => nozzle.id === tool?.nozzleId);
  const main = tools.find(tool => tool.id === 'tool:0') ?? tools[0];
  const mainDiameter = context.values.descriptor.topology.nozzles.find(nozzle => nozzle.id === main?.nozzleId)?.diameterMm ?? null;
  const flow = context.machine.legacyNozzleFlow ?? nozzleFlowType(nozzle?.flowType ?? null) ?? null;
  return { slot, unit, tray, value, external, toolId, flow, mainDiameter, toolIndex: tool ? tools.indexOf(tool) : 0,
    informationWritable: !(typeof value.tag_uid === 'string' && /[^0]/.test(value.tag_uid)) };
}

export function materialConfigurationTargets(context: BambuDeviceContext): D.MaterialConfigurationTarget[] {
  const profile = protocolReport(context.model, context.report);
  const blocked = restriction(context);
  return context.values.materials.topology.slots.flatMap(slot => {
    const target = materialTray(context, slot.id);
    return target ? [{ slotId: slot.id, informationWritable: target.informationWritable, maxGradientColors: context.machine.manualMultiColor ? 4 : null,
      actions: blocked ? [] : ['confirm', 'reset'], restriction: blocked?.message ?? null,
      catalogue: { mainNozzleDiameterMm: target.mainDiameter, toolIndex: target.toolIndex, nozzleFlowType: target.flow,
        supportsUserPresets: context.machine.userPresets || profile.support_user_preset === true } }] : [];
  });
}

/** Device material rules are shared resources; the UI only receives normalized issues. */
function materialIssues(context: CommandContext, target: NonNullable<ReturnType<typeof materialTray>>, preset: D.MaterialPresetConfiguration) {
  const materialId = preset.catalogRefs.find(ref => ref.namespace === 'orca-filament')?.value
    ?? preset.catalogRefs.find(ref => ref.namespace === 'bambu-filament')?.value ?? '';
  const wireId = printerFilamentId(materialId), entry = filamentCatalog[materialId];
  const model = printerPrintProfile(context.model).model_id, type = preset.materialType.toLowerCase();
  const name = (entry?.name ?? preset.key).replace(/\s+@.*$/, '').toLowerCase();
  const nozzle = context.values.descriptor.topology.nozzles.find(n => n.id === context.values.descriptor.topology.tools.find(t => t.id === target.toolId)?.nozzleId);
  const warnings: D.CommandWarning[] = [], prohibitions: string[] = [];
  for (const [index, rule] of filamentRules.entries()) {
    const includes = (key: string, value: unknown) => !Array.isArray(rule[key]) || !(rule[key] as unknown[]).length || (rule[key] as unknown[]).includes(value);
    if (!includes('model_id', model) || !includes('nozzle_flows', target.flow) || !includes('nozzle_diameters', nozzle?.diameterMm)) continue;
    if (rule.vendor && (String(rule.vendor).toLowerCase() === 'bambu lab') !== ((preset.manufacturer ?? '').toLowerCase() === 'bambu lab')) continue;
    if (rule.type && String(rule.type).toLowerCase() !== type || Array.isArray(rule.types) && !rule.types.some(t => String(t).toLowerCase() === type)) continue;
    if (rule.type_suffix && !type.endsWith(String(rule.type_suffix).toLowerCase()) || rule.name_suffix && !name.endsWith(String(rule.name_suffix).toLowerCase()) || rule.name && name !== String(rule.name).toLowerCase()) continue;
    if (rule.slot && rule.slot !== (target.external ? 'ext' : 'ams') || rule.calib_mode) continue;
    if (typeof rule.has_filament_switch === 'boolean' && rule.has_filament_switch !== context.machine.filamentSwitch) continue;
    if (Array.isArray(rule.white_fila_ids) && rule.white_fila_ids.includes(wireId)) continue;
    const message = String(rule.description).replace('%s', preset.label);
    if (rule.action === 'prohibition') prohibitions.push(message);
    else {
      const digest = createHash('sha256').update(JSON.stringify([index, target.slot.id, preset, model, target.flow, nozzle?.diameterMm])).digest('hex');
      const url = typeof rule.wiki === 'string' && rule.wiki.startsWith('https://') ? rule.wiki : null;
      warnings.push({ id: `material:${digest}`, message, helpUrl: url });
    }
  }
  return { warnings, prohibitions };
}

export function prepareMaterialConfiguration(context: CommandContext, params: Parameters): D.Result<PreparedCommand> {
  const target = materialTray(context, params.slotId);
  if (!target) return fail('invalid-target', 'The material slot is no longer reported.');
  const blocked = restriction(context); if (blocked) return { ok: false, error: blocked };
  if (!['confirm', 'reset'].includes(params.intent) || !Array.isArray(params.acknowledgedWarningIds)) return fail('invalid-request', 'Invalid material configuration action.');
  const commands: PreparedProtocolCommand[] = [], reset = params.intent === 'reset';
  const preset = params.intent === 'confirm' ? params.preset : null;
  let warnings: D.CommandWarning[] = [];
  let materialId = text(target.value.tray_info_idx) ?? '';
  if (target.informationWritable && !reset) {
    const range = preset?.nozzleTemperatureRangeC;
    const ref = preset?.catalogRefs.find(ref => ref.namespace === 'orca-filament' || ref.namespace === 'bambu-filament');
    if (!preset || !ref?.value || !preset.materialType || !range || !Number.isInteger(range.min) || !Number.isInteger(range.max) || range.min <= 0 || range.max < range.min)
      return fail('invalid-request', 'Select a material with a valid temperature range and color.');
    if (preset.presetRef !== null && preset.presetRef.namespace !== 'orca-filament-setting') return fail('invalid-request', 'Unsupported material preset association.');
    materialId = printerFilamentId(ref.value);
    const issues = materialIssues(context, target, preset);
    if (issues.prohibitions.length) return fail('precondition-failed', issues.prohibitions.join('\n'));
    warnings = issues.warnings;
  }
  if (target.informationWritable) {
    const selected = params.intent === 'confirm' ? params.color : null;
    const hex = (value: unknown): value is string => typeof value === 'string' && /^#[\da-fA-F]{8}$/.test(value);
    if (selected !== null && (selected.kind === 'solid' ? !hex(selected.rgba)
      : selected.kind !== 'gradient' || !Array.isArray(selected.rgba) || selected.rgba.length < 2 || selected.rgba.length > 4 || !selected.rgba.every(hex)))
      return fail('invalid-request', 'Select a valid RGBA solid or a gradient of two to four colors.');
    if (selected?.kind === 'gradient' && !context.machine.manualMultiColor)
      return fail('precondition-failed', 'This printer does not support manual gradient colors.');
    const reported = Array.isArray(target.value.cols) ? target.value.cols.filter((color): color is string => typeof color === 'string' && /^[\da-fA-F]{8}$/.test(color)) : [];
    const primary = selected?.kind === 'solid' ? selected.rgba.slice(1) : selected?.kind === 'gradient' ? selected.rgba[0].slice(1)
      : typeof target.value.tray_color === 'string' && /^[\da-fA-F]{8}$/.test(target.value.tray_color) ? target.value.tray_color : reported[0] ?? 'FFFFFFFF';
    const colors = selected ? (selected.kind === 'solid' ? [selected.rgba.slice(1)] : selected.rgba.map(color => color.slice(1))) : reported.length ? reported : [primary];
    const colorType = colors.length > 1 ? selected?.kind === 'gradient' ? 0 : number(target.value.ctype) ?? 2 : 2;
    const tuple = !reset && context.machine.manualMultiColor ? { cols: colors.map(color => color.toUpperCase()), ctype: colorType } : null;
    const colorMatches = (tray: Report) => tuple === null || number(tray.ctype) === tuple.ctype && Array.isArray(tray.cols)
      && tray.cols.length === tuple.cols.length && tray.cols.every((color, index) => String(color).toUpperCase() === tuple.cols[index]);
    const fields = { command: 'ams_filament_setting', ams_id: target.unit, slot_id: target.tray, tray_id: target.external ? 254 : target.tray,
      tray_info_idx: reset ? '' : materialId, setting_id: reset ? '' : preset?.presetRef?.value ?? '',
      tray_color: reset ? 'FFFFFF00' : primary.toUpperCase(), ...tuple,
      tray_type: reset ? '' : preset!.materialType, nozzle_temp_min: reset ? 0 : preset!.nozzleTemperatureRangeC!.min,
      nozzle_temp_max: reset ? 0 : preset!.nozzleTemperatureRangeC!.max };
    commands.push({ label: 'Material information', section: 'print', qos: 0, fields,
      responseConfirmed: reply => ['ams_id', 'slot_id', 'tray_info_idx', 'setting_id', 'tray_color', 'tray_type', 'nozzle_temp_min', 'nozzle_temp_max'].every(key =>
        String(reply[key] ?? '').toUpperCase() === String(fields[key as keyof typeof fields]).toUpperCase()) && colorMatches(reply),
      confirmed: next => {
        const tray = materialTray({ ...context, ...next }, params.slotId)?.value;
        return !!tray && colorMatches(tray) && ['tray_info_idx', 'setting_id', 'tray_color', 'tray_type', 'nozzle_temp_min', 'nozzle_temp_max'].every(key =>
          typeof fields[key as keyof typeof fields] === 'string' ? String(tray[key] ?? '').toUpperCase() === String(fields[key as keyof typeof fields]).toUpperCase()
            : number(tray[key]) === fields[key as keyof typeof fields]);
      } });
  }
  // AMSMaterialsSetting keeps the legacy K input on material changes; Reset is explicit zero.
  const legacy = context.machine.calibrationVersion < 0;
  const x1 = ['series_x1', 'series_o'].includes(String(printerPrintProfile(context.model).printer_series));
  const trayId = target.external ? context.machine.newNozzleProtocol ? target.unit : 254 : target.unit * 4 + target.tray;
  if (legacy && (!reset || !x1)) {
    const k = reset ? 0 : number(target.value.k) ?? 0;
    if (!reset && !x1 && (k <= 0 || k >= 2)) return fail('out-of-range', 'The current calibration factor must be greater than 0 and less than 2. Set a valid factor on the printer before applying.');
    commands.push({ label: 'Calibration', section: 'print', qos: 0,
      fields: { command: 'extrusion_cali_set', tray_id: trayId, k_value: k, n_coef: 1.4 },
      responseConfirmed: reply => number(reply.tray_id) === trayId && number(reply.k_value) === k,
      confirmed: next => number(materialTray({ ...context, ...next }, params.slotId)?.value.k) === k });
  } else {
    const currentId = text(target.value.tray_info_idx) ?? '', index = number(target.value.cali_idx);
    const match = !reset && currentId === materialId && context.calibrationHistory?.find(entry => number(entry.cali_idx) === index
      && printerFilamentId(text(entry.filament_id) ?? '') === materialId
      && (context.values.descriptor.topology.tools.length < 2 || identifier(entry.extruder_id) === String(target.toolId?.split(':')[1])
        && (({ S: 'Standard', H: 'High Flow', U: 'TPU High Flow', B: 'E3D High Flow' } as Record<string, string>)[String(entry.nozzle_id ?? 'HS00')[1]] ?? 'Standard') === (target.flow ?? 'Standard')));
    const selected = match ? index! : -1;
    commands.push({ label: 'Calibration', section: 'print', qos: 0,
      fields: { command: 'extrusion_cali_sel', tray_id: trayId, ams_id: target.unit, slot_id: target.tray,
        cali_idx: selected, filament_id: materialId, nozzle_diameter: (target.mainDiameter ?? 0).toFixed(1) },
      responseConfirmed: reply => number(reply.cali_idx) === selected && number(reply.ams_id) === target.unit && number(reply.slot_id) === target.tray,
      confirmed: next => number(materialTray({ ...context, ...next }, params.slotId)?.value.cali_idx) === selected });
  }
  return { ok: true, value: { commands: commands as [PreparedProtocolCommand, ...PreparedProtocolCommand[]], continueOnFailure: true, warnings } };
}

/** One-shot reads for the existing calibration association, never a calibration selector or polling loop. */
export class BambuMaterialSettings {
  private sequence = 4000000;
  private readonly cache = new Map<string, { target: D.PrinterTarget; revision: string; version: number; entries: Report[] }>();
  private readonly pending = new Map<string, { device: string; finish: (entries: Report[] | null) => void }>();
  constructor(private readonly access: Pick<BambuDeviceAccess, 'context' | 'dispatch'>, private readonly timeoutMs = 5000) {}
  history(context: BambuDeviceContext): Report[] {
    return [...this.cache.values()].filter(value => value.target.printerId === context.target.printerId && value.target.routeId === context.target.routeId
      && value.revision === context.configurationRevision && value.version === context.machine.calibrationVersion).flatMap(value => value.entries);
  }
  async prepare(target: D.PrinterTarget, params: Parameters): Promise<void> {
    const current = await this.access.context(target); if (!current.ok) return;
    const context = current.value, tray = materialTray(context, params.slotId);
    if (!tray || params.intent !== 'confirm' || context.machine.calibrationVersion < 0 || (number(tray.value.cali_idx) ?? -1) < 0) return;
    const key = JSON.stringify([target, context.configurationRevision, context.machine.calibrationVersion, tray.toolId, tray.flow, tray.mainDiameter]);
    if (this.cache.has(key)) return;
    const sequence = String(++this.sequence);
    let resolve!: (entries: Report[] | null) => void;
    const response = new Promise<Report[] | null>(done => { resolve = done; });
    const timer = setTimeout(() => resolve(null), this.timeoutMs); timer.unref();
    this.pending.set(sequence, { device: target.printerId, finish: resolve });
    try {
      const sent = await this.access.dispatch(target, async (_, send) => {
        const flow = ({ Standard: 'S', 'High Flow': 'H', 'E3D High Flow': 'B' } as Record<string, string>)[tray.flow ?? ''] ?? 'H';
        const diameter = (tray.mainDiameter ?? 0).toFixed(1);
        const fields: Report = { command: 'extrusion_cali_get', sequence_id: sequence, filament_id: '', nozzle_diameter: diameter };
        if (context.values.descriptor.topology.tools.length > 1) { fields.extruder_id = Number(tray.toolId?.split(':')[1]); fields.nozzle_id = `H${flow}00-${diameter}`; }
        return { ok: true, value: await send('print', fields, 0) };
      });
      if (!sent.ok || sent.value !== 0) resolve(null);
      const entries = await response;
      if (entries !== null) this.cache.set(key, { target, revision: context.configurationRevision, version: context.machine.calibrationVersion, entries });
    } finally { clearTimeout(timer); this.pending.delete(sequence); }
  }
  onEvent(event: NativeEvent) {
    if (event.type !== 'message' && event.type !== 'local-message') return;
    try {
      const reply = record(record(JSON.parse(event.args[1])).print), pending = this.pending.get(text(reply.sequence_id) ?? '');
      if (pending && pending.device === `bambu:${encodeURIComponent(event.args[0])}` && reply.command === 'extrusion_cali_get')
        pending.finish(['fail', 'failed', 'error'].includes(text(reply.result)?.toLowerCase() ?? '') || !Array.isArray(reply.filaments) ? null : records(reply.filaments));
    } catch { /* Unrelated or malformed protocol data does not satisfy the pending read. */ }
  }
  close() { for (const value of this.pending.values()) value.finish(null); this.pending.clear(); this.cache.clear(); }
}
