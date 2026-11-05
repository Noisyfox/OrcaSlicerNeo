/** U1 wire preparation. This module consumes structured slice metadata, never file contents.
 * Protocol reference: Snapmaker/u1-klipper 7ac453b, extras/print_task_config.py.
 * These limits describe that U1 protocol, not the project's material-slot limit.
 */
export interface U1MaterialBinding {
  filamentId: number;
  toolIndex: number;
}

export interface U1PrintPreparation {
  usedFilamentIds: readonly number[];
  bindings: readonly U1MaterialBinding[];
  bedLeveling: boolean;
  flowCalibration: boolean;
  timelapse: boolean;
  /** Omitted selects every used physical head; an empty selection calibrates none. */
  calibrationToolIndices?: readonly number[];
}

function index(value: number, limit: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= limit) {
    throw new Error(`Invalid U1 ${label}`);
  }
}

/** Validate the entire request before returning any commands for execution. */
export function prepareU1Print(request: U1PrintPreparation): {
  commands: readonly string[];
  usedToolIndices: readonly number[];
  calibrationToolIndices: readonly number[];
} {
  for (const value of [request.bedLeveling, request.flowCalibration, request.timelapse]) {
    if (typeof value !== 'boolean') throw new Error('Invalid U1 print option');
  }
  const used = new Set<number>();
  for (const filament of request.usedFilamentIds) {
    index(filament, 32, 'logical filament index');
    if (used.has(filament)) throw new Error('Duplicate U1 logical filament');
    used.add(filament);
  }
  if (!used.size) throw new Error('U1 print has no used filaments');

  const mapping = new Map<number, number>();
  for (const binding of request.bindings) {
    index(binding.filamentId, 32, 'logical filament index');
    index(binding.toolIndex, 4, 'physical tool index');
    if (!used.has(binding.filamentId)) throw new Error('U1 binding is not used by this slice');
    if (mapping.has(binding.filamentId)) throw new Error('Duplicate U1 filament binding');
    mapping.set(binding.filamentId, binding.toolIndex);
  }
  if (mapping.size !== used.size) throw new Error('Missing U1 filament binding');

  const heads = [...new Set(mapping.values())].sort((a, b) => a - b);
  const calibration = new Set<number>();
  for (const head of request.calibrationToolIndices ?? heads) {
    index(head, 4, 'calibration tool index');
    if (!heads.includes(head)) throw new Error('U1 calibration tool is not used by this print');
    calibration.add(head);
  }
  const selected = request.flowCalibration ? [...calibration].sort((a, b) => a - b) : [];
  const commands = [...mapping].sort(([a], [b]) => a - b).map(([filament, head]) =>
    `SET_PRINT_EXTRUDER_MAP CONFIG_EXTRUDER=${filament} MAP_EXTRUDER=${head}`);
  commands.push(`SET_PRINT_USED_EXTRUDERS EXTRUDERS=${heads.join(',')}`);
  // Do not send an empty comma-list: the firmware parses every element as an integer.
  const flow = selected.length > 0;
  commands.push(`SET_PRINT_PREFERENCES BED_LEVEL=${Number(request.bedLeveling)}`
    + ` FLOW_CALIBRATE=${Number(flow)} TIME_LAPSE_CAMERA=${Number(request.timelapse)}`
    + (flow ? ` FLOW_CALIBRATE_EXTRUDERS=${selected.join(',')}` : ''));
  return { commands, usedToolIndices: heads, calibrationToolIndices: selected };
}
