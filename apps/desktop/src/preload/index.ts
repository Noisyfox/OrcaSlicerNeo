import { contextBridge, ipcRenderer } from 'electron';
import { Ipc, type FileDialogFilter, type AppConfigLoadResult } from '../shared/ipc';

// The renderer's only window to native features (design §Electron App).
// All IO goes through main; no node builtins leak into the renderer.
contextBridge.exposeInMainWorld('orca', {
  version: '0.0.0-m2-shell',

  openFileDialog: (filters: FileDialogFilter[]) =>
    ipcRenderer.invoke(Ipc.openFileDialog, filters) as Promise<{ canceled: boolean; path: string | null }>,

  saveFileDialog: (defaultName: string, filters: FileDialogFilter[]) =>
    ipcRenderer.invoke(Ipc.saveFileDialog, defaultName, filters) as Promise<{ canceled: boolean; path: string | null }>,

  readFile: (path: string) =>
    ipcRenderer.invoke(Ipc.readFile, path) as Promise<ArrayBuffer>,

  writeFile: (path: string, bytes: ArrayBuffer) =>
    ipcRenderer.invoke(Ipc.writeFile, path, bytes) as Promise<void>,

  // M4: the persisted app-config JSON (installed printers + selections).
  // load() → {found, json}; save(json) persists to userData/appconfig.json.
  appConfig: {
    load: () => ipcRenderer.invoke(Ipc.appConfigLoad) as Promise<AppConfigLoadResult>,
    save: (json: unknown) => ipcRenderer.invoke(Ipc.appConfigSave, json) as Promise<void>,
  },

  minimize: () => ipcRenderer.send(Ipc.windowMinimize),
  toggleMaximize: () => ipcRenderer.send(Ipc.windowToggleMaximize),
  close: () => ipcRenderer.send(Ipc.windowClose),
});
