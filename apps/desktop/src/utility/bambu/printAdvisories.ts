import type * as D from '@orca/printer-control/domain';
import type { CommandContext } from './commands';
import { printerFilamentId } from './printResources';
/** Non-blocking Orca pre-print diagnostics for fixed-nozzle jobs. */
export function printAdvisories(request: D.PrintPreparationRequest, context: CommandContext, options: D.PrintOptions, used: readonly D.MaterialPath[], external: (path: D.MaterialPath) => boolean): D.PrintIssue[] {
  const issues: D.PrintIssue[] = [], device = context.machine;
  const warn = (id: string, message: string) => issues.push({ id, message, severity: 'warning' });
  if (used.some(path => external(path) && used.some(other => other.toolId === path.toolId && !external(other)))) warn('mixed-source-handling', 'This tool uses both AMS and external material. Follow the printer instructions when changing supply sources.');
  // DeviceManager.cpp::is_stringing_prone_filament: firmware IDs and diameter buckets.
  if (device.smartNozzleBlob.supported && device.smartNozzleBlob.mode !== 'auto' && request.requirements.materials.some(m => request.requirements.nozzleDiameters.some(d =>
    d >= .3 && (d < .5 ? ['GFA11', 'GFU90', 'GFU00', 'GFU02', 'GFU98'] : ['GFA11', 'GFU00']).includes(printerFilamentId(m.presetId)))))
    warn('smart-nozzle-blob', 'Stringing-prone filament is used. Set nozzle clumping detection to Auto on the printer for best print quality.');
  if (options.flowCalibration === 'auto') {
    const configured = used.some(path => {
      const match = /^path:(\d+):(\d+):/.exec(path.id); if (!match) return false;
      const tray = external(path) ? device.externalSpools.find(t => t.id === match[1])
        : device.amsUnits.find(a => a.id === match[1])?.trays.find(t => t.id === match[2]);
      return tray?.manualPressureAdvance === true;
    });
    if (configured) warn('manual-pa-not-used', 'Auto flow calibration will not use the manual K-value selected for a mapped source.');
  }
  if (options.timelapse) for (const warning of request.requirements.warnings) {
    if (warning.message === 'not_support_traditional_timelapse') warn('traditional-timelapse', 'Traditional timelapse is not supported by this slice. Check the recording mode.');
    if (warning.message === 'smooth_timelapse_without_prime_tower') warn('smooth-timelapse-tower', 'Smooth timelapse without a prime tower may affect print quality.');
  }
  return issues;
}
