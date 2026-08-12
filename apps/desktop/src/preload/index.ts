import { contextBridge } from 'electron';

// Milestone 2 extends this API with native dialogs, file read/write, and
// window controls. For now expose a version marker so the renderer can
// assert the preload bridge is alive.
contextBridge.exposeInMainWorld('orca', {
  version: '0.0.0-m0-shell',
});
