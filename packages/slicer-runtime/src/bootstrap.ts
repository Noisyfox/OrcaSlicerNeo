import type { SlicerClient, WorkerMessage, WorkerTransport } from '../../slicer-wasm/src/client';
import type { RuntimeStatus, SlicerRuntime } from '../../platform-contract/src/contracts';
import { createWorkerClient } from '../../slicer-wasm/src/client';

export interface RuntimeCapabilities { webgl2: boolean; wasm64: boolean; threadedWasm: boolean; }
export interface RuntimeEnvironment {
  webgl2?: boolean;
  wasm64?: boolean;
  crossOriginIsolated?: boolean;
  SharedArrayBuffer?: unknown;
  Atomics?: unknown;
}

export function detectRuntimeCapabilities(env: RuntimeEnvironment = globalThis as unknown as RuntimeEnvironment): RuntimeCapabilities {
  const webgl2 = env.webgl2 ?? (() => { try { return typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
  const wasm64 = env.wasm64 ?? (() => { try { new WebAssembly.Memory({ initial: 1n, maximum: 1n, address: 'i64' } as unknown as WebAssembly.MemoryDescriptor & { address: string }); return true; } catch { return false; } })();
  const sab = env.SharedArrayBuffer ?? globalThis.SharedArrayBuffer;
  const threadedWasm = (env.crossOriginIsolated ?? false) === true
    && typeof sab === 'function' && sab !== ArrayBuffer
    && typeof (env.Atomics ?? globalThis.Atomics) === 'object';
  return { webgl2, wasm64, threadedWasm };
}

export function resolveRuntimeAsset(relativePath: string, moduleBase: string | URL): string {
  return new URL(relativePath, new URL(String(moduleBase))).href;
}

export function selectRuntimeArtifact(capabilities: RuntimeCapabilities): 'threaded' | 'serial' | 'unsupported' {
  if (!capabilities.webgl2 || !capabilities.wasm64) return 'unsupported';
  return capabilities.threadedWasm ? 'threaded' : 'serial';
}

export interface RuntimeBootstrapOptions {
  transport: WorkerTransport;
  capabilities?: RuntimeCapabilities;
  /** Host-supplied hook reserved for profile installation (Step 6). */
  installProfiles?: () => Promise<void>;
  initialize?: () => Promise<void>;
}

export function createWorkerTransport(workerUrl: string | URL): WorkerTransport {
  // Vite's linked-workspace e2e build may inline the module worker as a data
  // URL. Materialize it as a blob URL so Chromium's worker policy can keep
  // script workers same-origin/blob-scoped without requiring data workers.
  const rawUrl = String(workerUrl);
  let effectiveUrl: string | URL = workerUrl;
  if (rawUrl.startsWith('data:')) {
    const comma = rawUrl.indexOf(',');
    if (comma < 0) throw new Error('invalid inline worker URL');
    const header = rawUrl.slice(0, comma);
    const payload = rawUrl.slice(comma + 1);
    const source = header.includes(';base64')
      ? atob(payload)
      : decodeURIComponent(payload);
    const bytes = Uint8Array.from(source, (char) => char.charCodeAt(0));
    effectiveUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }));
  }
  const worker = new Worker(effectiveUrl, { type: 'module' });
  return {
    post: (message) => worker.postMessage(message),
    onMessage: (listener) => worker.addEventListener('message', (event) => listener(event.data)),
  };
}

export function createWorkerRuntime(workerUrl: string | URL, options: Omit<RuntimeBootstrapOptions, 'transport'> = {}): SlicerRuntime {
  return createRuntimeBootstrap({ ...options, transport: createWorkerTransport(workerUrl) });
}

/** Keeps lifecycle state at the reusable runtime boundary while preserving the typed bridge. */
export function createRuntimeBootstrap(options: RuntimeBootstrapOptions): SlicerRuntime {
  let status: RuntimeStatus = { phase: 'checking-capabilities' };
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const client = createWorkerClient(options.transport) as SlicerClient;
  // Keep lifecycle properties outside the client's Proxy dispatch. Defining
  // `status` on the Proxy itself would still be intercepted as an operation.
  const runtime = Object.create(client) as SlicerRuntime & { ready: Promise<void> };
  runtime.ready = ready;
  Object.defineProperty(runtime, 'status', { enumerable: true, get: () => status });
  const caps = options.capabilities ?? detectRuntimeCapabilities();
  if (selectRuntimeArtifact(caps) === 'unsupported') {
    status = { phase: 'unsupported', message: 'WebGL 2 and wasm64 are required' };
    rejectReady(new Error(status.message));
  } else {
    void (async () => {
      try {
        status = { phase: 'loading-runtime' };
        await options.initialize?.();
        if (options.installProfiles) {
          status = { phase: 'installing-profiles' };
          await options.installProfiles();
        }
        status = { phase: 'ready' };
        resolveReady();
      } catch (error) {
        status = { phase: 'failed', message: String(error) };
        rejectReady(error);
      }
    })();
  }
  return runtime;
}

export type { WorkerMessage, WorkerTransport };
