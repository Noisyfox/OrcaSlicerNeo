import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';

const mocks = vi.hoisted(() => ({ fork: vi.fn(), temporaryDirectory: vi.fn(), ipc: undefined as unknown }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  mocks.ipc = new EventEmitter();
  return {
    ipcMain: mocks.ipc,
    utilityProcess: { fork: mocks.fork },
    MessageChannelMain: class { port1 = {}; port2 = {}; },
  };
});
vi.mock('./slicerTemporaryDirectory', () => ({ createSlicerTemporaryDirectory: mocks.temporaryDirectory }));
import { attachSlicerUtility, stopSlicerUtilities } from './slicerUtility';
import { Ipc } from '../shared/ipc';

describe('window-owned slicer process', () => {
  const children: Array<EventEmitter & { kill: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }> = [];
  beforeEach(() => { vi.resetAllMocks(); children.length = 0; (mocks.ipc as EventEmitter).removeAllListeners(); });
  afterEach(async () => {
    for (const child of children) child.emit('exit', 0);
    await stopSlicerUtilities();
    vi.restoreAllMocks();
  });

  function setup() {
    const directories: Array<{ path: string; remove: ReturnType<typeof vi.fn> }> = [];
    mocks.temporaryDirectory.mockImplementation(() => {
      const directory = { path: `C:\\Temp with spaces\\临时\\orca-slicer-${directories.length}`, remove: vi.fn().mockResolvedValue(undefined) };
      directories.push(directory);
      return directory;
    });
    mocks.fork.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn().mockReturnValue(true), postMessage: vi.fn() });
      children.push(child);
      return child;
    });
    const frame = { postMessage: vi.fn() };
    const contents = Object.assign(new EventEmitter(), { mainFrame: frame, send: vi.fn() });
    const win = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
    attachSlicerUtility(win as unknown as BrowserWindow);
    const connect = (sender = contents, senderFrame: unknown = frame) =>
      (mocks.ipc as EventEmitter).emit(Ipc.slicerConnect, { sender, senderFrame });
    return { win, contents, connect, children, frame, directories };
  }

  it('admits only its main frame and creates one session per document', () => {
    const { connect, contents, children, frame, directories } = setup();
    connect(contents, {});
    expect(children).toHaveLength(0);
    connect(); connect();
    expect(children).toHaveLength(1);
    expect(children[0].postMessage).toHaveBeenCalledOnce();
    expect(children[0].postMessage).toHaveBeenCalledWith(
      { type: 'connect', temporaryDirectory: directories[0].path }, [expect.any(Object)],
    );
    expect(frame.postMessage).toHaveBeenCalledWith(Ipc.slicerPort, null, [expect.any(Object)]);
    expect(directories[0].remove).not.toHaveBeenCalled();
  });

  it('kills the old document session and ignores its delayed exit notification', () => {
    const { connect, contents, children, win, directories } = setup();
    connect();
    contents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(directories[0].remove).not.toHaveBeenCalled();
    connect();
    children[0].emit('exit', 0);
    expect(directories[0].remove).toHaveBeenCalledOnce();
    expect(directories[1].remove).not.toHaveBeenCalled();
    expect(contents.send).not.toHaveBeenCalled();
    children[1].emit('exit', 1);
    expect(directories[1].remove).toHaveBeenCalledOnce();
    expect(contents.send).toHaveBeenCalledWith(Ipc.slicerFailed, expect.stringContaining('(1)'));
    connect();
    win.emit('closed');
    expect(children[2].kill).toHaveBeenCalledOnce();
    expect(directories[2].remove).not.toHaveBeenCalled();
    expect((mocks.ipc as EventEmitter).listenerCount(Ipc.slicerConnect)).toBe(0);
  });

  it('reports spawn failure instead of leaving startup waiting for a port', () => {
    const { connect, contents, directories } = setup();
    mocks.fork.mockImplementationOnce(() => { throw new Error('missing utility entry'); });
    connect();
    expect(contents.send).toHaveBeenCalledWith(Ipc.slicerFailed, expect.stringContaining('missing utility entry'));
    expect(directories[0].remove).toHaveBeenCalledOnce();
  });

  it('retries a pre-spawn quit request after the utility receives its PID', async () => {
    const { connect, children, directories } = setup();
    connect();
    const host = children[0];
    host.kill.mockReturnValue(false);
    const finished = vi.fn();
    const drain = stopSlicerUtilities()!.then(finished);
    expect(host.kill).toHaveBeenCalledOnce();
    expect(directories[0].remove).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();

    host.kill.mockReturnValue(true);
    host.emit('spawn');
    expect(host.kill).toHaveBeenCalledTimes(2);
    expect(directories[0].remove).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();

    host.emit('exit', 0);
    await drain;
    expect(directories[0].remove).toHaveBeenCalledOnce();
    expect(finished).toHaveBeenCalledOnce();
    expect(stopSlicerUtilities()).toBeUndefined();
  });

  it('stops a late-spawning old document without stopping its replacement', async () => {
    const { connect, contents, children, directories } = setup();
    connect();
    const oldHost = children[0];
    oldHost.kill.mockReturnValue(false);
    contents.emit('did-start-navigation', {}, 'http://localhost/', false, true);
    expect(oldHost.kill).toHaveBeenCalledOnce();
    connect();
    const replacement = children[1];

    oldHost.kill.mockReturnValue(true);
    oldHost.emit('spawn');
    expect(oldHost.kill).toHaveBeenCalledTimes(2);
    expect(replacement.kill).not.toHaveBeenCalled();
    expect(directories[0].remove).not.toHaveBeenCalled();
    expect(directories[1].remove).not.toHaveBeenCalled();
    oldHost.emit('exit', 0);
    expect(directories[0].remove).toHaveBeenCalledOnce();
    expect(directories[1].remove).not.toHaveBeenCalled();
    expect(contents.send).not.toHaveBeenCalled();

    const drain = stopSlicerUtilities();
    expect(oldHost.kill).toHaveBeenCalledTimes(2);
    expect(replacement.kill).toHaveBeenCalledOnce();
    replacement.emit('exit', 0);
    await drain;
    expect(stopSlicerUtilities()).toBeUndefined();
  });

  it('stops a renderer-crashed session but waits for utility exit before cleanup', () => {
    const { connect, contents, children, directories } = setup();
    connect();
    contents.emit('render-process-gone');
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(directories[0].remove).not.toHaveBeenCalled();
    children[0].emit('exit', 1);
    expect(directories[0].remove).toHaveBeenCalledOnce();
    expect(contents.send).not.toHaveBeenCalled();
  });

  it('drains both process exits and outstanding directory removal before quit', async () => {
    const { connect, children, directories } = setup();
    connect();
    let finishRemoval!: () => void;
    directories[0].remove.mockImplementation(() => new Promise<void>((resolve) => { finishRemoval = resolve; }));
    const finished = vi.fn();
    const drain = stopSlicerUtilities()!.then(finished);
    expect(children[0].kill).toHaveBeenCalledOnce();
    expect(directories[0].remove).not.toHaveBeenCalled();
    children[0].emit('exit', 0);
    await Promise.resolve();
    expect(finished).not.toHaveBeenCalled();
    finishRemoval();
    await drain;
    expect(finished).toHaveBeenCalledOnce();
    expect(stopSlicerUtilities()).toBeUndefined();
  });

  it('reports cleanup failure and still settles shutdown', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { connect, children, directories } = setup();
    connect();
    directories[0].remove.mockRejectedValue(new Error('directory busy'));
    const drain = stopSlicerUtilities();
    children[0].emit('exit', 0);
    await drain;
    expect(warning).toHaveBeenCalledWith('[slicer] temporary directory cleanup failed', expect.any(Error));
    expect(stopSlicerUtilities()).toBeUndefined();
  });
});
