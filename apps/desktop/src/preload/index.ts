import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
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
  type PrinterTransportIpcRequest,
  type PrinterTransportIpcResponse,
  type PrinterTransportProgress,
} from '../shared/ipc';
import { normalizePrinterConfigurationDocument, type PrinterConfigurationDocument } from '../../../../packages/printer-control/src/configuration';

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

  projects: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
    open: () => ipcRenderer.invoke(Ipc.projectOpen) as Promise<import('../shared/ipc').ProjectOpenIpcResult>,
    openMany: () => ipcRenderer.invoke(Ipc.projectOpen) as Promise<import('../shared/ipc').ProjectOpenIpcResult>,
    openDropped: (paths) => ipcRenderer.invoke(Ipc.projectOpenDropped, paths) as Promise<import('../shared/ipc').ProjectOpenIpcResult>,
    save: (locationToken: string | null, defaultName: string, bytes: ArrayBuffer) =>
      ipcRenderer.invoke(Ipc.projectSave, locationToken, defaultName, bytes) as Promise<import('../shared/ipc').ProjectSaveIpcResult>,
    saveAs: (defaultName: string, bytes: ArrayBuffer) =>
      ipcRenderer.invoke(Ipc.projectSaveAs, defaultName, bytes) as Promise<import('../shared/ipc').ProjectSaveIpcResult>,
  },

  lifecycle: {
    onCloseRequest: (listener) => {
      const handler = () => { void listener(); };
      ipcRenderer.on(Ipc.windowCloseRequest, handler);
      return () => ipcRenderer.removeListener(Ipc.windowCloseRequest, handler);
    },
    respondClose: (allow) => ipcRenderer.invoke(Ipc.windowCloseDecision, allow) as Promise<void>,
  },

  preferences: {
    load: () => ipcRenderer.invoke(Ipc.preferencesLoad) as Promise<PreferencesLoadResult>,
    save: (json: unknown) => ipcRenderer.invoke(Ipc.preferencesSave, json) as Promise<void>,
  },

  memory: {
    sample: () => ipcRenderer.invoke(Ipc.memorySample) as Promise<import('../shared/ipc').ElectronMemoryIpcSnapshot>,
  },

  printers: {
    configuration: {
      load: () => ipcRenderer.invoke(Ipc.printerConfigurationLoad) as Promise<PrinterConfigurationDocument>,
      save: async (document: PrinterConfigurationDocument) => {
        // Validate at the renderer boundary as well as in main. This keeps
        // malformed IPC payloads from ever reaching the file handler.
        const normalized = normalizePrinterConfigurationDocument(document);
        await ipcRenderer.invoke(Ipc.printerConfigurationSave, normalized);
      },
    },
    transport: {
      request: (requestId: string, request: PrinterTransportIpcRequest) =>
        ipcRenderer.invoke(Ipc.printerTransportRequest, requestId, request) as Promise<PrinterTransportIpcResponse>,
      cancel: (requestId: string) =>
        ipcRenderer.invoke(Ipc.printerTransportCancel, requestId) as Promise<void>,
      onProgress: (listener: (requestId: string, progress: PrinterTransportProgress) => void) => {
        const handler = (_event: IpcRendererEvent, requestId: unknown, progress: unknown) => {
          if (typeof requestId !== 'string' || !progress || typeof progress !== 'object') return;
          const value = progress as { loaded?: unknown; total?: unknown };
          if (typeof value.loaded !== 'number' || !Number.isFinite(value.loaded) || value.loaded < 0) return;
          if (value.total !== undefined && (typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0)) return;
          listener(requestId, {
            loaded: value.loaded,
            ...(typeof value.total === 'number' ? { total: value.total } : {}),
          });
        };
        ipcRenderer.on(Ipc.printerTransportProgress, handler);
        return () => ipcRenderer.removeListener(Ipc.printerTransportProgress, handler);
      },
    },
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
