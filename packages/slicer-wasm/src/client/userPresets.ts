/** Host storage contains Orca JSON files only; snapshots belong to the session. */
export interface UserPresetFile { path: string; content: string }
export interface UserPresetWrite { path: string; content: string | null }
export interface UserPresetStorage {
  load(): Promise<UserPresetFile[]>;
  write(change: UserPresetWrite): Promise<void>;
}

export type UserPresetKind = 'printer' | 'filament' | 'print';
export interface UserPresetInfo {
  ok: true;
  kind: UserPresetKind;
  canonicalName: string;
  label: string;
  defaultSaveAsName: string;
  overwriteName: string | null;
  compatible: boolean;
  canSave: boolean;
  canDelete: boolean;
  canReset: boolean;
  deleted: boolean;
  revision: number;
}
export type UserPresetRequest = {
  kind: UserPresetKind;
  canonicalName: string;
  expectedRevision: number;
} & ({ action: 'save' | 'delete' } | { action: 'save-as'; name: string; confirmOverwrite?: boolean });
export interface UserPresetMutation {
  ok: true;
  kind: UserPresetKind;
  canonicalName: string;
  historyEntryDelta: 0 | 1;
  profileSnapshot: import('./types').ProfileSnapshot;
  filamentSession: import('./types').FilamentSessionSnapshot;
  plateSession: import('./types').PlateSessionMutation;
  nativeScopedConfig: import('./types').NativeScopedConfigFullTransport;
  historyStatus: import('./history').HistoryStatus;
}
export interface UserPresetMethods {
  getUserPresetInfo(kind: UserPresetKind, canonicalName: string): Promise<UserPresetInfo | import('./types').PresetDraftError>;
  mutateUserPreset(request: UserPresetRequest): Promise<UserPresetMutation | import('./types').PresetDraftError>;
}

export async function installUserPresets(module: import('./types').OrcaModule, storage: UserPresetStorage): Promise<void> {
  const files = await storage.load();
  for (const file of files) validateUserPresetPath(file.path);
  for (const path of ['/user', '/user/default', ...['machine', 'filament', 'process'].flatMap(kind => [`/user/default/${kind}`, `/user/default/${kind}/base`])]) {
    try { module.FS.mkdir?.(path); } catch { /* native setup also creates these directories */ }
  }
  for (const file of files) module.FS.writeFile(`/user/default/${file.path}`, new TextEncoder().encode(file.content));
}

/** Identical portable filenames on both hosts, independent of the native path. */
export function validateUserPresetPath(path: string): void {
  if (!/^(machine|filament|process)\/(?:base\/)?[^/\\\x00-\x1f<>:"|?*]+\.json$/.test(path))
    throw new Error('Invalid user preset path');
  const name = path.slice(path.lastIndexOf('/') + 1, -5);
  if (!name || name !== name.trim() || name.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
    throw new Error('Invalid user preset filename');
}
