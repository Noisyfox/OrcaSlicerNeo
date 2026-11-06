/** U1 preparation consumes structured slice/device data; it never reads G-code. */
import type * as D from './domain';
import type { PrinterConfiguration } from './configuration';
import { MoonrakerHttp, fail, record } from './moonraker-http';
import { u1MaterialInventory, u1PathId, u1ToolId } from './snapmaker-observation';

export interface U1PreparationSnapshot {
  receivedAtMs: number;
  inventory: D.MaterialInventory;
  commands: readonly string[];
  tools: readonly { diameter: number | null; flow: string | null; hardness: number | null }[];
}
export async function readU1Preparation(http: MoonrakerHttp, printer: PrinterConfiguration, target: D.PrinterTarget,
  revision: string, signal?: AbortSignal): Promise<U1PreparationSnapshot> {
  const listing = await http.get(printer, '/printer/objects/list', signal);
  const objects = Array.isArray(listing.objects) ? listing.objects : [];
  if (!objects.includes('print_task_config')) fail('unsupported', 'U1 print configuration is unavailable');
  const names = ['print_task_config', 'extruder', 'extruder1', 'extruder2', 'extruder3',
    ...[0, 1, 2, 3].map(i => `filament_motion_sensor e${i}_filament`)].filter(name => objects.includes(name));
  const status = record((await http.get(printer, `/printer/objects/query?${names.map(encodeURIComponent).join('&')}`, signal)).status);
  const commands = Object.keys(await http.get(printer, '/printer/gcode/help', signal));
  return { receivedAtMs: Date.now(), inventory: u1MaterialInventory(status, target, revision), commands,
    tools: [0, 1, 2, 3].map(i => {
      const tool = record(status[i ? `extruder${i}` : 'extruder']);
      return { diameter: typeof tool.nozzle_diameter === 'number' && tool.nozzle_diameter > 0 ? tool.nozzle_diameter : null,
        flow: typeof tool.nozzle_volume_type === 'string' ? tool.nozzle_volume_type : null, hardness: null };
    }) };
}

