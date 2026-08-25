import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  Ipc,
  isMenuCommandId,
  type ElectronBridge,
  type FileDialogFilter,
  type HostCommandId,
  type MenuCommandId,
  type MenuModel,
  type MenuStateSnapshot,
  type PreferencesLoadResult,
} from '../shared/ipc';

// The renderer's only window to native features (design §Electron App).
// All IO goes through main; no node builtins leak into the renderer.
const bridge: ElectronBridge = {
  version: '0.0.0-m2-shell',

  openFileDialog: (filters: FileDialogFilter[]) =>
    ipcRenderer.invoke(Ipc.openFileDialog, filters) as Promise<{ canceled: boolean; path: string | null }>,

  saveFileDialog: (defaultName: string, filters: FileDialogFilter[]) =>
    ipcRenderer.invoke(Ipc.saveFileDialog, defaultName, filters) as Promise<{ canceled: boolean; path: string | null }>,

  readFile: (path: string) =>
    ipcRenderer.invoke(Ipc.readFile, path) as Promise<ArrayBuffer>,

  writeFile: (path: string, bytes: ArrayBuffer) =>
    ipcRenderer.invoke(Ipc.writeFile, path, bytes) as Promise<void>,

  preferences: {
    load: () => ipcRenderer.invoke(Ipc.preferencesLoad) as Promise<PreferencesLoadResult>,
    save: (json: unknown) => ipcRenderer.invoke(Ipc.preferencesSave, json) as Promise<void>,
  },

  menu: {
    syncModel: (model: MenuModel) => {
      ipcRenderer.send(Ipc.syncMenuModel, model);
    },

    syncState: (snapshot: MenuStateSnapshot) => {
      ipcRenderer.send(Ipc.syncMenuState, snapshot);
    },

    onCommand: (listener: (command: MenuCommandId) => void) => {
      const handler = (_event: IpcRendererEvent, command: unknown) => {
        if (isMenuCommandId(command)) listener(command);
      };
      ipcRenderer.on(Ipc.nativeMenuCommand, handler);
      return () => ipcRenderer.removeListener(Ipc.nativeMenuCommand, handler);
    },

    executeHostCommand: (command: HostCommandId) =>
      ipcRenderer.invoke(Ipc.executeHostCommand, command) as Promise<void>,
  },

  externalLinks: {
    openSource: () => ipcRenderer.invoke(Ipc.openSource) as Promise<void>,
  },

  // Used by the renderer to clear the macOS traffic-light zone in the
  // custom title bar (Windows/Linux WCO buttons are top-right, no CSS
  // impact on the left-aligned brand label).
  platform: process.platform,
};

contextBridge.exposeInMainWorld('orca', bridge);
