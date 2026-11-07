import { basename, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DownloadDirectorySelectionId } from '@orca/printer-control/domain';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { app, dialog, shell, type BrowserWindow } from 'electron';
import { writeFileAtomically } from './atomicFile';
import { withFileLock } from './fileLock';
import type { DownloadHost } from './printerDownloads';
export function downloadDestinationHost(configurationDirectory: string, window: () => BrowserWindow | null): DownloadHost {
  const settings = join(configurationDirectory, 'download-directory.json');
  // Only the latest picker selection is retained; saving resolves its opaque ID.
  let selection: { id: DownloadDirectorySelectionId; path: string } | null = null;
  const directory = async () => {
    try {
      const value = JSON.parse(await readFile(settings, 'utf8'));
      if (typeof value.directory === 'string' && isAbsolute(value.directory) && !value.directory.includes('\0')) return value.directory as string;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return app.getPath('downloads');
  };
  const chooseFolder = async () => {
    const owner = window(); if (!owner) return null;
    const result = await dialog.showOpenDialog(owner, { title: 'Download folder', defaultPath: await directory(), properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  };
  return {
    directory: async () => ({ label: await directory() }),
    chooseDirectory: async () => {
      const selected = await chooseFolder(); if (!selected) return { status: 'cancelled' };
      selection = { id: randomUUID() as DownloadDirectorySelectionId, path: selected };
      return { status: 'selected', label: selected, id: selection.id };
    },
    saveDirectory: async id => {
      if (!selection || selection.id !== id) throw new Error('The download folder selection is no longer available.');
      const selected = selection.path;
      await mkdir(configurationDirectory, { recursive: true });
      await withFileLock(settings, () => writeFileAtomically(settings, new TextEncoder().encode(JSON.stringify({ directory: selected }))));
      return null;
    },
    destination: async (files, choose) => {
      if (!choose) return { kind: 'directory', directory: await directory() };
      if (files.length > 1) { const path = await chooseFolder(); return path ? { kind: 'directory', directory: path } : null; }
      const owner = window(); if (!owner) return null;
      // Display names are not trusted filesystem paths, even though this is a native dialog.
      const name = files[0].name.replace(/[/\\\x00-\x1f<>:"|?*]/g, '_');
      const result = await dialog.showSaveDialog(owner, { title: 'Save printer file', defaultPath: join(await directory(), name), properties: ['showOverwriteConfirmation', 'createDirectory'] });
      if (result.canceled || !result.filePath) return null;
      let exists = false;
      try { await stat(result.filePath); exists = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // An explicit app confirmation also covers platforms whose native dialog omits overwrite prompts.
      if (exists && (await dialog.showMessageBox(owner, { type: 'question', message: `Replace ${basename(result.filePath)}?`, detail: 'The existing file is replaced only after the complete download succeeds.', buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0 })).response !== 1) return null;
      return { kind: 'file', path: result.filePath, overwriteConfirmed: exists };
    },
    open: async path => { if (await shell.openPath(path)) throw new Error('Could not open saved file.'); },
  };
}
