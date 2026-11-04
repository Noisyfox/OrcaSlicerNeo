/** Real utility cache/ownership; only the remote file reader is synthetic. */
import { appendFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { BambuStorageVideos } from '../src/utility/bambu/storageVideos';
import { BambuStorageFiles } from '../src/utility/bambu/storageFiles';
import type { BambuMediaRequest, BambuMediaAttachment } from '../src/shared/bambuMedia';
import type { BambuHostConfig } from '../src/shared/bambu';
let media: BambuStorageVideos;
process.parentPort.on('message', ({ data, ports }) => {
  if (data.type === 'init') {
    const config: BambuHostConfig = data.config;
    const files = new BambuStorageFiles(async () => ({ ok: true, value: { configurationRevision: 'r1',
      discover: async () => ['sdcard'], list: async () => [], remove: async () => {}, resource: async () => null,
      download: async (_file, signal) => {
        const bytes = await readFile(join(config.directory, 'fixture.mp4'));
        return { totalBytes: bytes.length, chunks: (async function* () {
          try {
            const half = Math.floor(bytes.length / 2); yield new Uint8Array(bytes.subarray(0, half));
            while (!signal?.aborted) {
              try { await access(join(config.directory, 'continue')); break; } catch {}
              await new Promise(r => setTimeout(r, 25));
            }
            signal?.throwIfAborted(); yield new Uint8Array(bytes.subarray(half)); await appendFile(join(config.directory, 'complete'), 'complete\n');
          } finally { await appendFile(join(config.directory, 'returned'), 'returned\n'); }
        })() };
      },
    } }));
    media = new BambuStorageVideos(files, join(config.directory, 'cache'), () => process.parentPort.postMessage({ type: 'changed', change: 'media' }));
    process.parentPort.postMessage({ type: 'ready' });
  } else if (data.type === 'media') {
    void media.call(data.owner as string, data.request as BambuMediaRequest).then(value => process.parentPort.postMessage({ type: 'reply', id: data.id, value }));
  } else if (data.type === 'media-port') void media.attach(data.owner, data.request as BambuMediaAttachment, ports[0]);
  else if (data.type === 'host' && data.request.method === 'media.waitRead') void media.waitRead(data.request.input.owner, data.request.input.ref).then(value => process.parentPort.postMessage({ type: 'reply', id: data.id, value }));
  else if (data.type === 'media-owner-close') void media.closeOwner(data.owner);
  else if (data.type === 'shutdown') void media.close().then(() => process.exit(0));
});
