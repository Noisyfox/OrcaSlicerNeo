import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { RemotePrintInspector } from './remotePrintInspector';

class FakeWorker extends EventEmitter { terminate = vi.fn(async () => 0); }
const resources = [{ name: '_rels/.rels' as const, bytes: Uint8Array.of(1) }];
const value = { configuration: {}, targets: [] };
describe('remote print inspection lifetime', () => {
  it('serializes fresh Workers and joins termination before admitting the next', async () => {
    const workers: FakeWorker[] = [];
    const inspector = new RemotePrintInspector(() => { const worker = new FakeWorker(); workers.push(worker); return worker; });
    const first = inspector.inspect(resources), second = inspector.inspect(resources);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0].emit('message', { ok: true, value });
    expect(await first).toEqual(value);
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(workers).toHaveLength(2));
    workers[1].emit('message', { ok: true, value });
    await second; await inspector.close();
    expect(workers[1].terminate).toHaveBeenCalledOnce();
  });
  it('cancels active and queued work on shutdown without starting another Worker', async () => {
    const worker = new FakeWorker(), create = vi.fn(() => worker);
    const inspector = new RemotePrintInspector(create);
    const first = inspector.inspect(resources).catch(e => e.message);
    const second = inspector.inspect(resources).catch(e => e.message);
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    await inspector.close();
    expect(await first).toBe('Inspection cancelled'); expect(await second).toBe('Inspection cancelled');
    expect(create).toHaveBeenCalledOnce(); expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(inspector.inspect(resources)).rejects.toThrow('cancelled');
  });
  it('bounds admission and tears down hung parsers', async () => {
    const workers: FakeWorker[] = [];
    const inspector = new RemotePrintInspector(() => { const w = new FakeWorker(); workers.push(w); return w; }, 10);
    const pending = Array.from({ length: 4 }, () => inspector.inspect(resources).catch(e => e.message));
    await expect(inspector.inspect(resources)).rejects.toThrow('pending');
    expect(await pending[0]).toContain('timed out');
    expect(workers[0].terminate).toHaveBeenCalledOnce();
    await inspector.close(); await Promise.all(pending);
  });
});
