import { describe, it, expect } from 'vitest';
import { createMockModule } from './testing/mock-module';
import { createWorkerClient, startWorker, type WorkerMessage, type WorkerTransport } from './worker';

// A transport that runs the worker side in-process (same-thread) so the
// protocol is testable without a real Worker. The real worker entry uses
// postMessage; here a Channel fans every message out to both sides
// (createWorkerClient's response handler + startWorker's request handler).
class Channel implements WorkerTransport {
  private listeners: ((msg: WorkerMessage) => void)[] = [];
  transfers: Transferable[][] = [];
  onMessage(fn: (msg: WorkerMessage) => void): void {
    this.listeners.push(fn);
  }
  post(msg: WorkerMessage, transfer?: Transferable[]): void {
    if (transfer) this.transfers.push(transfer);
    for (const l of this.listeners) l(msg);
  }
}

function setup(beforeRequest?: (op: string, args: unknown[]) => Promise<void> | void) {
  const module = createMockModule();
  const channel = new Channel();
  const workerClient = createWorkerClient(channel);
  void startWorker(async () => module, (msg, transfer) => channel.post(msg, transfer), (fn) => channel.onMessage(fn), undefined, beforeRequest);
  return { workerClient, module, channel };
}

describe('worker protocol', () => {
  it('round-trips init through the message channel', async () => {
    const { workerClient } = setup();
    const r = await workerClient.init();
    expect(r.ok).toBe(true);
  });

  it('runs the optional request hook before dispatching an operation', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const { workerClient } = setup((op, args) => { calls.push([op, args]); });
    const r = await workerClient.init();
    expect(r.ok).toBe(true);
    expect(calls).toEqual([['init', []]]);
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
    expect(res.toolpath.segmentCount).toBeGreaterThan(0);
    expect(res.toolpath.ends.byteLength).toBe(res.toolpath.segmentCount * 3 * 4);
  });

  it('round-trips project operations and transfers the exported archive', async () => {
    const { workerClient, channel } = setup();
    await workerClient.init();
    await workerClient.addModel(new Uint8Array(4), 'stl');
    const events: number[] = [];
    const loaded = await workerClient.loadProject(new Uint8Array([0x50, 0x4b]), 'project', 'saved.3mf', (percent) => events.push(percent));
    expect(loaded.ok).toBe(true);
    expect(events).toContain(100);
    const exported = await workerClient.exportProject();
    expect(exported.ok).toBe(true);
    expect(exported.bytes.byteLength).toBeGreaterThan(0);
    const transfer = channel.transfers.find((items) => items.includes(exported.bytes.buffer));
    expect(transfer).toBeDefined();
  });

  it('preserves the client receiver for composed project preflight operations', async () => {
    const { workerClient } = setup();
    await workerClient.init();
    const preflight = await workerClient.preflightProject(new Uint8Array([0x50, 0x4b]), 'clean.3mf');
    expect(preflight.ok).toBe(true);
    expect(preflight.preflightToken).toBe('mock-preflight');
    expect(preflight.embeddedPresetWarnings?.requiresConfirmation).toBe(false);
  });

  it('forwards geometry-only project load progress through the threaded mailbox', async () => {
    const module = createMockModule({ threaded: true });
    const channel = new Channel();
    const workerClient = createWorkerClient(channel);
    void startWorker(async () => module, (msg) => channel.post(msg), (fn) => channel.onMessage(fn));
    await workerClient.init();
    const events: number[] = [];
    const loaded = await workerClient.importProjectGeometry(new Uint8Array([0x50, 0x4b]), 'part.3mf', (percent) => events.push(percent));
    expect(loaded.ok).toBe(true);
    expect(events).toContain(100);
    expect(module._functionRegistrations).toBe(0);
  });

  it('transfers each v2 result ArrayBuffer exactly once from the worker', async () => {
    const { workerClient, channel } = setup();
    await workerClient.init();
    await workerClient.addModel(new Uint8Array(4), 'stl');
    await workerClient.slice({});
    const result = await workerClient.getSliceResult();
    const responseTransfers = channel.transfers.find((items) => items.length > 5);
    expect(responseTransfers).toBeDefined();
    expect(new Set(responseTransfers as Transferable[]).size).toBe((responseTransfers as Transferable[]).length);
    expect(result.toolpath.starts).toBeInstanceOf(Float32Array);
    expect(result.toolpath.gcodeIds).toBeInstanceOf(Uint32Array);
  });

  it('rejects on missing op', async () => {
    const { workerClient } = setup();
    await expect((workerClient as unknown as { nope(): Promise<unknown> }).nope()).rejects.toThrow();
  });

  it('rejects a directional jump request without an explicit direction', async () => {
    const { workerClient } = setup();
    await expect((workerClient as unknown as { jumpHistory(id: string): Promise<unknown> }).jumpHistory('entry-1'))
      .rejects.toThrow('malformed history jump request');
  });
});
