import { startSlicerHost } from './workerHost';
import { createFetchProfileSource, resolveDeploymentBase, resolveProfileBaseUrl } from '../profiles';
import type { OrcaModule, WorkerMessage } from '@slicer/client';

const base = resolveDeploymentBase(import.meta.env.BASE_URL, String(import.meta.url));
startSlicerHost({
  threaded: typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
    && typeof SharedArrayBuffer === 'function' && typeof Atomics === 'object',
  async load(variant) {
    const url = new URL(`wasm/${variant}/orca_slice.js`, base).href;
    const mod = await import(/* @vite-ignore */ url) as {
      default: (options: { noInitialRun: boolean; locateFile(path: string): string }) => Promise<OrcaModule>;
    };
    return mod.default({ noInitialRun: true,
      locateFile: (path) => new URL(`wasm/${variant}/${path}`, base).href });
  },
  profiles: createFetchProfileSource(resolveProfileBaseUrl(import.meta.env.BASE_URL, String(import.meta.url))),
  post: (message, transfer) => (self as unknown as {
    postMessage(message: WorkerMessage, transfer: Transferable[]): void;
  }).postMessage(message, transfer ?? []),
  onMessage: (listener) => { self.onmessage = (event: MessageEvent<WorkerMessage>) => listener(event.data); },
});
