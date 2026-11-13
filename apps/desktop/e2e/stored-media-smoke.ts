import { writeFile } from 'node:fs/promises';
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import type * as D from '@orca/platform-contract';
import { TransferQueue } from '@orca/printer-control/transfer-queue';
import { BambuUtility, bambuPaths } from '../src/main/bambuUtility';
import { BambuMediaIpc } from '../src/main/bambuMediaIpc';
import { StoredMediaQueue } from '../src/main/storedMediaQueue';
import { Ipc } from '../src/shared/ipc';
let host: BambuUtility, window: BrowserWindow, stopped = false;
const queue = new TransferQueue(2);
app.whenReady().then(async () => {
  const directory = process.env.ORCA_BAMBU_SMOKE_DIRECTORY!;
  host = new BambuUtility(join(__dirname, 'stored-media-host.js'), bambuPaths({ packaged: false, projectRoot: join(__dirname, '../../../..'), resourcesPath: process.resourcesPath,
    directory, platform: process.platform, arch: process.arch, osVersion: process.getSystemVersion() }));
  window = new BrowserWindow({ show: true, webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const queued = new StoredMediaQueue(queue, {
    resolve: async () => ({ ok: true, value: { physicalPrinterKey: 'fixture' } }),
    open: async (owner, request) => await host.media(owner, { method: 'open', input: request }) as D.Result<D.MediaDescriptor>,
    waitRead: (owner, ref) => host.host('media.waitRead', { owner, ref }),
    close: (owner, ref) => host.media(owner, { method: 'close', input: ref }),
    cancelOpen: (owner, requestId) => host.media(owner, { method: 'cancelOpen', input: { requestId } }),
  });
  const media = new BambuMediaIpc(() => host, sender => sender === window.webContents, queued);
  ipcMain.handle(Ipc.bambuMedia, (event, request: unknown) => media.call(event, request));
  ipcMain.on(Ipc.bambuMediaConnect, (event, request: unknown) => { try { media.connect(event, request); } catch {} });
  host.onChanged(change => { if (!window.isDestroyed()) window.webContents.send(Ipc.bambuChanged, change); });
  const page = join(directory, 'media.html'); await writeFile(page, '<!doctype html><title>Stored media fixture</title><video muted playsinline></video>'); await window.loadFile(page);
});
app.on('window-all-closed', () => app.quit());
app.on('will-quit', event => { if (!stopped && host) { event.preventDefault(); stopped = true; void queue.stop().then(() => host.close()).then(() => app.quit()); } });
