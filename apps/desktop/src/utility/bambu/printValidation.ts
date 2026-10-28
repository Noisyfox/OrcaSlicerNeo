import type * as D from '@orca/printer-control/domain';
import type { CommandContext } from './commands';
import { bits, number, record, records } from './telemetry';
import { known, mapMaterials, physicalTool } from './printMapping';
import { filamentCatalog, filamentRules, nozzleHardness, printerFilamentId, printerPrintProfile } from './printResources';
import { printOptions, sdcardState } from './printOptions';

export function prepareBambuPrint(request: D.PrintPreparationRequest, context: CommandContext, route: 'lan' | 'cloud' | null): D.PrintPreparation {
  const { requirements: r } = request, p = context.report;
  const profile = printerPrintProfile(context.model, context.values.firmware.find(f => f.name === 'ota')?.version);
  const topology = context.values.descriptor.topology;
  const mapping = mapMaterials(request, context.values.materials);
  const used = mapping.bindings.map(b => topology.materials.paths.find(p => p.id === b.pathId)).filter((v): v is D.MaterialPath => !!v);
  const multipleExternal = used.some(path => mapping.external(path) && used.filter(other => other.slotId === path.slotId).length > 1);
  const configured = printOptions(request, p, profile, multipleExternal);
  const issues = [...mapping.issues, ...configured.issues];
  const issue = (id: string, message: string, severity: D.PrintIssue['severity'] = 'block') => issues.push({ id, message, severity });
  if (!context.fresh) issue('offline', 'Printer status is disconnected or stale. Waiting for automatic recovery.');
  if (request.target.expectedConfigurationRevision && request.target.expectedConfigurationRevision !== context.configurationRevision) issue('configuration-changed', 'Printer connection configuration changed. Select the printer again.');
  if (!route) issue('no-route', 'No usable print delivery route is available.');
  if (r.requiresDynamicMapping || bits(p.fun, 60) === 1 || r.nozzleDiameters.length > 2) issue('unsupported-mapping', 'Hotend racks and dynamic print-time nozzle mapping are not supported by this workflow.');
  if (!r.materials.length) issue('empty', 'This slice has no used material.');
  if (r.toolpathOutside) issue('outside', 'The sliced toolpath is outside the printable area.');
  const model = String(profile.model_id ?? context.model ?? '');
  if (!r.printerModelId || !model) issue('unknown-model', 'The printer model cannot be fully checked.', 'warning');
  else if (r.printerModelId !== model && !(Array.isArray(profile.compatible_machine) && profile.compatible_machine.includes(r.printerModelId))) issue('incompatible-model', `The slice requires ${r.printerModel}; this printer is ${context.model}.`);
  else if (r.printerModelId !== model) issue('compatible-model', 'The selected printer is a compatible model with potentially different hardware.', 'warning');
  const status = known(context.values.status.operationalState);
  if (status !== 'ready' && !(['FINISH', 'FAILED'].includes(String(p.gcode_state)))) issue('not-ready', 'The printer is busy or not ready.');
  const upgrade = record(p.upgrade_state);
  if (upgrade.force_upgrade === true || upgrade.consistency_request === true || bits(p.cfg, 2) === 1) issue('upgrade-required', 'A required firmware update must finish before printing.');
  if (upgrade.dis_state === 2 || upgrade.status === 'UPGRADING') issue('upgrading', 'The printer is updating its firmware.');
  const ams = record(p.ams);
  if ([1, 2, 3, 4].includes(bits(ams.cali_stat, 0, 8) ?? -1)) issue('ams-setup', 'AMS setup is in progress.');
  if (number(p.ams_status) !== undefined && (number(p.ams_status)! >> 8) === 1) issue('filament-change', 'A material change is in progress.');
  if (record(p.device).type !== undefined && record(p.device).type !== 1) issue('not-fdm', 'Switch the printer to FDM mode.');
  const sd = sdcardState(p);
  if (route === 'lan') {
    if (sd === undefined) issue('storage-unknown', 'Printer storage status has not been reported.');
    else if (sd === 0) issue('storage-missing', 'LAN printing requires available storage.');
    else if (sd === 3 || sd === 2 && !request.allowAbnormalStorage) issue('storage-unavailable', 'Printer storage is unavailable or read-only.');
  } else if (configured.flags.support_print_without_sd !== true && sd === 0) issue('storage-missing', 'This printer requires storage for printing.');
  if (used.some(mapping.external) && used.some(path => !mapping.external(path)) && configured.flags.support_ams_ext_mix_print !== true) issue('mixed-sources', 'This printer does not support mixing AMS and external sources in one print.');
  const newProtocol = ['cfg', 'fun', 'aux', 'stat'].every(key => p[key] !== undefined);
  const flowSupported = newProtocol || p.flag3 !== undefined && bits(p.flag3, 10, 3) !== undefined;
  for (const m of r.materials) {
    const physical = physicalTool(m.toolIndex, r.nozzleDiameters.length);
    const tool = topology.tools.find(t => t.id === `tool:${physical}`);
    const nozzle = topology.nozzles.find(n => n.id === tool?.nozzleId);
    if (!nozzle) { issue(`nozzle:${m.key}`, 'The required nozzle has not been reported.'); continue; }
    if (nozzle.diameterMm === null) issue(`unknown-diameter:${m.key}`, 'Nozzle diameter is unknown.', 'warning');
    else if (Math.abs(nozzle.diameterMm - m.nozzleDiameter) > .001) issue(`diameter:${m.key}:${nozzle.diameterMm}`, `Slice nozzle ${m.nozzleDiameter} mm differs from the mounted ${nozzle.diameterMm} mm nozzle.`, 'warning');
    const flow = !newProtocol && p.flag3 !== undefined ? (bits(p.flag3, 10, 3) === 1 ? 'High Flow' : 'Standard') : ({ 'standard flow': 'Standard', 'high flow': 'High Flow', 'TPU high flow': 'TPU High Flow', 'E3D high flow': 'E3D High Flow' } as Record<string, string>)[nozzle.flowType ?? ''];
    if (flowSupported && (!flow || flow !== m.nozzleFlowType)) issue(`flow:${m.key}`, 'Mounted nozzle flow type is unknown or differs from the slice.');
    const hardness = !newProtocol && bits(p.flag3, 10, 3) === 1 ? 55 : nozzleHardness[(nozzle.constructionMaterial ?? '').replaceAll(' ', '_')];
    if (hardness === undefined) issue(`unknown-hardness:${physical}`, 'Nozzle material is unknown; hardness cannot be checked.', 'warning');
    else if (Math.abs(m.requiredNozzleHardness) > hardness) issue(`hardness:${m.key}`, `The mounted nozzle is not hard enough for ${m.type}.`);
    const path = used.find(p => mapping.bindings.some(b => b.materialKey === m.key && b.pathId === p.id));
    if (!path) continue;
    const type = m.type.toLowerCase();
    const name = (filamentCatalog[m.presetId]?.name ?? m.presetName).replace(/^Bambu /, '').toLowerCase();
    if (configured.flags.support_print_check_firmware_for_tpu_left === true && physical === 1 && type.startsWith('tpu') && bits(p.fun2, 7) !== 1) issue(`tpu-left:${m.key}`, 'Firmware has not reported support for TPU on the left extruder.');
    for (const [index, rule] of filamentRules.entries()) {
      const includes = (key: string, value: unknown) => !Array.isArray(rule[key]) || !(rule[key] as unknown[]).length || (rule[key] as unknown[]).includes(value);
      if (!includes('model_id', model) || !includes('nozzle_flows', flow) || !includes('nozzle_diameters', nozzle.diameterMm)) continue;
      if (rule.vendor && (String(rule.vendor).toLowerCase() === 'bambu lab') !== (m.brand.toLowerCase() === 'bambu lab')) continue;
      if (rule.type && String(rule.type).toLowerCase() !== type || Array.isArray(rule.types) && !rule.types.some(t => String(t).toLowerCase() === type)) continue;
      if (rule.type_suffix && !type.endsWith(String(rule.type_suffix).toLowerCase()) || rule.name_suffix && !name.endsWith(String(rule.name_suffix).toLowerCase()) || rule.name && name !== String(rule.name).toLowerCase()) continue;
      if (rule.slot && rule.slot !== (mapping.external(path) ? 'ext' : 'ams') || rule.calib_mode) continue;
      if (typeof rule.has_filament_switch === 'boolean' && rule.has_filament_switch !== (bits(p.aux, 29) === 1)) continue;
      if (Array.isArray(rule.white_fila_ids) && rule.white_fila_ids.includes(printerFilamentId(m.presetId))) continue;
      issue(`filament-rule:${index}:${m.key}:${path.id}`, String(rule.description).replace('%s', m.presetName || m.type), rule.action === 'prohibition' ? 'block' : 'warning');
    }
  }
  if (records(ams.ams).some(a => bits(a.info, 4, 4) === 2)) issue('ams-drying', 'An AMS is drying. Check the drying and printing conditions.', 'warning');
  return { materialCatalogIds: r.materials.map(m => ({ materialKey: m.key, catalogId: printerFilamentId(m.presetId) })), configurationRevision: context.configurationRevision, route, bindings: mapping.bindings, candidates: mapping.candidates,
    options: configured.options, optionDescriptors: configured.descriptors, issues: [...new Map(issues.map(i => [i.id, i])).values()] };
}
