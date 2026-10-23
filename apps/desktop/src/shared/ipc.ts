// apps/desktop/src/shared/ipc.ts
// ----------------------------------------------------------------
// IPC surface shared by main, preload, and renderer. Channel names
// must stay in sync across all three; the preload exposes these as
// window.orca.* (see src/preload/index.ts).
// ----------------------------------------------------------------

import type { MenuCommandId, MenuModel, MenuStateSnapshot } from '../../../../packages/platform-contract/src/menu';
import { isRecentProjectMenuCommand } from '../../../../packages/platform-contract/src/menu';
import type { PrinterConfigurationDocument } from '../../../../packages/printer-control/src/configuration';
import type { PrinterTransportBody } from '../../../../packages/printer-control/src/transport';

export type { MenuCommandId, MenuModel, MenuStateSnapshot } from '../../../../packages/platform-contract/src/menu';

export const Ipc = {
  slicerConnect: 'slicer:connect',
  slicerPort: 'slicer:port',
  slicerFailed: 'slicer:failed',
  openFileDialog: 'dialog:openFile',
  saveFileDialog: 'dialog:saveFile',
  readFile: 'file:read',
  writeFile: 'file:write',
  projectOpen: 'project:open',
  projectOpenDropped: 'project:openDropped',
  projectSave: 'project:save',
  projectSaveAs: 'project:saveAs',
  recentList: 'recent:list',
  recentThumbnail: 'recent:thumbnail',
  recentOpen: 'recent:open',
  recentRecord: 'recent:record',
  recentRemove: 'recent:remove',
  recentClear: 'recent:clear',
  recentReveal: 'recent:reveal',
  preferencesLoad: 'preferences:load',
  preferencesSave: 'preferences:save',
  bambuRead: 'bambu:read',
  bambuCommand: 'bambu:command',
  bambuChanged: 'bambu:changed',
  printerConfigurationLoad: 'printerConfiguration:load',
  printerConfigurationSave: 'printerConfiguration:save',
  printerConfigurationChanged: 'printerConfiguration:changed',
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
  'setup-wizard',
  'add-model',
  'clear-scene',
  'slice',
  'export-gcode',
  'quit',
  'open-source',
  'open-configuration-folder',
  'open-file-manager',
] as const satisfies readonly MenuCommandId[];

export function isMenuCommandId(value: unknown): value is MenuCommandId {
  return typeof value === 'string' && ((MENU_COMMAND_IDS as readonly string[]).includes(value) || isRecentProjectMenuCommand(value));
}

export type HostCommandId = 'quit' | 'open-configuration-folder';

export interface ElectronBridge {
  bambu: import('./bambu').BambuBridge;
  connectSlicerRuntime(): void;
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
  recentProjects: {
    list(): Promise<import('../../../../packages/platform-contract/src/contracts').RecentProject[]>;
    thumbnail(id: string): Promise<string | null>;
    open(id: string): Promise<ProjectOpenIpcResult>;
    record(locationToken: string): Promise<void>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    reveal(id: string): Promise<void>;
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
      onChanged(listener: () => void): () => void;
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
  displayName: string | null;
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
