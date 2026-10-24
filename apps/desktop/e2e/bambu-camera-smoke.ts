import { writeFile } from 'node:fs/promises';
/** Standalone host fixture for real main/preload/utility MessagePort ownership. */
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { BambuUtility, bambuPaths } from '../src/main/bambuUtility';
import { BambuMediaIpc } from '../src/main/bambuMediaIpc';
import { Ipc } from '../src/shared/ipc';
let host: BambuUtility, window: BrowserWindow, stopped = false;
app.whenReady().then(async () => {
  host = new BambuUtility(join(__dirname, 'bambu-camera-host.js'), bambuPaths({ packaged: false, projectRoot: join(__dirname, '../../../..'), resourcesPath: process.resourcesPath,
    directory: process.env.ORCA_BAMBU_SMOKE_DIRECTORY!, platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion() }));
  window = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const camera = new BambuMediaIpc(() => host, sender => sender === window.webContents);
  ipcMain.handle(Ipc.bambuMedia, (event, request: unknown) => camera.call(event, request));
  ipcMain.on(Ipc.bambuMediaConnect, (event, request: unknown) => { try { camera.connect(event, request); } catch {} });
  host.onChanged(change => { if (!window.isDestroyed()) window.webContents.send(Ipc.bambuChanged, change); });
  const page = join(process.env.ORCA_BAMBU_SMOKE_DIRECTORY!, 'camera.html');
  await writeFile(page, '<!doctype html><title>Camera IPC fixture</title>');
  await window.loadFile(page);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', event => { if (!stopped && host) { event.preventDefault(); stopped = true; void host.close().then(() => app.quit()); } });
