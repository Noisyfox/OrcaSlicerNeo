/** Utility-host filesystem binding. Paths and the recovery journal never cross into agents/UI. */
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { link, mkdir, open, readFile, readdir, rename, unlink, rmdir, lstat, writeFile, type FileHandle } from 'node:fs/promises';
import type { DownloadSink } from '@orca/platform-contract';

export type DownloadDestination = { kind: 'directory'; directory: string; fileName: string }
  | { kind: 'file'; path: string; overwriteConfirmed: boolean };
export interface SavedDownloadFile {
  path: string;
  fileName: string;
  /** Publication succeeded, but an owned temporary file/journal still needs cleanup. */
  cleanupPending: boolean;
}
interface JournalEntry { id: string; temporary: string }
const validId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const temporaryName = (id: string) => `.orca-download-${id}.part`;
function code(error: unknown): string | undefined { return (error as NodeJS.ErrnoException | null)?.code; }
function publicError(message: string, error?: unknown): Error {
  const reason = code(error);
  return Object.assign(new Error(message), { detail: {
    code: reason === 'ENOSPC' || reason === 'EDQUOT' ? 'storage-unavailable'
      : reason === 'EACCES' || reason === 'EPERM' ? 'permission-denied' : 'device-failed', message,
  } });
}
function validateName(name: string): void {
  if (!name || name === '.' || name === '..' || /[/\\\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw publicError('The download filename is not supported.');
}
function numbered(name: string, index: number): string {
  if (index === 0) return name;
  const dot = name.indexOf('.', 1);
  return dot < 0 ? `${name} (${index})` : `${name.slice(0, dot)} (${index})${name.slice(dot)}`;
}
async function remove(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
}

/**
 * Called only by a trusted host after destination selection. The journal directory
 * is app-owned. Recover it at cold startup, after old utility processes have exited
 * and before new downloads start; never scavenge another live executor's files.
 */
export async function createDownloadFileSink(destination: DownloadDestination, journalDirectory: string): Promise<DownloadSink<SavedDownloadFile>> {
  const target = destination.kind === 'directory'
    ? join(resolve(destination.directory), destination.fileName) : resolve(destination.path);
  validateName(destination.kind === 'directory' ? destination.fileName : basename(target));
  const folder = dirname(target), id = randomUUID();
  const temporary = join(folder, temporaryName(id)), journal = join(journalDirectory, `${id}.json`);
  let handle: FileHandle | undefined;
  let created = false, journalCreated = false, published: SavedDownloadFile | undefined, discarded = false;
  let writing: Promise<void> | undefined;
  const close = async () => { if (handle) { await handle.close(); handle = undefined; } };
  try {
    await mkdir(folder, { recursive: true });
    await mkdir(journalDirectory, { recursive: true, mode: 0o700 });
    // Record ownership before creating output, so a crash cannot strand an untracked file.
    const record = await open(journal, 'wx', 0o600); journalCreated = true;
    try { await record.writeFile(JSON.stringify({ id, temporary } satisfies JournalEntry)); await record.sync(); }
    finally { await record.close(); }
    handle = await open(temporary, 'wx', 0o600); created = true;
  } catch (error) {
    await close();
    if (created) await remove(temporary);
    if (journalCreated) await remove(journal);
    throw publicError('Could not create the download destination.', error);
  }
  return {
    async write(chunk) {
      if (!handle || discarded || published || writing) throw publicError('The download destination is not writable.');
      const file = handle;
      writing = (async () => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
          if (bytesWritten <= 0) throw publicError('The download destination made no write progress.');
          offset += bytesWritten;
        }
      })();
      try { await writing; }
      catch (error) { throw publicError('Could not write the download. Check available disk space and access.', error); }
      finally { writing = undefined; }
    },
    async publish() {
      if (published) return published;
      if (discarded || writing || !handle) throw publicError('The download is not ready to save.');
      try {
        await handle.sync(); await close();
        let path = target;
        if (destination.kind === 'file' && destination.overwriteConfirmed) {
          await rename(temporary, target);
        } else {
          // Linking publishes a complete file atomically and cannot replace an existing
          // file. A filesystem without hard links fails explicitly, never falls back to
          // a visible partial copy or a racy check-then-overwrite rename.
          for (let index = 0; ; index++) {
            path = join(folder, numbered(basename(target), index));
            try { await link(temporary, path); break; }
            catch (error) {
              if (code(error) !== 'EEXIST') throw error;
              if (destination.kind === 'file') throw publicError('A file appeared at the selected destination. Choose another name or confirm replacement.');
            }
          }
        }
        published = { path, fileName: basename(path), cleanupPending: false };
      } catch (error) {
        if (error instanceof Error && 'detail' in error) throw error;
        throw publicError('Could not publish the completed download.', error);
      }
      // After the commit point, cleanup failure must not make a saved file look unsaved.
      try { await remove(temporary); await remove(journal); }
      catch { published.cleanupPending = true; }
      return published;
    },
    async discard() {
      if (writing) await writing.catch(() => undefined);
      await close();
      await remove(temporary); await remove(journal);
      discarded = true;
      if (published) published.cleanupPending = false;
    },
  };
}

