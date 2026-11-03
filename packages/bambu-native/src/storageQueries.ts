import { openStorageChannel, storageObject, storageInteger, invalidStorageReply, BambuStorageError,
  type StorageChannel, type BambuStorageReadOptions } from './storageChannel.js';
import type { BambuStorageFile } from './storageDownload.js';

export interface BambuStorageQueryOptions extends BambuStorageReadOptions { requestTimeoutMs: number }
export type BambuStorageCollection = 'model' | 'timelapse' | 'video';
export interface BambuStorageEntry { name: string; path: string; sizeBytes: number; modifiedAtSeconds: number | null }

async function query<T>(addonPath: string, sourcePath: string, url: string, command: number, request: Record<string, unknown>,
  options: BambuStorageQueryOptions, read: (channel: StorageChannel) => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1) throw invalidStorageReply();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.requestTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  let channel: StorageChannel | undefined;
  try {
    channel = await openStorageChannel(addonPath, sourcePath, url, command, request, { ...options, signal });
    return await read(channel);
  } catch (error) {
    if (timeout.signal.aborted && !options.signal?.aborted) throw new BambuStorageError('transport', 'The storage request timed out.');
    throw error;
  } finally { clearTimeout(timer); await channel?.close(); }
}

export function discoverBambuStorage(addonPath: string, sourcePath: string, url: string, options: BambuStorageQueryOptions): Promise<readonly string[]> {
  return query(addonPath, sourcePath, url, 7, { peer: 'studio', api_version: 2 }, options, async channel => {
    const { result, reply, body } = await channel.read();
    if (result !== 0 || body.byteLength || !Array.isArray(reply.storage) || reply.storage.length > 32 ||
      reply.storage.some(value => typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))) throw invalidStorageReply();
    return [...new Set(reply.storage as string[])];
  });
}

/** Bounded complete protocol listing; host paging and query-scoped cursors are separate. */
export function listBambuStorageFiles(addonPath: string, sourcePath: string, url: string,
  request: { storage: string; collection: BambuStorageCollection; maxEntries: number }, options: BambuStorageQueryOptions): Promise<readonly BambuStorageEntry[]> {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(request.storage) || !['model', 'timelapse', 'video'].includes(request.collection) ||
    !Number.isSafeInteger(request.maxEntries) || request.maxEntries < 1 || request.maxEntries > 50_000) throw invalidStorageReply();
  return query(addonPath, sourcePath, url, 1, { storage: request.storage, type: request.collection, api_version: 2 }, options, async channel => {
    const entries: BambuStorageEntry[] = [], identities = new Set<string>();
    let metadataBytes = 0;
    while (true) {
      const { result, reply, body } = await channel.read();
      if (body.byteLength || !Array.isArray(reply.file_lists) || entries.length + reply.file_lists.length > request.maxEntries ||
        result === 1 && reply.file_lists.length === 0) throw invalidStorageReply();
      for (const value of reply.file_lists) {
        if (!storageObject(value) || typeof value.name !== 'string' || !value.name || value.name.length > 4096 ||
          /[\x00-\x1f\\/]/.test(value.name) || !storageInteger(value.size) ||
          value.path !== undefined && (typeof value.path !== 'string' || value.path.length > 4096 || /[\x00-\x1f]/.test(value.path)) ||
          value.time !== undefined && (!storageInteger(value.time) || !Number.isSafeInteger(value.time * 1000))) throw invalidStorageReply();
        const path = typeof value.path === 'string' ? value.path : '';
        // Older firmware that returns timelapses regardless of requested type is not model/video support.
        if (request.collection !== 'timelapse' && !path || path.startsWith('mem:') || path.split(/[\\/]/).includes('..')) throw invalidStorageReply();
        metadataBytes += Buffer.byteLength(value.name) + Buffer.byteLength(path);
        if (metadataBytes > 16 * 1024 * 1024) throw invalidStorageReply();
        const identity = path || value.name;
        if (identities.has(identity)) throw invalidStorageReply();
        identities.add(identity);
        entries.push({ name: value.name, path, sizeBytes: value.size, modifiedAtSeconds: typeof value.time === 'number' && value.time > 0 ? value.time : null });
      }
      if (result === 0) return entries.sort((a, b) => (b.modifiedAtSeconds ?? 0) - (a.modifiedAtSeconds ?? 0) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    }
  });
}

/** Exactly one file per command; callers preserve transport/invalid-response as uncertain outcomes. */
export function deleteBambuStorageFile(addonPath: string, sourcePath: string, url: string,
  file: BambuStorageFile, options: BambuStorageQueryOptions): Promise<void> {
  const address = file.path ?? file.name;
  if (!address || address.length > 4096 || /[\x00-\x1f]/.test(address) || address.startsWith('mem:') || address.split(/[\\/]/).includes('..')) throw invalidStorageReply();
  const key = file.path !== undefined ? 'paths' : 'delete';
  return query(addonPath, sourcePath, url, 3, { [key]: [address] }, options, async channel => {
    const { result, reply, body } = await channel.read();
    if (result !== 0 || body.byteLength) throw invalidStorageReply();
    for (const echoed of ['paths', 'delete']) {
      if (reply[echoed] !== undefined && (echoed !== key || !Array.isArray(reply[echoed]) ||
        reply[echoed].length !== 1 || reply[echoed][0] !== address)) throw invalidStorageReply();
    }
  });
}
