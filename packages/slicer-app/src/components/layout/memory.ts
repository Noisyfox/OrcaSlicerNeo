import type { MemoryEntry, PlatformMemory, PlatformMemorySnapshot, SlicerRuntime } from '@orca/platform-contract';

export type MemoryTotalKind = 'platform' | 'browser' | 'js-heap-estimate';

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

type BrowserPerformance = Performance & {
  memory?: { usedJSHeapSize?: unknown };
  measureUserAgentSpecificMemory?: () => Promise<{ bytes?: unknown }>;
};

const BROWSER_TOTAL_TIMEOUT_MS = 1_000;
let pendingBrowserTotal: Promise<number | undefined> | undefined;

function validBytes(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function rendererJsHeapBytes(): number | undefined {
  const bytes = (performance as BrowserPerformance).memory?.usedJSHeapSize;
  return validBytes(bytes) ? bytes : undefined;
}

async function browserTotalBytes(): Promise<number | undefined> {
  const measure = (performance as BrowserPerformance).measureUserAgentSpecificMemory;
  if (!measure) return undefined;
  if (!pendingBrowserTotal) {
    const measurement = measure.call(performance)
      .then((result) => validBytes(result?.bytes) ? result.bytes : undefined)
      .catch(() => undefined);
    pendingBrowserTotal = measurement;
    void measurement.finally(() => {
      if (pendingBrowserTotal === measurement) pendingBrowserTotal = undefined;
    });
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pendingBrowserTotal,
      new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), BROWSER_TOTAL_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
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
  const browserBytes = platformSnapshot.totalBytes === undefined ? await browserTotalBytes() : undefined;
  const fallbackJsBytes = [rendererBytes, workerSnapshot.jsHeapUsedBytes]
    .filter((bytes): bytes is number => bytes !== undefined)
    .reduce((total, bytes) => total + bytes, 0);
  const totalKind: MemoryTotalKind = platformSnapshot.totalBytes !== undefined
    ? 'platform'
    : browserBytes !== undefined ? 'browser' : 'js-heap-estimate';
  const totalBytes = platformSnapshot.totalBytes ?? browserBytes ?? fallbackJsBytes;
  if (totalKind === 'js-heap-estimate' && rendererBytes === undefined && workerSnapshot.jsHeapUsedBytes === undefined)
    throw new Error('JavaScript heap measurement is unavailable');

  const jsHeapIncluded = totalKind !== 'js-heap-estimate' || fallbackJsBytes > 0;
  const sharedRuntime: SharedRuntimeMemoryEntry[] = [
    ...(rendererBytes === undefined ? [] : [{
      id: 'renderer-js-heap', label: 'Renderer JS heap', bytes: rendererBytes, includedInTotal: jsHeapIncluded,
    }]),
    ...(workerSnapshot.jsHeapUsedBytes === undefined ? [] : [{
      id: 'worker-js-heap', label: 'Slicer Worker JS heap', bytes: workerSnapshot.jsHeapUsedBytes, includedInTotal: jsHeapIncluded,
    }]),
    {
      id: 'wasm-linear-memory', label: 'WASM linear-memory capacity',
      bytes: workerSnapshot.wasmLinearMemoryBytes,
      includedInTotal: totalKind !== 'js-heap-estimate',
    },
  ];
  return { totalBytes, totalKind, platform: platformSnapshot, sharedRuntime };
}

export function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 1024 * 1024 * 1024 ? 1 : 0)} MiB`;
}

export function memoryTotalLabel(kind: MemoryTotalKind): string {
  return kind === 'js-heap-estimate' ? 'JS heap estimate' : 'Memory';
}
