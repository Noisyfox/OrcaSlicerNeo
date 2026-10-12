/** Host storage contains Orca JSON files only; snapshots belong to the session. */
export interface UserPresetFile { path: string; content: string }
export interface UserPresetWrite { path: string; content: string | null }
export interface UserPresetStorage {
  load(): Promise<UserPresetFile[]>;
  write(change: UserPresetWrite): Promise<void>;
}

/** Identical portable filenames on both hosts, independent of the native path. */
export function validateUserPresetPath(path: string): void {
  if (!/^(machine|filament|process)\/[^/\\\x00-\x1f<>:"|?*]+\.json$/.test(path))
    throw new Error('Invalid user preset path');
  const name = path.slice(path.indexOf('/') + 1, -5);
  if (!name || name !== name.trim() || name.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name))
    throw new Error('Invalid user preset filename');
}
