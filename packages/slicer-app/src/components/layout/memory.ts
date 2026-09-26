import type { MemoryEntry, PlatformMemory, PlatformMemorySnapshot, SlicerRuntime } from '@orca/platform-contract';

export type MemoryTotalKind = 'platform' | 'total-estimate';

export interface SharedRuntimeMemoryEntry extends MemoryEntry {
  readonly includedInTotal: boolean;
}

export interface MemoryIndicatorSample {
  readonly totalBytes: number;
  readonly totalKind: MemoryTotalKind;
  readonly platform: PlatformMemorySnapshot;
  readonly sharedRuntime: readonly SharedRuntimeMemoryEntry[];
}

export interface MemoryIndicatorPlatform {
  readonly memory: PlatformMemory;
  readonly runtime: Pick<SlicerRuntime, 'getRuntimeMemory'>;
}

type PerformanceWithMemory = Performance & {
  memory?: { usedJSHeapSize?: unknown };
};

function validBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function rendererJsHeapBytes(): number | undefined {
  const bytes = (performance as PerformanceWithMemory).memory?.usedJSHeapSize;
  return validBytes(bytes) ? bytes : undefined;
}

function validatePlatformSnapshot(value: PlatformMemorySnapshot): PlatformMemorySnapshot {
  if (value.totalBytes !== undefined && !validBytes(value.totalBytes))
    throw new Error('platform memory total is invalid');
  if (!Array.isArray(value.entries) || value.entries.some((entry) =>
    !entry || typeof entry.id !== 'string' || !entry.id ||
    typeof entry.label !== 'string' || !entry.label || !validBytes(entry.bytes)))
    throw new Error('platform memory entries are invalid');
  return value;
}

/** Samples host-only memory plus portable renderer/Worker diagnostics. */
export async function sampleMemoryIndicator(
  platform: MemoryIndicatorPlatform,
): Promise<MemoryIndicatorSample> {
  const rendererBytes = rendererJsHeapBytes();
  const [platformSnapshot, workerSnapshot] = await Promise.all([
    platform.memory.sample().then(validatePlatformSnapshot),
    platform.runtime.getRuntimeMemory(),
  ]);
  const jsHeapBytes = [rendererBytes, workerSnapshot.jsHeapUsedBytes]
    .filter((bytes): bytes is number => bytes !== undefined)
    .reduce((total, bytes) => total + bytes, 0);
  const totalKind: MemoryTotalKind = platformSnapshot.totalBytes !== undefined
    ? 'platform'
    : 'total-estimate';
  const totalBytes = platformSnapshot.totalBytes ?? jsHeapBytes + workerSnapshot.wasmLinearMemoryBytes;
  if (totalKind === 'total-estimate' && rendererBytes === undefined && workerSnapshot.jsHeapUsedBytes === undefined)
    throw new Error('JavaScript heap measurement is unavailable');

  const sharedRuntime: SharedRuntimeMemoryEntry[] = [
    ...(rendererBytes === undefined ? [] : [{
      id: 'renderer-js-heap', label: 'Renderer JS heap', bytes: rendererBytes, includedInTotal: true,
    }]),
    ...(workerSnapshot.jsHeapUsedBytes === undefined ? [] : [{
      id: 'worker-js-heap', label: 'Slicer Worker JS heap', bytes: workerSnapshot.jsHeapUsedBytes, includedInTotal: true,
    }]),
    {
      id: 'wasm-linear-memory', label: 'WASM linear-memory capacity',
      bytes: workerSnapshot.wasmLinearMemoryBytes,
      includedInTotal: true,
    },
  ];
  return { totalBytes, totalKind, platform: platformSnapshot, sharedRuntime };
}

export function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 * 1024 ? 1 : 0)} MiB`;
}

export function memoryTotalLabel(kind: MemoryTotalKind): string {
  return kind === 'total-estimate' ? 'Total memory estimate' : 'Memory';
}
