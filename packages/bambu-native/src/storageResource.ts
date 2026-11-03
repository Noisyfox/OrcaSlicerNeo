/** Small optional resources; full-file downloads retain their separate streaming contract. */
import { openStorageChannel, storageInteger, invalidStorageReply, type BambuStorageReadOptions } from './storageChannel.js';
export interface BambuStorageResourceRequest { path: string; resource: string; maxBytes: number }
export async function readBambuStorageResource(addonPath: string, sourcePath: string, privateUrl: string,
  request: BambuStorageResourceRequest, options: BambuStorageReadOptions): Promise<Uint8Array | null> {
  const { path, resource, maxBytes } = request;
  if (!path || path.startsWith('mem:') || /[\x00-\x1f#]/.test(path) || path.split(/[\\/]/).includes('..') ||
    !resource || /[\x00-\x1f#\\]/.test(resource) || resource.startsWith('/') || resource.split('/').some(part => !part || part === '..') ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw invalidStorageReply();
  const requested = `${path}#${resource}`;
  const channel = await openStorageChannel(addonPath, sourcePath, privateUrl, 2, { paths: [requested] }, options);
  const chunks: Uint8Array[] = []; let size = 0, total: number | undefined;
  try {
    for (;;) {
      const { result, reply, body } = await channel.read();
      if (reply.path !== requested || !storageInteger(reply.size) || reply.size !== body.byteLength ||
        reply.offset !== undefined && reply.offset !== size || reply.continue !== undefined && typeof reply.continue !== 'boolean' ||
        reply.total !== undefined && (!storageInteger(reply.total) || total !== undefined && total !== reply.total)) throw invalidStorageReply();
      if (reply.total !== undefined) total = Number(reply.total);
      if (size + body.byteLength > maxBytes || total !== undefined && (total > maxBytes || size + body.byteLength > total) || chunks.length >= 4096) throw invalidStorageReply();
      size += body.byteLength; chunks.push(new Uint8Array(body));
      if (result === 0) {
        if (reply.continue === true || total !== undefined && size !== total) throw invalidStorageReply();
        return size ? new Uint8Array(Buffer.concat(chunks, size)) : null;
      }
      if (!body.byteLength || reply.continue === false) throw invalidStorageReply();
    }
  } finally { await channel.close(); }
}
