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
