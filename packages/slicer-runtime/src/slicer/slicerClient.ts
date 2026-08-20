// apps/desktop/src/renderer/src/slicer/slicerClient.ts
// The app's one worker-backed SlicerClient. Worker created once,
// transport = postMessage pair.
import { createWorkerRuntime } from '../bootstrap';

export const slicerClient = createWorkerRuntime(new URL('./slicer.worker.ts', import.meta.url));
