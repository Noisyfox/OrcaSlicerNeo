/** Optional SUB_FILE batches with caller-selected size budgets. No full-file fallback or archive extraction. */
import { openStorageChannel, storageInteger, invalidStorageReply, type BambuStorageReadOptions, type StorageChannel } from './storageChannel.js';
export interface BambuStorageResourceRequest {
  path: string; resource: string;
  /** null delegates resource size to the consumer/parser without an application budget. */
  maxBytes: number | null;
}
export interface BambuStorageResourceReader { read(requests: readonly BambuStorageResourceRequest[]): Promise<readonly (Uint8Array | null)[]>; close(): Promise<void> }
export async function openBambuStorageResourceReader(addonPath: string, sourcePath: string, privateUrl: string,
  options: BambuStorageReadOptions): Promise<BambuStorageResourceReader> {
  const channel = await openStorageChannel(addonPath, sourcePath, privateUrl, 2, undefined, options);
  return { read: requests => readBatch(channel, requests), close: () => channel.close() };
}
function resourceStates(requests: readonly BambuStorageResourceRequest[]) {
  if (!requests.length || requests.length > 8) throw invalidStorageReply();
  const states = requests.map(({ path, resource, maxBytes }) => {
    if (!path || path.startsWith('mem:') || /[\x00-\x1f#]/.test(path) || path.split(/[\\/]/).includes('..') ||
      !resource || /[\x00-\x1f#\\]/.test(resource) || resource.startsWith('/') || resource.split('/').some(part => !part || part === '..') ||
      maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw invalidStorageReply();
    return { requested: `${path}#${resource}`, maxBytes, chunks: [] as Uint8Array[], size: 0, total: undefined as number | undefined, done: false };
  });
  const paths = states.map(state => state.requested);
  if (new Set(paths).size !== paths.length) throw invalidStorageReply();
  return states;
}
async function readBatch(channel: StorageChannel, requests: readonly BambuStorageResourceRequest[]): Promise<readonly (Uint8Array | null)[]> {
  const states = resourceStates(requests);
  channel.send(2, { paths: states.map(state => state.requested) });
  const bounded = requests.every(request => request.maxBytes !== null);
  let bytes = 0, packets = 0;
  try {
    for (;;) {
      const { result, reply, body } = await channel.read();
      const state = states.find(state => state.requested === reply.path);
      if (result > 1) {
        // A per-file error terminates the command on H2D. Preserve completed
        // entries, keep this file optional, and request only untouched entries.
        if (!state || state.done || body.byteLength || reply.size !== 0) throw invalidStorageReply();
        state.done = true; state.size = 0; state.chunks = [];
        const remaining = states.filter(state => !state.done);
        if (remaining.some(state => state.size !== 0)) throw invalidStorageReply();
        if (!remaining.length) return states.map(state => state.size ? new Uint8Array(Buffer.concat(state.chunks, state.size)) : null);
        channel.send(2, { paths: remaining.map(state => state.requested) }); continue;
      }
      if (!state || state.done || !storageInteger(reply.size) || reply.size !== body.byteLength ||
        reply.offset !== undefined && reply.offset !== state.size || reply.continue !== undefined && typeof reply.continue !== 'boolean' ||
        reply.total !== undefined && (!storageInteger(reply.total) || state.total !== undefined && state.total !== reply.total)) throw invalidStorageReply();
      if (reply.total !== undefined) state.total = Number(reply.total);
      if (state.maxBytes !== null && (state.size + body.byteLength > state.maxBytes || state.total !== undefined && state.total > state.maxBytes) ||
        state.total !== undefined && state.size + body.byteLength > state.total ||
        bounded && ((bytes += body.byteLength) > 16 * 1024 * 1024 || ++packets > 4096)) throw invalidStorageReply();
      state.size += body.byteLength; state.chunks.push(new Uint8Array(body));
      if (reply.continue !== true) {
        if (state.total !== undefined && state.size !== state.total) throw invalidStorageReply();
        state.done = true;
      } else if (!body.byteLength) throw invalidStorageReply();
      if (result === 0) {
        if (states.some(state => !state.done)) throw invalidStorageReply();
        return states.map(state => state.size ? new Uint8Array(Buffer.concat(state.chunks, state.size)) : null);
      }
    }
  } catch (error) { await channel.close(); throw error; }
}
export async function readBambuStorageResources(addonPath: string, sourcePath: string, privateUrl: string,
  requests: readonly BambuStorageResourceRequest[], options: BambuStorageReadOptions): Promise<readonly (Uint8Array | null)[]> {
  resourceStates(requests);
  const reader = await openBambuStorageResourceReader(addonPath, sourcePath, privateUrl, options);
  try { return await reader.read(requests); } finally { await reader.close(); }
}
export async function readBambuStorageResource(addonPath: string, sourcePath: string, privateUrl: string,
  request: BambuStorageResourceRequest, options: BambuStorageReadOptions): Promise<Uint8Array | null> {
  return (await readBambuStorageResources(addonPath, sourcePath, privateUrl, [request], options))[0];
}
