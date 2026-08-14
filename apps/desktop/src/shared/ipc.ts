// apps/desktop/src/shared/ipc.ts
// ----------------------------------------------------------------
// IPC surface shared by main, preload, and renderer. Channel names
// must stay in sync across all three; the preload exposes these as
// window.orca.* (see src/preload/index.ts).
// ----------------------------------------------------------------

export const Ipc = {
  openFileDialog: 'dialog:openFile',
  saveFileDialog: 'dialog:saveFile',
  readFile: 'file:read',
  writeFile: 'file:write',
  appConfigLoad: 'appConfig:load',
  appConfigSave: 'appConfig:save',
  windowMinimize: 'window:minimize',
  windowToggleMaximize: 'window:toggleMaximize',
  windowClose: 'window:close',
} as const;

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

/** Load result for the persisted app config (M4 preset management). */
export interface AppConfigLoadResult {
  found: boolean;
  /** The parsed app-config JSON (fork's USE_JSON_CONFIG schema) when found. */
  json: unknown;
}
