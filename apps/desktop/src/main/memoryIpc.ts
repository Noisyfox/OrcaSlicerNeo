import type { ElectronMemoryIpcSnapshot } from '../shared/ipc';

export interface ElectronProcessMemoryMetric {
  readonly type: string;
  readonly memory: { readonly workingSetSize: number };
}

function processLabel(type: string): string {
  return type === 'Browser' ? 'Main process' : `${type} process`;
}

/** Convert Electron's KiB process metrics into generic, additive host entries. */
export function summarizeElectronMemory(metrics: readonly ElectronProcessMemoryMetric[]): ElectronMemoryIpcSnapshot {
  const byType = new Map<string, number>();
  for (const metric of metrics) {
    const kibibytes = metric.memory?.workingSetSize;
    if (typeof metric.type !== 'string' || !metric.type ||
        !Number.isFinite(kibibytes) || kibibytes < 0) continue;
    const bytes = kibibytes * 1024;
    if (!Number.isSafeInteger(bytes)) continue;
    byType.set(metric.type, (byType.get(metric.type) ?? 0) + bytes);
  }
  const entries = [...byType.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([type, bytes]) => ({ id: `electron:${type}`, label: processLabel(type), bytes }));
  return { totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0), entries };
}
