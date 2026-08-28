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
} as const;

export const MENU_COMMAND_IDS = [
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
  preferences: {
    load(): Promise<PreferencesLoadResult>;
    save(json: unknown): Promise<void>;
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

/** Result for the small versioned shared preferences document. */
export interface PreferencesLoadResult {
  found: boolean;
  /** Parsed preferences JSON when found. */
  json: unknown;
}
