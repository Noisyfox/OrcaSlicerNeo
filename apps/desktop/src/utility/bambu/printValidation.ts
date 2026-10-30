import type * as D from '@orca/printer-control/domain';
import type { CommandContext } from './commands';
import { nozzleFlowType } from './telemetry';
import { known, mapMaterials, physicalTool } from './printMapping';
import { filamentCatalog, filamentRules, nozzleHardness, printerFilamentId, printerPrintProfile } from './printResources';
import { printAdvisories } from './printAdvisories';
import { printOptions } from './printOptions';

export function prepareBambuPrint(request: D.PrintPreparationRequest, context: CommandContext, route: 'lan' | 'cloud' | null): D.PrintPreparation {
  const { requirements: r } = request, p = context.report, device = context.machine;
  const profile = printerPrintProfile(context.model, context.values.firmware.find(f => f.name === 'ota')?.version);
  const topology = context.values.descriptor.topology;
  const mapping = mapMaterials(request, context.values.materials);
  const used = mapping.bindings.map(b => topology.materials.paths.find(p => p.id === b.pathId)).filter((v): v is D.MaterialPath => !!v);
  const multipleExternal = used.some(path => mapping.external(path) && used.filter(other => other.slotId === path.slotId).length > 1);
  const configured = printOptions(request, p, profile, multipleExternal, device);
  const issues = [...mapping.issues, ...configured.issues, ...printAdvisories(request, context, configured.options, used, mapping.external)];
  const issue = (id: string, message: string, severity: D.PrintIssue['severity'] = 'block') => issues.push({ id, message, severity });
  if (!context.fresh) issue('offline', 'Printer status is disconnected or stale. Waiting for automatic recovery.');
  if (request.target.expectedConfigurationRevision && request.target.expectedConfigurationRevision !== context.configurationRevision) issue('configuration-changed', 'Printer connection configuration changed. Select the printer again.');
  if (!route) issue('no-route', 'No usable print delivery route is available.');
  if (r.requiresDynamicMapping || device.hotendRack || r.nozzleDiameters.length > 2) issue('unsupported-mapping', 'Hotend racks and dynamic print-time nozzle mapping are not supported by this workflow.');
  if (!r.materials.length) issue('empty', 'This slice has no used material.');
  if (r.toolpathOutside) issue('outside', 'The sliced toolpath is outside the printable area.');
  const model = String(profile.model_id ?? context.model ?? '');
  const upgradeKit = device.upgradeKit;
  const quietModelMismatch = ['C11', 'C12'].includes(r.printerModelId) && ['C11', 'C12'].includes(model) || upgradeKit && r.printerModelId === 'C12';
  if (!r.printerModelId || !model) issue('unknown-model', 'The printer model cannot be fully checked.', 'warning');
  else if (r.printerModelId !== model && !(Array.isArray(profile.compatible_machine) && profile.compatible_machine.includes(r.printerModelId))) issue('incompatible-model', `The slice requires ${r.printerModel}; this printer is ${context.model}.`);
  else if (r.printerModelId !== model && !quietModelMismatch || r.printerModelId === model && upgradeKit) issue('compatible-model', 'The selected printer is a compatible model with potentially different hardware.', 'warning');
  const status = known(context.values.status.operationalState);
  if (status !== 'ready' && !device.finishedTask) issue('not-ready', 'The printer is busy or not ready.');
  if (device.firmwareUpdateRequired) issue('upgrade-required', 'A required firmware update must finish before printing.');
  if (device.firmwareUpdating) issue('upgrading', 'The printer is updating its firmware.');
  if (device.amsSetup) issue('ams-setup', 'AMS setup is in progress.');
  if (device.filamentChanging) issue('filament-change', 'A material change is in progress.');
  if (device.fdmMode === false) issue('not-fdm', 'Switch the printer to FDM mode.');
  const sd = device.storage;
  if (route === 'lan') {
    if (sd === undefined) issue('storage-unknown', 'Printer storage status has not been reported.');
    else if (sd === 'missing') issue('storage-missing', 'LAN printing requires available storage.');
    else if (sd === 'read-only' || sd === 'abnormal' && !request.allowAbnormalStorage) issue('storage-unavailable', 'Printer storage is unavailable or read-only.');
  } else if (configured.flags.support_print_without_sd !== true && sd === 'missing') issue('storage-missing', 'This printer requires storage for printing.');
  if (used.some(mapping.external) && used.some(path => !mapping.external(path)) && configured.flags.support_ams_ext_mix_print !== true) issue('mixed-sources', 'This printer does not support mixing AMS and external sources in one print.');
  const maxColors = device.maxColors;
  if (maxColors !== undefined && r.filamentMap.length > maxColors) issue('color-count', `This printer supports at most ${maxColors} filament colors.`);
  const flowSupported = device.nozzleFlowSupported;
  for (const m of r.materials) {
    const physical = physicalTool(m.toolIndex, r.nozzleDiameters.length);
    const tool = topology.tools.find(t => t.id === `tool:${physical}`);
    const nozzle = topology.nozzles.find(n => n.id === tool?.nozzleId);
    if (!nozzle) { issue(`nozzle:${m.key}`, 'The required nozzle has not been reported.'); continue; }
    if (nozzle.diameterMm === null) issue(`unknown-diameter:${m.key}`, 'Nozzle diameter is unknown.', 'warning');
    else if (Math.abs(nozzle.diameterMm - m.nozzleDiameter) > .001) issue(`diameter:${m.key}:${nozzle.diameterMm}`, `Slice nozzle ${m.nozzleDiameter} mm differs from the mounted ${nozzle.diameterMm} mm nozzle.`, 'warning');
    const flow = device.legacyNozzleFlow ?? nozzleFlowType(nozzle.flowType);
    if (flowSupported && (!flow || flow !== m.nozzleFlowType)) issue(`flow:${m.key}`, 'Mounted nozzle flow type is unknown or differs from the slice.');
    const hardness = device.legacyHighFlow ? 55 : nozzleHardness[(nozzle.constructionMaterial ?? '').replaceAll(' ', '_')];
    if (hardness === undefined) issue(`unknown-hardness:${physical}`, 'Nozzle material is unknown; hardness cannot be checked.', 'warning');
    else if (Math.abs(m.requiredNozzleHardness) > hardness) issue(`hardness:${m.key}`, `The mounted nozzle is not hard enough for ${m.type}.`);
    const path = used.find(p => mapping.bindings.some(b => b.materialKey === m.key && b.pathId === p.id));
    if (!path) continue;
    const type = m.type.toLowerCase();
    const name = (filamentCatalog[m.presetId]?.name ?? m.presetName).replace(/\s+@.*$/, '').toLowerCase();
    if (configured.flags.support_print_check_firmware_for_tpu_left === true && physical === 1 && type.startsWith('tpu') && !device.tpuLeft) issue(`tpu-left:${m.key}`, 'Firmware has not reported support for TPU on the left extruder.');
    for (const [index, rule] of filamentRules.entries()) {
      const includes = (key: string, value: unknown) => !Array.isArray(rule[key]) || !(rule[key] as unknown[]).length || (rule[key] as unknown[]).includes(value);
      if (!includes('model_id', model) || !includes('nozzle_flows', flow) || !includes('nozzle_diameters', nozzle.diameterMm)) continue;
      if (rule.vendor && (String(rule.vendor).toLowerCase() === 'bambu lab') !== (m.brand.toLowerCase() === 'bambu lab')) continue;
      if (rule.type && String(rule.type).toLowerCase() !== type || Array.isArray(rule.types) && !rule.types.some(t => String(t).toLowerCase() === type)) continue;
      if (rule.type_suffix && !type.endsWith(String(rule.type_suffix).toLowerCase()) || rule.name_suffix && !name.endsWith(String(rule.name_suffix).toLowerCase()) || rule.name && name !== String(rule.name).toLowerCase()) continue;
      if (rule.slot && rule.slot !== (mapping.external(path) ? 'ext' : 'ams') || rule.calib_mode) continue;
      if (typeof rule.has_filament_switch === 'boolean' && rule.has_filament_switch !== device.filamentSwitch) continue;
      if (Array.isArray(rule.white_fila_ids) && rule.white_fila_ids.includes(printerFilamentId(m.presetId))) continue;
      issue(`filament-rule:${index}:${m.key}:${path.id}`, String(rule.description).replace('%s', m.presetName || m.type), rule.action === 'prohibition' ? 'block' : 'warning');
    }
  }
  const highChamber = Math.max(...r.materials.map(m => m.chamberTemperature));
  if (highChamber >= 40) issue('high-chamber', 'This material requires a high-temperature environment. Close the printer enclosure when available.', 'warning');
  for (const tool of context.values.materials.state.tools) {
    const pathId = known(tool.loadedPathId);
    if (!pathId) continue;
    const slotId = topology.materials.paths.find(path => path.id === pathId)?.slotId;
    const material = context.values.materials.state.slots.find(slot => slot.slotId === slotId);
    const catalogId = material && known(material.material)?.catalogRef?.value;
    const requirement = r.materials.find(m => catalogId && printerFilamentId(m.presetId) === catalogId);
    if ((requirement?.softeningTemperature ?? 43) - highChamber <= 5) issue(`softening:${tool.toolId}:${catalogId ?? 'unknown'}`, requirement ? 'Loaded filament may soften at this chamber temperature. Unload it before printing.' : 'Loaded filament is unknown and may soften at this chamber temperature. Check it before printing.', 'warning');
  }
  if (device.amsUnits.some(unit => unit.drying && used.some(path => path.slotId.startsWith(`slot:${unit.id}:`)))) issue('ams-drying', 'An AMS is drying. Check the drying and printing conditions.', 'warning');
  return { materialCatalogIds: r.materials.map(m => ({ materialKey: m.key, catalogId: printerFilamentId(m.presetId) })), configurationRevision: context.configurationRevision, route, bindings: mapping.bindings, candidates: mapping.candidates,
    nozzleLabels: r.nozzleDiameters.map((_, index) => r.nozzleDiameters.length === 2 ? index === 0 ? 'Left Nozzle' : 'Right Nozzle' : `Nozzle ${index + 1}`),
    // Missing/stale telemetry is one prerequisite failure, not evidence of many hardware faults.
    options: configured.options, optionDescriptors: configured.descriptors, issues: context.fresh ? [...new Map(issues.map(i => [i.id, i])).values()] : issues.filter(i => i.id === 'offline') };
}
