import { ipcMain, MessageChannelMain, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { Ipc } from '../shared/ipc';
import { createSlicerTemporaryDirectory } from './slicerTemporaryDirectory';

interface SlicerUtilitySession {
  stop(): void;
  finished: Promise<void>;
}

const sessions = new Set<SlicerUtilitySession>();
const cleanups = new Set<Promise<void>>();

function removeTemporaryDirectory(directory: ReturnType<typeof createSlicerTemporaryDirectory>): Promise<void> {
  const cleanup = directory.remove()
    .catch((error) => console.warn('[slicer] temporary directory cleanup failed', error))
    .finally(() => cleanups.delete(cleanup));
  cleanups.add(cleanup);
  return cleanup;
}

/** Quit waits for process exits so NODEFS handles are closed before removal. */
export function stopSlicerUtilities(): Promise<void> | undefined {
  if (sessions.size === 0 && cleanups.size === 0) return undefined;
  const active = [...sessions];
  for (const session of active) session.stop();
  return Promise.all([...active.map((session) => session.finished), ...cleanups]).then(() => undefined);
}

/** One authoritative slicer session per window document. Never replay mutations after a crash. */
export function attachSlicerUtility(win: BrowserWindow): void {
  let child: SlicerUtilitySession | undefined;
  const stop = () => {
    const previous = child;
    child = undefined;
    previous?.stop();
  };
  const connect = (event: Electron.IpcMainEvent) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || child) return;
    let host: UtilityProcess;
    let directory: ReturnType<typeof createSlicerTemporaryDirectory> | undefined;
    try {
      directory = createSlicerTemporaryDirectory();
      host = utilityProcess.fork(join(__dirname, 'slicer-host.js'), [], { serviceName: 'Orca Slicer Runtime' });
    } catch (error) {
      if (directory) void removeTemporaryDirectory(directory);
      win.webContents.send(Ipc.slicerFailed, `Slicer utility process could not start: ${String(error)}`);
      return;
    }
    const temporaryDirectory = directory;
    let finish!: () => void;
    let stopRequested = false;
    let stopped = false;
    const session: SlicerUtilitySession = {
      finished: new Promise<void>((resolve) => { finish = resolve; }),
      stop() {
        if (child === session) child = undefined;
        stopRequested = true;
        if (stopped) return;
        // kill() returns false until Electron assigns the utility's PID.
        // Keep the request pending so immediate reload/quit still kills it.
        stopped = host.kill();
      },
    };
    child = session;
    sessions.add(session);
    host.once('spawn', () => {
      if (stopRequested) session.stop();
    });
    host.once('exit', (code) => {
      stopped = true;
      // Old documents still own their directory until this exit, even if a
      // replacement utility has already started for the reloaded document.
      void removeTemporaryDirectory(temporaryDirectory).finally(() => {
        sessions.delete(session);
        finish();
      });
      if (child === session) {
        child = undefined;
        if (!win.isDestroyed()) win.webContents.send(Ipc.slicerFailed, `Slicer utility process exited (${code})`);
      }
    });
    try {
      const { port1, port2 } = new MessageChannelMain();
      host.postMessage({ type: 'connect', temporaryDirectory: temporaryDirectory.path }, [port1]);
      event.senderFrame.postMessage(Ipc.slicerPort, null, [port2]);
    } catch (error) {
      stop();
      win.webContents.send(Ipc.slicerFailed, `Slicer utility process could not connect: ${String(error)}`);
    }
  };
  ipcMain.on(Ipc.slicerConnect, connect);
  win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) stop();
  });
  win.webContents.on('render-process-gone', stop);
  win.once('closed', () => {
    ipcMain.removeListener(Ipc.slicerConnect, connect);
    stop();
  });
}
