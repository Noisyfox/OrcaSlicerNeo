import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), ipc: undefined as unknown }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  mocks.ipc = new EventEmitter();
  return {
    ipcMain: mocks.ipc,
    utilityProcess: { fork: mocks.fork },
    MessageChannelMain: class { port1 = {}; port2 = {}; },
  };
});
import { attachSlicerUtility } from './slicerUtility';
import { Ipc } from '../shared/ipc';

describe('window-owned slicer process', () => {
  beforeEach(() => { vi.clearAllMocks(); (mocks.ipc as EventEmitter).removeAllListeners(); });

  function setup() {
    const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }> = [];
    mocks.fork.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn(), postMessage: vi.fn() });
      children.push(child);
      return child;
    });
    const frame = { postMessage: vi.fn() };
    const contents = Object.assign(new EventEmitter(), { mainFrame: frame, send: vi.fn() });
    const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
    attachSlicerUtility(win as unknown as BrowserWindow);
    const connect = (sender = contents, senderFrame: unknown = frame) =>
      (mocks.ipc as EventEmitter).emit(Ipc.slicerConnect, { sender, senderFrame });
    return { win, contents, connect, children, frame };
  }

  it('admits only its main frame and creates one session per document', () => {
    const { connect, contents, children, frame } = setup();
    connect(contents, {});
    expect(children).toHaveLength(0);
    connect(); connect();
    expect(children).toHaveLength(1);
    expect(children[0].postMessage).toHaveBeenCalledOnce();
    expect(frame.postMessage).toHaveBeenCalledWith(Ipc.slicerPort, null, [expect.any(Object)]);
  });

  it('kills the old document session and ignores its delayed exit notification', () => {
    const { connect, contents, children, win } = setup();
    connect();
    contents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(children[0].kill).toHaveBeenCalledOnce();
    connect();
    children[0].emit('exit', 0);
    expect(contents.send).not.toHaveBeenCalled();
    children[1].emit('exit', 1);
    expect(contents.send).toHaveBeenCalledWith(Ipc.slicerFailed, expect.stringContaining('(1)'));
    connect();
    win.emit('closed');
    expect(children[2].kill).toHaveBeenCalledOnce();
    expect((mocks.ipc as EventEmitter).listenerCount(Ipc.slicerConnect)).toBe(0);
  });

  it('reports spawn failure instead of leaving startup waiting for a port', () => {
    const { connect, contents } = setup();
    mocks.fork.mockImplementationOnce(() => { throw new Error('missing utility entry'); });
    connect();
    expect(contents.send).toHaveBeenCalledWith(Ipc.slicerFailed, expect.stringContaining('missing utility entry'));
  });
});
