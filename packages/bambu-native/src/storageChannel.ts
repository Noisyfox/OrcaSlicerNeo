/** Private LAN CTRL transport for Storage; never exposed to a renderer. */
import { setTimeout as delay } from 'node:timers/promises';
import { loadBambuControlStream, type NativeControlStream } from './control.js';

export class BambuStorageError extends Error {
  constructor(readonly code: 'cancelled' | 'transport' | 'invalid-response' | 'device-rejected',
    message: string, readonly result: number | null = null) { super(message); }
}
export interface BambuStorageReadOptions {
  signal?: AbortSignal;
  connectTimeoutMs: number;
  inactivityTimeoutMs: number;
}
export interface StorageReply { result: number; reply: Record<string, unknown>; body: Uint8Array }
export const storageObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export const storageInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const invalidStorageReply = () => new BambuStorageError('invalid-response', 'The printer returned an invalid storage response.');
const cancelled = () => new BambuStorageError('cancelled', 'Storage reading was cancelled.');

export interface StorageChannel {
  /** One outstanding read. Each consumer demand has its own inactivity deadline. */
  read(): Promise<StorageReply>;
  close(): Promise<void>;
  send(command: number, request: Record<string, unknown>): void;
}

/** One native connection; sequential requests have distinct sequences. Close always joins the reader. */
export async function openStorageChannel(addonPath: string, sourcePath: string, privateUrl: string,
  command: number, request: Record<string, unknown> | undefined, options: BambuStorageReadOptions): Promise<StorageChannel> {
  for (const timeout of [options.connectTimeoutMs, options.inactivityTimeoutMs])
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new BambuStorageError('invalid-response', 'Invalid storage timeout.');
  if (!privateUrl.startsWith('bambu:///local/')) throw new BambuStorageError('transport', 'Storage requires an authorized LAN connection.');
  if (options.signal?.aborted) throw cancelled();
  let stream: NativeControlStream;
  try { stream = loadBambuControlStream(addonPath, sourcePath, privateUrl, 'storage'); }
  catch { throw new BambuStorageError('transport', 'Could not open printer storage.'); }
  let closing: Promise<void> | undefined, reading = false, sequence = 0, complete = true;
  let pending: Uint8Array[] = [];
  const close = () => {
    if (!closing) {
      options.signal?.removeEventListener('abort', abort);
      pending = [];
      closing = stream.close();
    }
    return closing;
  };
  const abort = () => { void close().catch(() => undefined); };
  const check = () => {
    if (options.signal?.aborted) throw cancelled();
    if (closing) throw new BambuStorageError('transport', 'The storage reader is closed.');
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  const wait = async () => { await delay(5, undefined, { signal: options.signal }); };
  const send = (nextCommand: number, nextRequest: Record<string, unknown>) => {
    check(); if (reading || !complete) throw invalidStorageReply();
    command = nextCommand; complete = false;
    stream.send(JSON.stringify({ cmdtype: command, sequence: ++sequence, req: nextRequest }));
  };
  const normalize = (error: unknown) => options.signal?.aborted ? cancelled() : error instanceof BambuStorageError ? error
    : new BambuStorageError('transport', 'Could not read printer storage.');
  try {
    const deadline = performance.now() + options.connectTimeoutMs;
    while (true) {
      check();
      if (performance.now() >= deadline) throw new BambuStorageError('transport', 'Storage connection timed out.');
      if (stream.poll().ready) break;
      await wait();
    }
    check();
    if (request !== undefined) send(command, request);
  } catch (error) { await close(); throw normalize(error); }
  return {
    close, send,
    async read() {
      if (reading) throw new BambuStorageError('invalid-response', 'A storage read is already pending.');
      reading = true;
      try {
        const deadline = performance.now() + options.inactivityTimeoutMs;
        while (true) {
          check();
          if (pending.length === 0) pending = stream.poll().messages;
          // Inspect already-arrived bytes before declaring inactivity: a delayed
          // host timer or a paused consumer does not imply a silent printer.
          if (pending.length === 0) {
            if (performance.now() >= deadline) throw new BambuStorageError('transport', 'Storage reading made no progress.');
            await wait(); continue;
          }
          const packet = Buffer.from(pending.shift()!), separator = packet.indexOf('\n\n');
          const header = separator < 0 ? packet : packet.subarray(0, separator);
          const body = separator < 0 ? new Uint8Array(0) : packet.subarray(separator + 2);
          // Listings may contain many entries in one JSON packet; binary file headers are small.
          if (header.byteLength > (command === 1 ? 4 * 1024 * 1024 : 65536)) throw invalidStorageReply();
          let root: unknown;
          try { root = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(header)); } catch { throw invalidStorageReply(); }
          if (!storageObject(root)) throw invalidStorageReply();
          if (root.sequence !== sequence || root.result === undefined) {
            if (performance.now() >= deadline) throw new BambuStorageError('transport', 'Storage reading made no progress.');
            continue;
          }
          if (!storageInteger(root.result) || root.cmdtype !== undefined && root.cmdtype !== command) throw invalidStorageReply();
          const fileError = command === 2 && [10, 12, 13, 14, 16].includes(root.result);
          if (root.result !== 0 && root.result !== 1 && !fileError)
            throw new BambuStorageError('device-rejected', 'The printer rejected the storage request.', root.result);
          if (!storageObject(root.reply)) throw invalidStorageReply();
          complete = root.result !== 1;
          return { result: root.result, reply: root.reply, body };
        }
      } catch (error) { await close(); throw normalize(error); }
      finally { reading = false; }
    },
  };
}
