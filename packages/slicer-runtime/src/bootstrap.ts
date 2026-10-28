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

export function supportsWasm32(): boolean {
  return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
}

/** Validate an actual Memory64 module: some engines accept an i64 Memory
 * descriptor while still rejecting Memory64 instructions/modules. */
export function supportsWasm64(): boolean {
  return typeof WebAssembly === 'object' && WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 5, 3, 1, 4, 1]));
}

export function detectRuntimeCapabilities(env: RuntimeEnvironment = globalThis as unknown as RuntimeEnvironment): RuntimeCapabilities {
  const webgl2 = env.webgl2 ?? (() => { try { return typeof document !== 'undefined' && !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } })();
  const wasm64 = env.wasm64 ?? supportsWasm64();
  const sab = env.SharedArrayBuffer ?? globalThis.SharedArrayBuffer;
  const threadedWasm = (env.crossOriginIsolated ?? false) === true
    && typeof sab === 'function' && sab !== ArrayBuffer
    && typeof (env.Atomics ?? globalThis.Atomics) === 'object';
  return { webgl2, wasm64, threadedWasm };
}

export function resolveRuntimeAsset(relativePath: string, moduleBase: string | URL): string {
  return new URL(relativePath, new URL(String(moduleBase))).href;
}

export function selectRuntimeArtifact(capabilities: RuntimeCapabilities, allowWasm32 = false): 'threaded' | 'serial' | 'unsupported' {
  if (!capabilities.webgl2 || (!capabilities.wasm64 && !(allowWasm32 && supportsWasm32()))) return 'unsupported';
  return capabilities.threadedWasm ? 'threaded' : 'serial';
}

export interface RuntimeBootstrapOptions {
  transport: WorkerTransport;
  capabilities?: RuntimeCapabilities;
  /** Only the Web host ships wasm32 artifacts. Electron retains wasm64. */
  allowWasm32?: boolean;
  /** Host-supplied hook reserved for profile installation (Step 6). */
  installProfiles?: () => Promise<void>;
  initialize?: () => Promise<void>;
}

export function createWorkerTransport(workerUrl: string | URL): WorkerTransport {
  const worker = new Worker(workerUrl, { type: 'module' });
  return {
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onMessage: (listener) => worker.addEventListener('message', (event) => listener(event.data)),
  };
}

export function createWorkerRuntime(workerUrl: string | URL, options: Omit<RuntimeBootstrapOptions, 'transport'> = {}): SlicerRuntime {
  return createRuntimeBootstrap({ ...options, transport: createWorkerTransport(workerUrl) });
}

/** Keeps lifecycle state at the reusable runtime boundary while preserving the typed bridge. */
export function createRuntimeBootstrap(options: RuntimeBootstrapOptions): SlicerRuntime & {
  readonly ready: Promise<void>;
  readonly status: RuntimeStatus;
} {
  let status: RuntimeStatus = { phase: 'checking-capabilities' };
  let runtimeFailure: Error | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const startupProgressListeners = new Set<(text: string, phase: 'startup' | 'catalogue') => void>();
  const transport: WorkerTransport = {
    post: (message, transfer) => options.transport.post(message, transfer),
    onMessage: (listener) => options.transport.onMessage((message) => {
      if (message.type === 'fatal') {
        runtimeFailure = new Error(message.error);
        status = { phase: 'failed', message: message.error };
        rejectReady(runtimeFailure);
      }
      if (message.type === 'startup-progress') {
        for (const progressListener of startupProgressListeners) progressListener(message.text, message.phase);
        return;
      }
      listener(message);
    }),
  };
  const client = createWorkerClient(transport) as SlicerClient;
  // Keep lifecycle properties outside the client's Proxy dispatch. Defining
  // `status` on the Proxy itself would still be intercepted as an operation.
  const runtime = Object.create(client) as SlicerRuntime & { ready: Promise<void>; readonly status: RuntimeStatus };
  runtime.ready = ready;
  runtime.onStartupProgress = (listener) => {
    startupProgressListeners.add(listener);
    return () => startupProgressListeners.delete(listener);
  };
  Object.defineProperty(runtime, 'status', { enumerable: true, get: () => status });
  const caps = options.capabilities ?? detectRuntimeCapabilities();
  if (selectRuntimeArtifact(caps, options.allowWasm32) === 'unsupported') {
    status = { phase: 'unsupported', message: options.allowWasm32 ? 'WebGL 2 and WebAssembly are required' : 'WebGL 2 and wasm64 are required' };
    rejectReady(new Error(status.message));
  } else {
    void (async () => {
      try {
        status = { phase: 'loading-runtime' };
        await options.initialize?.();
        if (runtimeFailure) throw runtimeFailure;
        if (options.installProfiles) {
          status = { phase: 'installing-profiles' };
          await options.installProfiles();
        }
        if (runtimeFailure) throw runtimeFailure;
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
