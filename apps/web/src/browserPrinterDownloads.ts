import { u1DownloadChunkBytes, unavailablePrinterDownloads } from '@orca/printer-control';
import type * as D from '@orca/platform-contract';
import { executeDownload } from '@orca/printer-control/downloads';
import { ManagedDownloadTasks } from '@orca/printer-control/download-tasks';
import { TransferQueue } from '@orca/printer-control/transfer-queue';

type FilePickers = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (options: { mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
};
const ok = <T>(value: T): D.Result<T> => ({ ok: true, value });
const fail = (code: D.ErrorCode, message: string): D.Result<never> => ({ ok: false, error: { code, message } });
const isCancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';
function safeName(name: string) {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) || 'printer-file';
}

async function newFile(directory: FileSystemDirectoryHandle, name: string) {
  const dot = name.lastIndexOf('.');
  for (let i = 0; i < 1000; i++) {
    const candidate = i === 0 ? name : dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    try { await directory.getFileHandle(candidate); }
    catch (error) {
      if (error instanceof DOMException && error.name === 'TypeMismatchError') continue;
      if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      return directory.getFileHandle(candidate, { create: true });
    }
  }
  throw new Error('No free download filename.');
}

export function createBrowserPrinterDownloads(read: D.PrinterFiles['download']): D.PrinterDownloads {
  const pickers: FilePickers = window;
  if (typeof pickers.showSaveFilePicker !== 'function' || typeof pickers.showDirectoryPicker !== 'function')
    return unavailablePrinterDownloads('This browser does not support saving printer files directly to disk.');
  const listeners = new Set<() => void>();
  // Serialize writes so parallel batches cannot reserve the same local filename.
  const tasks = new ManagedDownloadTasks<FileSystemFileHandle>(new TransferQueue(1), () => crypto.randomUUID(), () => {
    for (const listener of listeners) { try { listener(); } catch { /* Observers do not own execution. */ } }
  });
  let directory: FileSystemDirectoryHandle | undefined;
  let pendingDirectory: { id: D.DownloadDirectorySelectionId; handle: FileSystemDirectoryHandle } | undefined;
  const pickDirectory = () => pickers.showDirectoryPicker!({ mode: 'readwrite' });
  window.addEventListener('pagehide', event => { if (!event.persisted) void tasks.close(); });
  return {
    capability: { kind: 'supported', constraints: {} },
    async start(request) {
      const { files, destination } = structuredClone(request);
      if (!files.length || files.length > 500) return fail('invalid-request', 'Select between 1 and 500 files.');
      try {
        const folder = destination === 'default' ? directory : undefined;
        const chosenFile = !folder && files.length === 1 ? await pickers.showSaveFilePicker!({ suggestedName: safeName(files[0].name) }) : undefined;
        const chosenFolder = chosenFile ? undefined : folder ?? await pickDirectory();
        return ok({ status: 'queued', ...tasks.enqueue(files.map(selection => ({
          ...selection, physicalPrinterKey: selection.file.printerId,
          execute: (signal, progress) => executeDownload(selection.file, {
            read, maxChunkBytes: u1DownloadChunkBytes,
            async createSink(metadata) {
              const handle = chosenFile ?? await newFile(chosenFolder!, safeName(metadata.suggestedFileName));
              let writer: FileSystemWritableFileStream;
              try { writer = await handle.createWritable(); }
              catch (error) {
                if (chosenFolder) await chosenFolder.removeEntry(handle.name);
                throw error;
              }
              return {
                write: chunk => writer.write(new Uint8Array(chunk)),
                async publish() { await writer.close(); return handle; },
                async discard() {
                  try { await writer.abort(); }
                  finally { if (chosenFolder) await chosenFolder.removeEntry(handle.name); }
                },
              };
            },
          }, { signal, progress }),
        }))) });
      } catch (error) {
        return isCancelled(error) ? ok({ status: 'cancelled' }) : fail('device-failed', 'Could not queue the download. Check the browser save permission.');
      }
    },
    async list() { return ok(tasks.list()); },
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async cancel(id) { return tasks.cancel(id) ? ok(null) : fail('invalid-request', 'This task cannot be cancelled.'); },
    async retry(id) { return tasks.retry(id) ? ok(null) : fail('invalid-request', 'This task cannot be retried.'); },
    async continue(id) { return tasks.continue(id) ? ok(null) : fail('invalid-request', 'This task is not paused.'); },
    async open(id) {
      const handle = tasks.saved(id);
      if (!handle) return fail('invalid-request', 'No completed download is available.');
      const tab = window.open('about:blank', '_blank');
      if (!tab) return fail('permission-denied', 'The browser blocked opening the saved file.');
      tab.opener = null;
      try {
        const file = await handle.getFile();
        const type = /\.mp4$/i.test(file.name) ? 'video/mp4' : 'text/plain';
        const url = URL.createObjectURL(new Blob([file], { type }));
        tab.location.replace(url);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return ok(null);
      } catch { tab.close(); return fail('device-failed', 'Could not open the saved file.'); }
    },
    async directory() { return ok({ label: directory?.name ?? 'Choose when downloading' }); },
    async chooseDirectory() {
      try {
        const handle = await pickDirectory(), id = crypto.randomUUID() as D.DownloadDirectorySelectionId;
        pendingDirectory = { id, handle };
        return ok({ status: 'selected', label: handle.name, id });
      } catch (error) { return isCancelled(error) ? ok({ status: 'cancelled' }) : fail('permission-denied', 'Could not choose the download folder.'); }
    },
    async saveDirectory(id) {
      if (pendingDirectory?.id !== id) return fail('invalid-request', 'The folder selection is no longer available.');
      directory = pendingDirectory.handle; pendingDirectory = undefined;
      return ok(null);
    },
  };
}
