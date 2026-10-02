import { ipcMain, MessageChannelMain, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { Ipc } from '../shared/ipc';

/** One authoritative slicer session per window document. Never replay mutations after a crash. */
export function attachSlicerUtility(win: BrowserWindow): void {
  let child: UtilityProcess | undefined;
  const stop = () => {
    const previous = child;
    child = undefined;
    previous?.kill();
  };
  const connect = (event: Electron.IpcMainEvent) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || child) return;
    let host: UtilityProcess;
    try {
      host = utilityProcess.fork(join(__dirname, 'slicer-host.js'), [], { serviceName: 'Orca Slicer Runtime' });
    } catch (error) {
      win.webContents.send(Ipc.slicerFailed, `Slicer utility process could not start: ${String(error)}`);
      return;
    }
    child = host;
    const { port1, port2 } = new MessageChannelMain();
    host.on('exit', (code) => {
      if (child !== host) return;
      child = undefined;
      if (!win.isDestroyed()) win.webContents.send(Ipc.slicerFailed, `Slicer utility process exited (${code})`);
    });
    host.postMessage({ type: 'connect' }, [port1]);
    event.senderFrame.postMessage(Ipc.slicerPort, null, [port2]);
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
