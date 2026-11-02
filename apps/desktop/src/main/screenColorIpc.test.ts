import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { createScreenColorIpc } from './screenColorIpc';

function setup() {
  const sender = Object.assign(new EventEmitter(), { isDestroyed: vi.fn(() => false), mainFrame: {} });
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent;
  const native = { available: true, pick: vi.fn(async (_signal: AbortSignal) => ({ status: 'picked' as const, color: '#12abef' })), close: vi.fn() };
  const restoreFocus = vi.fn();
  const ipc = createScreenColorIpc({ native, authorized: event => event.sender === sender as unknown && event.senderFrame === sender.mainFrame, restoreFocus });
  return { sender, event, native, ipc, restoreFocus };
}

describe('screen color IPC', () => {
  it('exposes only local availability and validates the native RGB result', async () => {
    const { ipc, event, native, restoreFocus, sender } = setup();
    expect(ipc.available(event)).toBe(true);
    expect(native.pick).not.toHaveBeenCalled();
    expect(await ipc.pick(event, 'request-1')).toEqual({ status: 'picked', color: '#12ABEF' });
    expect(restoreFocus).toHaveBeenCalledWith(sender);
    expect(sender.listenerCount('destroyed')).toBe(0);
  });
  it('rejects guests, subframes and malformed request ids before opening a sampler', async () => {
    const { ipc, event, native } = setup();
    const guest = { ...event, senderFrame: {} } as IpcMainInvokeEvent;
    expect(() => ipc.available(guest)).toThrow('rejected');
    await expect(ipc.pick(guest, 'request')).rejects.toThrow('rejected');
    expect(() => ipc.cancel(guest, 'request')).toThrow('rejected');
    for (const id of [null, {}, '', '../path', 'x'.repeat(65)]) await expect(ipc.pick(event, id)).rejects.toThrow('request id');
    expect(native.pick).not.toHaveBeenCalled();
  });
  it('does not open anything without a loaded addon', async () => {
    const ipc = createScreenColorIpc({ native: null, authorized: () => true, restoreFocus: vi.fn() });
    expect(ipc.available({} as IpcMainInvokeEvent)).toBe(false);
    expect(await ipc.pick({} as IpcMainInvokeEvent, 'request')).toEqual({ status: 'failed' });
  });
  it('serializes native requests and only cancels the matching request', async () => {
    const { ipc, event, native } = setup();
    let signal!: AbortSignal;
    let complete!: (value: never) => void;
    native.pick.mockImplementationOnce(next => { signal = next; return new Promise(resolve => { complete = resolve; }); });
    const pending = ipc.pick(event, 'one');
    expect(await ipc.pick(event, 'two')).toEqual({ status: 'failed' });
    ipc.cancel(event, 'old'); expect(signal.aborted).toBe(false);
    ipc.cancel(event, 'one'); expect(signal.aborted).toBe(true);
    complete({ status: 'picked', color: '#ABCDEF' } as never);
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(await ipc.pick(event, 'two')).toEqual({ status: 'picked', color: '#12ABEF' });
  });
  for (const name of ['destroyed', 'render-process-gone', 'will-navigate']) {
    it(`invalidates outstanding results on ${name}`, async () => {
      const { ipc, event, native, sender, restoreFocus } = setup();
      native.pick.mockImplementationOnce(signal => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'picked', color: '#ABCDEF' }), { once: true })));
      const pending = ipc.pick(event, 'request');
      sender.emit(name);
      expect(await pending).toEqual({ status: 'cancelled' });
      expect(restoreFocus).not.toHaveBeenCalled();
      expect(sender.listenerCount(name)).toBe(0);
    });
  }
  it('reports failed native operations and closes pending work at host shutdown', async () => {
    const { ipc, event, native } = setup();
    native.pick.mockRejectedValueOnce(new Error('portal failed'));
    expect(await ipc.pick(event, 'failed')).toEqual({ status: 'failed' });
    native.pick.mockImplementationOnce(signal => new Promise(resolve => signal.addEventListener('abort', () => resolve({ status: 'picked', color: '#ABCDEF' }), { once: true })));
    const pending = ipc.pick(event, 'pending'); ipc.close();
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(native.close).toHaveBeenCalledOnce();
  });
});
