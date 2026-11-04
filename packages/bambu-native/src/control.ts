/** Host-private current-project resource reads over Orca's BambuSource CTRL ABI. */
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export interface NativeControlStream {
  poll(): { ready: boolean; messages: Uint8Array[] };
  send(message: string): void;
  close(): Promise<void>;
}
export type BambuControlPurpose = 'project-resource' | 'storage';
export function loadBambuControlStream(addonPath: string, sourcePath: string, privateUrl: string, purpose: BambuControlPurpose): NativeControlStream {
  if (!isAbsolute(addonPath) || !isAbsolute(sourcePath)) throw new Error('Native library paths must be absolute');
  const addon = createRequire(addonPath)(addonPath) as { ControlStream: new (path: string, url: string, purpose: BambuControlPurpose) => NativeControlStream };
  return new addon.ControlStream(sourcePath, privateUrl, purpose);
}
export class BambuResourceError extends Error {
  constructor(readonly code: 'cancelled' | 'transport' | 'invalid-resource' | 'out-of-range', message: string) { super(message); }
}
export interface BambuResourceSource {
  localUrl: string | null;
  /** Null for LAN-only access. Resolve credentials/tickets only if local acquisition failed. */
  remoteUrl: (() => Promise<string>) | null;
}
export interface BambuResourceReadOptions { signal?: AbortSignal; timeoutMs?: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const invalid = () => new BambuResourceError('invalid-resource', 'The task resource response is invalid.');
const cancelled = () => new BambuResourceError('cancelled', 'Task resource reading was cancelled.');

function remoteUrl(resolve: () => Promise<string>, options: BambuResourceReadOptions): Promise<string> {
  return new Promise((accept, reject) => {
    const abort = () => finish(undefined, cancelled());
    const timeout = setTimeout(() => finish(undefined, new BambuResourceError('transport', 'Task resource connection timed out.')), options.timeoutMs ?? 15_000);
    function finish(value?: string, error?: unknown) {
      clearTimeout(timeout); options.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else accept(value!);
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) { abort(); return; }
    Promise.resolve().then(resolve).then(value => finish(value), error => finish(undefined, error));
  });
}

async function readOne(addonPath: string, sourcePath: string, url: string, resource: string, options: BambuResourceReadOptions): Promise<Uint8Array> {
  const stream = loadBambuControlStream(addonPath, sourcePath, url, 'project-resource');
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    const parameter = JSON.stringify({ sequence_id: 1, version: 1, peer_host: 'studio', command: 'get_project_file', file_rel_path: resource });
    const message = JSON.stringify({ cmdtype: 4, sequence: 1, req: { path: 'mem:/16', offset: 0, mem_dl_param_size: Buffer.byteLength(parameter) } }) + '\n\n' + parameter;
    let sent = false, received = 0, total: number | undefined;
    const chunks: Uint8Array[] = [], hash = createHash('md5');
    while (!options.signal?.aborted) {
      if (Date.now() >= deadline) throw new BambuResourceError('transport', 'Task resource reading timed out.');
      const polled = stream.poll();
      if (polled.ready && !sent) { stream.send(message); sent = true; }
      for (const value of polled.messages) {
        const packet = Buffer.from(value), separator = packet.indexOf('\n\n');
        const header = separator === -1 ? packet : packet.subarray(0, separator);
        const body = separator === -1 ? Buffer.alloc(0) : packet.subarray(separator + 2);
        let root: unknown;
        try { root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header)); } catch { throw invalid(); }
        if (!object(root)) throw invalid();
        if (root.sequence !== 1 || root.result === undefined) continue; // Unrelated replies/notifications do not advance this read.
        if (root.result !== 0 && root.result !== 1) throw new BambuResourceError('transport', 'The current task resource is unavailable.');
        if (!object(root.reply)) throw invalid();
        const reply = root.reply;
        if (reply.mem_dl_param_size !== undefined) {
          if (!integer(reply.mem_dl_param_size) || reply.mem_dl_param_size !== body.length) throw invalid();
          let metadata: unknown;
          try { metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw invalid(); }
          if (!object(metadata) || metadata.result !== 0) throw new BambuResourceError('transport', 'The current task resource is unavailable.');
          if (metadata.size !== undefined && (!integer(metadata.size) || metadata.size === 0))
            throw new BambuResourceError('out-of-range', 'The task resource size is unsupported.');
          continue; // Parameter metadata is not part of the file bytes/hash.
        }
        if (!integer(reply.offset) || !integer(reply.total) || !integer(reply.size) || reply.offset !== received
          || reply.size !== body.length || total !== undefined && total !== reply.total) throw invalid();
        if (body.length === 0 && root.result === 1) throw invalid();
        if (reply.total === 0 || received + body.length > reply.total)
          throw new BambuResourceError('out-of-range', 'The task resource size is unsupported.');
        total = reply.total; received += body.length; chunks.push(body); hash.update(body);
        if (root.result === 0) {
          if (received !== total || typeof reply.file_md5 !== 'string' || !/^[a-f\d]{32}$/i.test(reply.file_md5)
            || hash.digest('hex') !== reply.file_md5.toLowerCase()) throw invalid();
          return new Uint8Array(Buffer.concat(chunks, received));
        }
      }
      await delay(5, undefined, { signal: options.signal });
    }
    throw cancelled();
  } catch (error) {
    if (options.signal?.aborted) throw cancelled();
    if (error instanceof BambuResourceError) throw error;
    throw new BambuResourceError('transport', 'The task resource could not be read.');
  } finally { await stream.close(); }
}

/** Reads only the current project's allowlisted object resources, never arbitrary printer files. */
export async function readBambuProjectResource(addonPath: string, sourcePath: string, source: BambuResourceSource,
  resource: string, options: BambuResourceReadOptions = {}): Promise<Uint8Array> {
  if (!/^Metadata\/(?:slice_info\.config|model_settings\.config|pick_[1-9]\d{0,2}\.png)$/.test(resource)) throw invalid();
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 20_000)) throw invalid();
  if (options.signal?.aborted) throw cancelled();
  let failure: unknown;
  if (source.localUrl) {
    try { return await readOne(addonPath, sourcePath, source.localUrl, resource, options); }
    catch (error) { if (options.signal?.aborted) throw cancelled(); failure = error; }
  }
  if (source.remoteUrl) {
    try {
      const url = await remoteUrl(source.remoteUrl, options);
      if (options.signal?.aborted) throw cancelled();
      return await readOne(addonPath, sourcePath, url, resource, options);
    } catch (error) { if (options.signal?.aborted) throw cancelled(); failure = error; }
  }
  if (failure instanceof BambuResourceError) throw failure;
  throw new BambuResourceError('transport', 'The task resource could not be read.');
}
