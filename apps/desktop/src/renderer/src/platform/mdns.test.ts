import { expect, it, vi } from 'vitest';
import type { MdnsService } from '@orca/network-discovery';
import { electronMdns } from './mdns';

it('stops even when cancelled while start IPC is pending', async () => {
  let started!: () => void;
  const bridge = { start: vi.fn(() => new Promise<void>(resolve => { started = resolve; })), snapshot: vi.fn(), stop: vi.fn(async () => {}) };
  const controller = new AbortController();
  const stream = electronMdns(bridge).browse('_test._tcp.local.', { signal: controller.signal })[Symbol.asyncIterator]();
  const next = stream.next(); controller.abort(); started();
  expect((await next).done).toBe(true); expect(bridge.snapshot).not.toHaveBeenCalled(); expect(bridge.stop).toHaveBeenCalledOnce();
});
it('diffs host records and releases the scan when the consumer returns', async () => {
  vi.useFakeTimers();
  const service: MdnsService = { id: 'test', serviceType: '_test._tcp.local.', name: 'Test', host: 'test.local.', port: 80, addresses: ['127.0.0.1'], txt: {}, expiresAtMs: 1000 };
  const bridge = { start: vi.fn(async () => {}), snapshot: vi.fn(async () => [service]), stop: vi.fn(async () => {}) };
  const stream = electronMdns(bridge).browse(service.serviceType)[Symbol.asyncIterator]();
  try {
    expect((await stream.next()).value).toEqual({ type: 'upsert', service });
    bridge.snapshot.mockResolvedValue([]);
    const next = stream.next(); await vi.advanceTimersByTimeAsync(250);
    expect((await next).value).toEqual({ type: 'removed', id: service.id });
    await stream.return?.(); expect(bridge.stop).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
