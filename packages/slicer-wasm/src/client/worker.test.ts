import { describe, it, expect } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';

// A transport that runs the worker side in-process (same-thread) so the
// protocol is testable without a real Worker. The real worker entry uses
// postMessage; here a Channel fans every message out to both sides
// (createWorkerClient's response handler + startWorker's request handler).
class Channel implements WorkerTransport {
  private listeners: ((msg: WorkerMessage) => void)[] = [];
  onMessage(fn: (msg: WorkerMessage) => void): void {
    this.listeners.push(fn);
  }
  post(msg: WorkerMessage): void {
    for (const l of this.listeners) l(msg);
  }
}

function setup() {
  const module = createMockModule();
  const channel = new Channel();
  const workerClient = createWorkerClient(channel);
  void startWorker(async () => module, (msg) => channel.post(msg), (fn) => channel.onMessage(fn));
  return { workerClient, module };
}

describe('worker protocol', () => {
  it('round-trips init through the message channel', async () => {
    const { workerClient } = setup();
    const r = await workerClient.init();
    expect(r.ok).toBe(true);
  });

  it('loads a model and slices with progress events', async () => {
    const { workerClient } = setup();
    await workerClient.init();
    await workerClient.addModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    const r = await workerClient.slice({ layer_height: '0.2' }, (pct) => events.push(pct));
    expect(r.ok).toBe(true);
    expect(events.length).toBeGreaterThan(0);
  });

  it('reads threaded progress from the shared-memory mailbox without addFunction', async () => {
    const module = createMockModule({ threaded: true });
    const channel = new Channel();
    const workerClient = createWorkerClient(channel);
    void startWorker(async () => module, (msg) => channel.post(msg), (fn) => channel.onMessage(fn));
    await workerClient.init();
    await workerClient.addModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    await workerClient.slice({}, (pct) => events.push(pct));
    expect(events).toContain(100);
    expect(module._functionRegistrations).toBe(0);
  });

  it('returns binary slice buffers as transferable-arrayable views', async () => {
    const { workerClient } = setup();
    await workerClient.init();
    await workerClient.addModel(new Uint8Array(4), 'stl');
    await workerClient.slice({}, () => {});
    const res = await workerClient.getSliceResult();
    expect(res.toolpath.vertexCount).toBeGreaterThan(0);
    expect(res.toolpath.positions.byteLength).toBe(res.toolpath.vertexCount * 3 * 4);
  });

  it('rejects on missing op', async () => {
    const { workerClient } = setup();
    await expect((workerClient as unknown as { nope(): Promise<unknown> }).nope()).rejects.toThrow();
  });
});