const family = (type: string | null) => type?.trim().toUpperCase().match(/^(PLA|PETG|ABS|ASA|TPU|TPE|PA|PC|PVA|HIPS|PET)(?:$|[\s+_-]|\d)/)?.[1] ?? null;
function colorDistance(a: string, b: string | null) {
  if (!/^#[\da-f]{6}([\da-f]{2})?$/i.test(a) || !b || !/^#[\da-f]{6}([\da-f]{2})?$/i.test(b)) return Infinity;
  return [1, 3, 5].reduce((sum, at) => sum + (parseInt(a.slice(at, at + 2), 16) - parseInt(b.slice(at, at + 2), 16)) ** 2, 0);
}
const normalizedFlow = (value: string | null) => value?.toLowerCase().replace(/[\s_-]/g, '') ?? null;
export function u1BindingHead(pathId: string): number | null {
  const index = [0, 1, 2, 3].find(i => pathId === u1PathId(i));
  return index ?? null;
}
export function prepareU1Submission(request: D.PrintPreparationRequest, snapshot: U1PreparationSnapshot, revision: string, now = Date.now()): D.PrintPreparation {
  const { requirements } = request;
  const issues: D.PrintIssue[] = [];
  const issue = (id: string, severity: D.PrintIssue['severity'], message: string, materialKey?: string) => issues.push({ id, severity, message, ...(materialKey ? { materialKey } : {}) });
  if (requirements.printerModel !== 'Snapmaker U1') issue('model', 'block', 'This agent currently supports slices for Snapmaker U1.');
  if (!requirements.contentId || !requirements.materials.length) issue('slice', 'block', 'A current slice with used materials is required.');
  if (requirements.toolpathOutside) issue('outside', 'block', 'The sliced toolpath extends outside the print area.');
  if (now - snapshot.receivedAtMs > 15_000) issue('offline', 'block', 'Current printer information is unavailable. Refresh before sending.');
  for (const command of ['SET_PRINT_EXTRUDER_MAP', 'SET_PRINT_USED_EXTRUDERS', 'SET_PRINT_PREFERENCES'])
    if (!snapshot.commands.includes(command)) issue(`command:${command}`, 'block', `Required printer function is unavailable: ${command}.`);
  const seen = new Set<number>(), keys = new Set<string>();
  for (const material of requirements.materials) {
    if (!Number.isInteger(material.index) || material.index < 0 || material.index > 31 || seen.has(material.index) || keys.has(material.key))
      issue(`logical:${material.key}`, 'block', 'U1 requires unique used logical filament IDs between 0 and 31.', material.key);
    seen.add(material.index); keys.add(material.key);
  }
  const { inventory } = snapshot;
  const candidates: D.PrintMaterialSource[] = requirements.materials.flatMap(material => [0, 1, 2, 3].map(i => {
    const slot = inventory.topology.slots[i], state = inventory.state.slots.find(s => s.slotId === slot.id);
    const presence = state?.presence.kind === 'known' && state.presence.freshness === 'fresh' ? state.presence.value : 'unknown';
    const metadata = state?.material.kind === 'known' ? state.material.value : null;
    return { materialKey: material.key, calibrationToolIndex: i, pathId: u1PathId(i), label: `Toolhead ${i + 1}`, color: metadata?.color?.kind === 'solid' ? metadata.color.rgba : null,
      materialType: metadata?.materialType ?? null, unit: { ...inventory.topology.units[i], categoryLabel: 'Toolhead filament' }, slot,
      tool: { id: u1ToolId(i), name: `Toolhead ${i + 1}` }, presence, remainingFraction: null,
      disabledReason: presence === 'present' ? null : presence === 'empty' ? 'No filament inserted' : 'Filament presence is unknown; refresh the printer' };
  }));
  let bindings = request.suggest ? requirements.materials.filter(m => Number.isInteger(m.toolIndex) && m.toolIndex >= 0 && m.toolIndex < 4)
    .map(m => ({ materialKey: m.key, pathId: u1PathId(m.toolIndex) })) : request.bindings.map(b => ({ ...b }));
  if (request.autoMatch) bindings = requirements.materials.flatMap(material => {
    const compatible = candidates.filter(c => c.materialKey === material.key && !c.disabledReason && family(material.type) !== null && family(material.type) === family(c.materialType));
    compatible.sort((a, b) => colorDistance(material.color, a.color) - colorDistance(material.color, b.color));
    return compatible.length ? [{ materialKey: material.key, pathId: compatible[0].pathId }] : [];
  });
  for (const binding of bindings) if (!keys.has(binding.materialKey) || bindings.filter(b => b.materialKey === binding.materialKey).length !== 1)
    issue(`binding:${binding.materialKey}`, 'block', 'Each used filament must have exactly one toolhead mapping.');
  const grouped = new Map<number, D.PrintMaterialRequirement[]>();
  for (const material of requirements.materials) {
    const binding = bindings.find(b => b.materialKey === material.key);
    const head = binding ? u1BindingHead(binding.pathId) : null;
    const candidate = candidates.find(c => c.materialKey === material.key && c.pathId === binding?.pathId);
    if (head === null || !candidate || candidate.disabledReason) {
      issue(`mapping:${material.key}`, 'block', candidate?.disabledReason ?? 'Select an available toolhead for every used filament.', material.key); continue;
    }
    grouped.set(head, [...(grouped.get(head) ?? []), material]);
    const mismatch = family(material.type) === null || family(material.type) !== family(candidate.materialType);
    if (mismatch) issue(`material:${material.key}:${candidate.pathId}:${candidate.materialType}`, 'warning',
      `Filament ${material.index + 1} uses ${material.type}; toolhead ${head + 1} reports ${candidate.materialType ?? 'unknown material'}. Printing keeps the sliced material settings.`, material.key);
    if (material.toolIndex !== head) issue(`remap:${material.key}:${head}`, 'warning',
      `Filament ${material.index + 1} was sliced for toolhead ${material.toolIndex + 1}; toolhead ${head + 1} will execute the existing toolpath and parameters.`, material.key);
    const hardware = snapshot.tools[head];
    for (const [attribute, required, actual, mismatch] of [
      ['diameter', material.nozzleDiameter, hardware?.diameter, hardware?.diameter !== material.nozzleDiameter],
      ['flow type', material.nozzleFlowType, hardware?.flow, normalizedFlow(hardware?.flow ?? null) !== normalizedFlow(material.nozzleFlowType)],
      ['hardness', material.requiredNozzleHardness, hardware?.hardness, hardware?.hardness != null && hardware.hardness < material.requiredNozzleHardness],
    ] as const) {
      if (actual == null || mismatch) issue(`hardware:${material.key}:${head}:${attribute}:${actual}:${required}`, 'warning', actual == null
        ? `Toolhead ${head + 1} ${attribute} is unreported; the slice requires ${required}. Confirm the hardware before printing.`
        : `Toolhead ${head + 1} ${attribute} is ${actual}; the slice requires ${required}. Printing retains the sliced settings.`, material.key);
    }
    const loaded = inventory.state.tools.find(t => t.toolId === u1ToolId(head))?.loadedPathId;
    if (loaded?.kind === 'known' && loaded.freshness === 'fresh' && loaded.value === null)
      issue(`load:${material.key}:${head}`, 'notice', `Toolhead ${head + 1} has inserted filament. The U1 print-start workflow will load it.`, material.key);
  }
  for (const [head, materials] of grouped) if (materials.length > 1) {
    issue(`shared:${head}:${materials.map(m => m.index).join(',')}`, 'warning',
      `Filaments ${materials.map(m => m.index + 1).join(', ')} all print with the filament loaded in toolhead ${head + 1}. Logical temperature, retraction and tower actions remain unchanged.`);
    const temperatures = materials.map(m => [m.nozzleTemperature, m.initialLayerNozzleTemperature]);
    if (temperatures.some(values => values.some(value => value === null)) || new Set(temperatures.map(values => JSON.stringify(values))).size > 1)
      issue(`heater:${head}:${JSON.stringify(temperatures)}`, 'warning', `Toolhead ${head + 1} shares a heater across differing or unknown sliced temperatures (${temperatures.map(t => t.map(v => v ?? '?').join('/')).join(', ')} °C). These logical temperature commands remain in the print.`);
  }
  const used = [...grouped.keys()].sort((a, b) => a - b);
  const subset = request.options.calibrationToolIndices;
  if (subset && (new Set(subset).size !== subset.length || subset.some(i => !Number.isInteger(i) || !used.includes(i))))
    issue('calibration', 'block', 'Calibration selection must contain only currently used toolheads.');
  const options: D.PrintOptions = { bedLeveling: request.options.bedLeveling === 'off' ? 'off' : 'on',
    flowCalibration: request.options.flowCalibration === 'off' ? 'off' : 'on', timelapse: request.options.timelapse === true,
    calibrationToolIndices: subset ?? used };
  const optionDescriptors: D.PrintOptionDescriptor[] = [
    ...(['bedLeveling', 'flowCalibration'] as const).map(key => ({ key, label: key === 'bedLeveling' ? 'Bed leveling' : 'Flow calibration', enabled: snapshot.commands.includes('SET_PRINT_PREFERENCES'), choices: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] })),
    { key: 'timelapse', label: 'Timelapse', enabled: snapshot.commands.includes('SET_PRINT_PREFERENCES'), choices: [{ value: true, label: 'On' }, { value: false, label: 'Off' }] },
  ];
  return { configurationRevision: revision, route: 'lan', nozzleLabels: [1, 2, 3, 4].map(i => `Toolhead ${i}`),
    bindings, candidates, options, optionDescriptors, issues, materialCatalogIds: [], autoMatchAvailable: true,
    calibrationTools: used.map(index => ({ index, label: `Toolhead ${index + 1}`, selected: (options.calibrationToolIndices ?? []).includes(index) })) };
}
