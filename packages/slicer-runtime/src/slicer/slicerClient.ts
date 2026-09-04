// packages/slicer-runtime/src/slicer/slicerClient.ts
// The app's one worker-backed SlicerClient. Worker created once,
// transport = postMessage pair.
import { createWorkerRuntime } from '../bootstrap';
// `?worker&url` forces Vite to emit a same-origin worker asset instead of
// inlining the linked workspace worker as a data URL (which CSP blocks).
import workerUrl from './slicer.worker.ts?worker&url';

// Public runtime helpers are also consumed by isolated Node/Vitest tests. Do
// not construct a browser Worker merely because the package barrel was
// imported; the real hosts always provide Worker and get the normal client.
export const slicerClient = typeof Worker === 'undefined'
  ? ({} as ReturnType<typeof createWorkerRuntime>)
  : createWorkerRuntime(workerUrl);
