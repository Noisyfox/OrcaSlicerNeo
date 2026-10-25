import type { NativeScopedConfigSnapshot } from '@slicer/client';
import { useProjectStore } from '@/stores/useProjectStore';

/** Describe repairs that are already present in a native transition receipt.
 * This never edits or normalizes maps in JavaScript. */
export function publishNozzleRepairNotice(before: NativeScopedConfigSnapshot, after: NativeScopedConfigSnapshot, nozzles: number) {
  if (nozzles < 1) return;
  let count = 0;
  for (const [key, previous] of Object.entries({ project: before.project, ...before.plates })) {
    const next = key === 'project' ? after.project : after.plates[key];
    if (!next) continue;
    const oldMap = previous.filament_map?.split(',').map(Number) ?? [];
    const newMap = next.filament_map?.split(',').map(Number) ?? [];
    count += oldMap.filter((target, index) => target > nozzles && (newMap[index] === 1 || nozzles === 1 && !newMap.length)).length;
  }
  if (count) useProjectStore.getState().setProject({ notices: [{
    kind: 'nozzle-mapping-repair',
    message: `${count} filament mapping entries referred to removed nozzles and were reassigned to nozzle 1. Valid nozzle assignments were kept. Undo restores the previous configuration.`,
  }] });
}
