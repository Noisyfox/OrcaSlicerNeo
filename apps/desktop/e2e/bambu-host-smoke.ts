/** Test entry: real utility/native plugin, two isolated renderer windows. */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { BambuUtility } from '../src/main/bambuUtility';
import { bambuPaths } from '../src/main/bambuUtility';
import { createBambuIpc } from '../src/main/bambuUtility';
import { Ipc } from '../src/shared/ipc';
const windows = new Set<BrowserWindow>();
let host: BambuUtility;
let signalReady!: () => void;
const ready = new Promise<void>(resolve => { signalReady = resolve; });
let stopping = false;
let stopped = false;
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const directory = process.env.ORCA_BAMBU_SMOKE_DIRECTORY;
  if (!directory) throw new Error('Missing smoke directory');
  ipcMain.handle(Ipc.bambuRead, createBambuIpc(async kind => { await ready; return host.read(kind); }, event => {
    const request = event as Electron.IpcMainInvokeEvent;
    return [...windows].some(window => !window.isDestroyed() && window.webContents === request.sender && request.senderFrame === request.sender.mainFrame);
  }));
  for (let i = 0; i < 2; ++i) {
    const window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: false, nodeIntegration: false } });
    windows.add(window); window.on('closed', () => windows.delete(window));
    await window.loadURL('data:text/html,<title>Bambu host smoke</title>');
    await window.webContents.executeJavaScript('window.bambuChanges = []; window.orca.bambu.onChanged(change => window.bambuChanges.push(change)); void 0;');
  }
  host = new BambuUtility(join(__dirname, 'bambu-host.js'), bambuPaths({ packaged: false, resourcesPath: process.resourcesPath, projectRoot: join(__dirname, '../../../..'),
    directory, platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion() }));
  signalReady();
  host.onChanged(change => { for (const window of windows) if (!window.isDestroyed()) window.webContents.send(Ipc.bambuChanged, change); });
});
app.on('will-quit', event => {
  if (stopped || !host) return;
  event.preventDefault();
  if (!stopping) { stopping = true; void host.close().then(() => { stopped = true; app.quit(); }); }
});
