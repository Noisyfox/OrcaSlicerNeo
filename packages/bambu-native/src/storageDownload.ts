import { createHash } from 'node:crypto';
import { openStorageChannel, invalidStorageReply, storageInteger, BambuStorageError, type BambuStorageReadOptions } from './storageChannel.js';

export type BambuStorageFile = { path: string; name?: never } | { name: string; path?: never };
export interface BambuStorageDownload {
  totalBytes: number;
  chunks: AsyncIterable<Uint8Array>;
}

/** Full-file reads only. Content identity is not version-checked; transfer length/MD5 are. */
export async function readBambuStorageFile(addonPath: string, sourcePath: string, privateUrl: string,
  file: BambuStorageFile, options: BambuStorageReadOptions): Promise<BambuStorageDownload> {
  const address = file.path ?? file.name;
  if (!address || address.length > 4096 || /[\x00-\x1f]/.test(address) || address.startsWith('mem:') ||
    address.split(/[\\/]/).includes('..')) throw new BambuStorageError('invalid-response', 'The storage file reference is invalid.');
  const channel = await openStorageChannel(addonPath, sourcePath, privateUrl, 4,
    file.path !== undefined ? { path: file.path } : { file: file.name }, options);
  let total: number | undefined, received = 0;
  const hash = createHash('md5');
  async function* read(): AsyncGenerator<Uint8Array, void> {
    try {
      while (true) {
        const { result, reply, body } = await channel.read();
        if (!storageInteger(reply.offset) || !storageInteger(reply.total) || !storageInteger(reply.size) ||
          reply.offset !== received || reply.size !== body.byteLength ||
          total !== undefined && reply.total !== total || received + body.byteLength > reply.total ||
          result === 1 && body.byteLength === 0) throw invalidStorageReply();
        total = reply.total;
        received += body.byteLength;
        hash.update(body);
        if (result === 0) {
          if (received !== total || typeof reply.file_md5 !== 'string' || !/^[a-f\d]{32}$/i.test(reply.file_md5) ||
            hash.digest('hex') !== reply.file_md5.toLowerCase()) throw invalidStorageReply();
          // Even the final packet is verified before any of its bytes are published.
          if (body.byteLength) yield body;
          return;
        }
        yield body;
      }
    } finally { await channel.close(); }
  }
  const iterator = read();
  // Prime the generator so return() owns cleanup even if the caller never starts iteration.
  let first: IteratorResult<Uint8Array, void> | undefined;
  try { first = await iterator.next(); } catch (error) { await channel.close(); throw error; }
  let claimed = false;
  return { totalBytes: total!, chunks: {
    [Symbol.asyncIterator]() {
      if (claimed) throw new BambuStorageError('invalid-response', 'The storage reader is already owned.');
      claimed = true;
      return {
        next: () => {
          if (options.signal?.aborted) { first = undefined; return iterator.throw(new BambuStorageError('cancelled', 'Storage reading was cancelled.')); }
          if (first) { const value = first; first = undefined; return Promise.resolve(value); } return iterator.next();
        },
        return: async () => { first = undefined; await channel.close(); return iterator.return(); },
        throw: async error => { first = undefined; await channel.close(); return iterator.throw(error); },
      };
    },
  } };
}
