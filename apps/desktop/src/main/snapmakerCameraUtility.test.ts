import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ utilityProcess: {} }));
import { SnapmakerCameraUtility } from './snapmakerCameraUtility';

class Child extends EventEmitter {
  messages: Record<string, unknown>[] = [];
  postMessage(message: Record<string, unknown>) { this.messages.push(message); if (message.type === 'shutdown') queueMicrotask(() => this.emit('exit', 0)); }
}
it('correlates calls, retires pending calls on exit, and signals subscribers', async () => {
  const child = new Child(), changed = vi.fn(), host = new SnapmakerCameraUtility('/camera.js', changed, () => child);
  child.emit('message', { type: 'ready' });
  const first = host.call('document', { method: 'cancelOpen', input: { requestId: 'first' as never } });
  const second = host.call('document', { method: 'cancelOpen', input: { requestId: 'second' as never } });
  await Promise.resolve();
  child.emit('message', { type: 'reply', id: child.messages[1].id, value: 'second' }); expect(await second).toBe('second');
  const rejected = expect(first).rejects.toThrow('exited'); child.emit('exit', 1); await rejected;
  expect(changed).toHaveBeenCalledOnce(); await host.close();
});
it('checks document identity again after utility readiness and closes idempotently', async () => {
  const child = new Child(), host = new SnapmakerCameraUtility('/camera.js', vi.fn(), () => child);
  let active = true;
  const call = host.call('old-document', { method: 'cancelOpen', input: { requestId: 'request' as never } }, undefined, () => active);
  active = false; child.emit('message', { type: 'ready' });
  expect(await call).toMatchObject({ ok: false, error: { code: 'cancelled' } }); expect(child.messages).toHaveLength(0);
  await host.close(); await host.close(); expect(child.messages).toEqual([{ type: 'shutdown' }]);
});
it('bounds application shutdown when the child stops responding', async () => {
  vi.useFakeTimers();
  try {
    const child = new Child(), kill = vi.fn(() => true);
    child.postMessage = message => { child.messages.push(message); };
    const host = new SnapmakerCameraUtility('/camera.js', vi.fn(), () => Object.assign(child, { kill }));
    child.emit('message', { type: 'ready' });
    const closing = host.close(); await vi.advanceTimersByTimeAsync(7000); await closing;
    expect(kill).toHaveBeenCalledOnce();
  } finally { vi.useRealTimers(); }
});