export interface DownloadRecovery { cleaned: number; failed: number; ignored: number }
/** Cold-start recovery only; invalid records are reported and never used as unlink instructions. */
export async function recoverInterruptedDownloads(journalDirectory: string): Promise<DownloadRecovery> {
  const result: DownloadRecovery = { cleaned: 0, failed: 0, ignored: 0 };
  let names: string[];
  try { names = await readdir(journalDirectory); }
  catch (error) { if (code(error) === 'ENOENT') return result; throw publicError('Could not inspect interrupted downloads.', error); }
  for (const name of names) {
    const id = name.slice(0, -5);
    if (!name.endsWith('.json') || !validId.test(id)) { result.ignored++; continue; }
    const journal = join(journalDirectory, name);
    try {
      const metadata = await lstat(journal);
      if (!metadata.isFile() || metadata.size > 32768) { result.ignored++; continue; }
      const value: unknown = JSON.parse(await readFile(journal, 'utf8'));
      if (!value || typeof value !== 'object' || !('id' in value) || value.id !== id ||
        !('temporary' in value) || typeof value.temporary !== 'string' || !isAbsolute(value.temporary) ||
        basename(value.temporary) !== temporaryName(id)) { result.ignored++; continue; }
      await remove(value.temporary); await remove(journal); result.cleaned++;
    } catch { result.failed++; }
  }
  return result;
}

export interface DownloadJournal {
  directory: string;
  recovery: DownloadRecovery;
  /** Remove an empty owned session; retain records after failed cleanup for a later startup. */
  close(): Promise<void>;
}
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return code(error) !== 'ESRCH'; } // Permission/unknown errors must never authorize scavenging.
}
/** Other app instances may share userData. Scavenge only when both recorded owners are gone. */
export async function openDownloadJournal(root: string, parentPid: number, alive: (pid: number) => boolean = processAlive): Promise<DownloadJournal> {
  if (!isAbsolute(root) || !Number.isSafeInteger(parentPid) || parentPid < 1) throw publicError('Invalid download journal configuration.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const recovery: DownloadRecovery = { cleaned: 0, failed: 0, ignored: 0 };
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !validId.test(entry.name)) { recovery.ignored++; continue; }
    const folder = join(root, entry.name), ownerPath = join(folder, 'owner.json');
    try {
      const metadata = await lstat(ownerPath);
      if (!metadata.isFile() || metadata.size > 4096) { recovery.ignored++; continue; }
      const owner: unknown = JSON.parse(await readFile(ownerPath, 'utf8'));
      if (!owner || typeof owner !== 'object' || !('parentPid' in owner) || !('workerPid' in owner) ||
        !Number.isSafeInteger(owner.parentPid) || Number(owner.parentPid) < 1 || !Number.isSafeInteger(owner.workerPid) || Number(owner.workerPid) < 1) {
        recovery.ignored++; continue;
      }
      if (alive(Number(owner.parentPid)) || alive(Number(owner.workerPid))) continue;
      const records = join(folder, 'records'), result = await recoverInterruptedDownloads(records);
      recovery.cleaned += result.cleaned; recovery.failed += result.failed; recovery.ignored += result.ignored;
      if (!result.failed && !result.ignored) {
        try { await rmdir(records); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
        await remove(ownerPath); await rmdir(folder);
      }
    } catch { recovery.failed++; }
  }
  const folder = join(root, randomUUID()), directory = join(folder, 'records');
  await mkdir(folder, { mode: 0o700 });
  await writeFile(join(folder, 'owner.json'), JSON.stringify({ parentPid, workerPid: process.pid }), { flag: 'wx', mode: 0o600 });
  await mkdir(directory, { mode: 0o700 });
  return { directory, recovery, close: async () => {
    // rmdir cannot remove live/failed task records. Never recursively delete an owned session.
    try { await rmdir(directory); }
    catch (error) { if (code(error) === 'ENOTEMPTY' || code(error) === 'EEXIST') return; if (code(error) !== 'ENOENT') throw error; }
    await remove(join(folder, 'owner.json'));
    try { await rmdir(folder); } catch (error) { if (code(error) !== 'ENOENT') throw error; }
  } };
}
