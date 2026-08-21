// packages/slicer-runtime/src/slicer/slicerClient.ts
// The app's one worker-backed SlicerClient. Worker created once,
// transport = postMessage pair.
import { createWorkerRuntime } from '../bootstrap';
// `?worker&url` forces Vite to emit a same-origin worker asset instead of
// inlining the linked workspace worker as a data URL (which CSP blocks).
import workerUrl from './slicer.worker.ts?worker&url';

export const slicerClient = createWorkerRuntime(workerUrl);
