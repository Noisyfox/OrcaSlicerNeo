import type { OrcaModule } from './types';
import type { ProfileActivation } from './setupWizard';

type ArchiveFilesystem = Pick<OrcaModule['FS'], 'mkdir' | 'writeFile'>;
export function safeProfilePath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  if (!normalized || /[\x00-\x1f\x7f]/.test(normalized) || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) throw new Error(`unsafe profile path: ${path}`);
  const parts = normalized.split('/').filter(Boolean);
  if (parts.some(part => part === '.' || part === '..')) throw new Error(`unsafe profile path: ${path}`);
  return parts.join('/');
}
function mkdirParents(fs: ArchiveFilesystem, path: string): void {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`;
    try { fs.mkdir?.(current); } catch { /* already exists */ }
  }
}
/** Worker host setup. Runtime code supplies bytes, never touches FS directly. */
export function installProfileArchive(module: { FS: ArchiveFilesystem }, kind: 'core' | 'vendor',
  entries: Array<{ path: string; data: Uint8Array }>): void {
  const root = kind === 'core' ? '/system' : '/profiles';
  const validated = entries.map(entry => ({ ...entry, path: safeProfilePath(entry.path) }));
  mkdirParents(module.FS, root);
  for (const entry of validated) {
    const path = `${root}/${entry.path}`;
    mkdirParents(module.FS, path.slice(0, path.lastIndexOf('/')));
    module.FS.writeFile(path, entry.data);
  }
}

/** Rebuild the native view from explicit printer resource vendors only. */
export function linkProfileVendors(module: OrcaModule, activation: ProfileActivation | null): void {
  const fs = module.FS;
  mkdirParents(fs, '/system'); mkdirParents(fs, '/profiles');
  const vendors = new Set(['OrcaFilamentLibrary', ...(activation?.models.map(model => model.vendor) ?? [])]);
  for (const vendor of vendors) {
    if (safeProfilePath(vendor) !== vendor || /[/:]/.test(vendor) || !vendor.trim()) throw new Error('vendor must be a profile basename');
  }
  // The source roots identify managed links. Core entries are outside this set.
  for (const root of fs.readdir!('/profiles').filter(name => name.endsWith('.json'))) {
    const vendor = root.slice(0, -5);
    for (const suffix of ['.json', '']) {
      try { fs.unlink(`/system/${vendor}${suffix}`); } catch { /* not linked */ }
    }
  }
  for (const vendor of vendors) {
    try {
      fs.stat!(`/profiles/${vendor}.json`);
      const directory = fs.stat!(`/profiles/${vendor}`);
      if (!fs.isDir!(directory.mode)) throw new Error('vendor directory is missing');
    } catch (error) { console.warn(`[profiles] unavailable vendor ${vendor}; skipping links`, error); continue; }
    fs.symlink(`/profiles/${vendor}.json`, `/system/${vendor}.json`);
    fs.symlink(`/profiles/${vendor}`, `/system/${vendor}`);
  }
}
