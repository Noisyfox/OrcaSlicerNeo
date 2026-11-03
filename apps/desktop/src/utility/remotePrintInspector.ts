import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { RemotePrintMetadata, RemotePrintResourceBytes } from '../../../../packages/slicer-runtime/src/core';

interface InspectionWorker {
  once(event: 'message', listener: (message: { ok: boolean; value?: RemotePrintMetadata }) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}
type WorkerFactory = (resources: readonly RemotePrintResourceBytes[]) => InspectionWorker;

/** One WASM inspection at a time, with bounded admission. Every request gets a
 * fresh Worker; success, abort, parser fault and host shutdown all join teardown.
 * This owner is utility-local and never uses the active project's slicer host. */
export class RemotePrintInspector {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly requests = new Set<AbortController>();
  private closed = false;

  constructor(private readonly createWorker: WorkerFactory = resources =>
    new Worker(join(__dirname, 'remote-print-worker.js'), { workerData: resources }),
  private readonly timeoutMs = 30_000) {}

  inspect(resources: readonly RemotePrintResourceBytes[], signal?: AbortSignal): Promise<RemotePrintMetadata> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error('Inspection cancelled'));
    if (this.requests.size >= 4) return Promise.reject(new Error('Too many pending inspections'));
    // Reject oversized admission before copying or queuing. The runtime and C++
    // repeat validation at their own boundaries.
    if (resources.length > 6 || resources.reduce((sum, r) => sum + r.bytes.byteLength, 0) > 16 * 1024 * 1024)
      return Promise.reject(new Error('Inspection metadata exceeds its size limit'));
    const owned = resources.map(resource => ({ name: resource.name, bytes: resource.bytes.slice() }));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    this.requests.add(controller);
    const result = this.tail.catch(() => {}).then(() => this.run(owned, controller.signal));
    this.tail = result;
    return result.finally(() => {
      signal?.removeEventListener('abort', abort);
      this.requests.delete(controller);
    });
  }

  private async run(resources: readonly RemotePrintResourceBytes[], signal: AbortSignal): Promise<RemotePrintMetadata> {
    if (signal.aborted) throw new Error('Inspection cancelled');
    const worker = this.createWorker(resources);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<RemotePrintMetadata>((resolve, reject) => {
        abort = () => reject(new Error('Inspection cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => reject(new Error('Device file inspection timed out')), this.timeoutMs);
        worker.once('message', reply => reply?.ok && reply.value
          ? resolve(reply.value) : reject(new Error('Cannot inspect the device file metadata')));
        worker.once('error', () => reject(new Error('Device file inspection failed')));
        worker.once('exit', () => reject(new Error('Device file inspection stopped')));
        if (signal.aborted) abort();
      });
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
      await worker.terminate();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.requests) controller.abort();
    await this.tail.catch(() => {});
  }
}
