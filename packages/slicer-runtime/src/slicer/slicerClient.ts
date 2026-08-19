// apps/desktop/src/renderer/src/slicer/slicerClient.ts
// The app's one worker-backed SlicerClient. Worker created once,
// transport = postMessage pair.
import { createWorkerClient } from '@slicer/client';
import type { SlicerClient, WorkerTransport } from '@slicer/client';

function makeTransport(): WorkerTransport {
  const worker = new Worker(new URL('./slicer.worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (msg) => worker.postMessage(msg),
    onMessage: (fn) => {
      worker.addEventListener('message', (e) => fn(e.data));
    },
  };
}

export const slicerClient: SlicerClient = createWorkerClient(makeTransport());
