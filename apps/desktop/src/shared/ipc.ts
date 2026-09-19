// apps/desktop/src/shared/ipc.ts
// ----------------------------------------------------------------
// IPC surface shared by main, preload, and renderer. Channel names
// must stay in sync across all three; the preload exposes these as
// window.orca.* (see src/preload/index.ts).
// ----------------------------------------------------------------

import type { MenuCommandId, MenuModel, MenuStateSnapshot } from '../../../../packages/platform-contract/src/menu';
import type { PrinterConfigurationDocument } from '../../../../packages/printer-control/src/configuration';
import type { PrinterTransportBody } from '../../../../packages/printer-control/src/transport';

export type { MenuCommandId, MenuModel, MenuStateSnapshot } from '../../../../packages/platform-contract/src/menu';

export const Ipc = {
  openFileDialog: 'dialog:openFile',
  saveFileDialog: 'dialog:saveFile',
  readFile: 'file:read',
  writeFile: 'file:write',
  projectOpen: 'project:open',
  projectOpenDropped: 'project:openDropped',
  projectSave: 'project:save',
  projectSaveAs: 'project:saveAs',
  preferencesLoad: 'preferences:load',
  preferencesSave: 'preferences:save',
  printerConfigurationLoad: 'printerConfiguration:load',
  printerConfigurationSave: 'printerConfiguration:save',
  printerTransportRequest: 'printerTransport:request',
  printerTransportCancel: 'printerTransport:cancel',
  printerTransportProgress: 'printerTransport:progress',
  syncMenuModel: 'menu:syncModel',
  syncMenuState: 'menu:syncState',
  nativeMenuCommand: 'menu:command',
  executeHostCommand: 'host:executeCommand',
  openSource: 'external:openSource',
  windowCloseRequest: 'window:closeRequest',
  windowCloseDecision: 'window:closeDecision',
  memorySample: 'memory:sample',
} as const;

export const MENU_COMMAND_IDS = [
  'new-project',
  'open-project',
  'save-project',
  'save-project-as',
  'preferences',
  'add-model',
  'clear-scene',
  'slice',
  'export-gcode',
  'quit',
  'open-source',
] as const satisfies readonly MenuCommandId[];

export function isMenuCommandId(value: unknown): value is MenuCommandId {
  return typeof value === 'string' && (MENU_COMMAND_IDS as readonly string[]).includes(value);
}

export type HostCommandId = 'quit';

export interface ElectronBridge {
  version: string;
  openFileDialog(filters: FileDialogFilter[]): Promise<OpenFileResult>;
  saveFileDialog(defaultName: string, filters: FileDialogFilter[]): Promise<SaveFileResult>;
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, bytes: ArrayBuffer): Promise<void>;
  projects: {
    /** Resolve an OS-dropped File in the renderer without exposing its path to shared code. */
    getPathForFile(file: File): string;
    open(): Promise<ProjectOpenIpcResult>;
    openMany(): Promise<ProjectOpenIpcResult>;
    openDropped(paths: string[]): Promise<ProjectOpenIpcResult>;
    save(locationToken: string | null, defaultName: string, bytes: ArrayBuffer): Promise<ProjectSaveIpcResult>;
    saveAs(defaultName: string, bytes: ArrayBuffer): Promise<ProjectSaveIpcResult>;
  };
  lifecycle: {
    onCloseRequest(listener: () => void | Promise<void>): () => void;
    respondClose(allow: boolean): Promise<void>;
  };
  preferences: {
    load(): Promise<PreferencesLoadResult>;
    save(json: unknown): Promise<void>;
  };
  memory: {
    sample(): Promise<ElectronMemoryIpcSnapshot>;
  };
  printers: {
    configuration: {
      load(): Promise<PrinterConfigurationDocument>;
      save(document: PrinterConfigurationDocument): Promise<void>;
    };
    transport: {
      request(requestId: string, request: PrinterTransportIpcRequest): Promise<PrinterTransportIpcResponse>;
      cancel(requestId: string): Promise<void>;
      onProgress(listener: (requestId: string, progress: PrinterTransportProgress) => void): () => void;
    };
  };
  menu: {
    syncModel(model: MenuModel): void;
    syncState(snapshot: MenuStateSnapshot): void;
    onCommand(listener: (command: MenuCommandId) => void): () => void;
    executeHostCommand(command: HostCommandId): Promise<void>;
  };
  externalLinks: {
    openSource(): Promise<void>;
  };
  platform: string;
}

/** IPC request types intentionally exclude signal and callback properties. */
export interface PrinterTransportIpcRequest {
  method: 'GET' | 'POST';
  url: string;
  headers?: Readonly<Record<string, string>>;
  body?: PrinterTransportBody;
}

export interface PrinterTransportIpcResponse {
  status: number;
  json?: unknown;
  jsonError?: boolean;
}

export interface PrinterTransportProgress {
  loaded: number;
  total?: number;
}

/** The only external URL that the Electron main process may open. */
export const SOURCE_URL = 'https://github.com/Noisyfox/OrcaSlicerNeo';

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenFileResult {
  canceled: boolean;
  path: string | null;
}

export interface SaveFileResult {
  canceled: boolean;
  path: string | null;
}

/** Project IPC carries bytes and an opaque host token, never a filesystem path. */
export interface ProjectOpenIpcResult {
  canceled: boolean;
  locationToken: string | null;
  displayName: string | null;
  bytes: ArrayBuffer | null;
  files?: ProjectOpenIpcFile[];
}

export interface ProjectOpenIpcFile {
  locationToken: string;
  displayName: string;
  bytes: ArrayBuffer;
}

export interface ProjectSaveIpcResult {
  canceled: boolean;
  locationToken: string | null;
}

/** Result for the small versioned shared preferences document. */
export interface PreferencesLoadResult {
  found: boolean;
  /** Parsed preferences JSON when found. */
  json: unknown;
}

/** Generic, validated payload returned by Electron's read-only memory IPC. */
export interface ElectronMemoryIpcSnapshot {
  totalBytes: number;
  entries: Array<{ id: string; label: string; bytes: number }>;
}
