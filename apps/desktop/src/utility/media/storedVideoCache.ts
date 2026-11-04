import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type * as D from '@orca/printer-control/domain';
import { ProgressiveMp4, StoredVideoError, type VideoIndex } from './progressiveMp4';

interface Fragment { offset: number; length: number; start: number; end: number; key: boolean }
/** A single owned disk file, bounded index and pull-based disk delivery. No original-file copy in RAM. */
export class StoredVideoCache {
  private handle?: FileHandle;
  private directory?: string;
  private fragments: Fragment[] = [];
  private init?: { offset: number; length: number };
  private bytes = 0;
  private ended = false;
  private failed?: Error;
  private closed = false;
  private generation = 0;
  private wake = new Set<() => void>();
  private controller = new AbortController();
  private reads = new Set<Promise<unknown>>();
  private closing?: Promise<void>;
  private resolveReady!: (value: VideoIndex) => void;
  private rejectReady!: (error: unknown) => void;
  readonly ready = new Promise<VideoIndex>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  readonly done: Promise<void>;
  index?: VideoIndex;
  constructor(root: string, read: (signal: AbortSignal) => Promise<D.Result<D.DownloadedFile>>,
    private readonly changed: () => void, private readonly quota = 2 * 1024 ** 3) {
    void this.ready.catch(() => {});
    this.done = this.consume(root, read).catch(error => {
      this.failed = error instanceof Error ? error : new Error('Media reading failed.');
      this.rejectReady(this.failed); this.notify();
    });
  }
  get error() { return this.failed; }
  get complete() { return this.ended; }
  get cachedEnd() { return this.fragments.at(-1)?.end ?? 0; }
  private notify() { for (const wake of this.wake) wake(); this.changed(); }
  private async write(bytes: Uint8Array) {
    if (this.bytes + bytes.length > this.quota) throw new StoredVideoError('Playback cache is full. Download the file to continue in a system player.');
    const offset = this.bytes;
    for (let written = 0; written < bytes.length;) {
      this.controller.signal.throwIfAborted();
      const result = await this.handle!.write(bytes, written, bytes.length - written, offset + written);
      if (!result.bytesWritten) throw new Error('Media cache write failed.');
      written += result.bytesWritten;
    }
    this.bytes += bytes.length; return { offset, length: bytes.length };
  }
  private async consume(root: string, read: (signal: AbortSignal) => Promise<D.Result<D.DownloadedFile>>) {
    const parser = new ProgressiveMp4();
    let iterator: AsyncIterator<Uint8Array> | undefined;
    try {
      this.directory = await mkdtemp(join(root, 'video-'));
      this.handle = await open(join(this.directory, 'fragments'), 'wx+', 0o600);
      this.controller.signal.throwIfAborted();
      const result = await read(this.controller.signal);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { detail: result.error });
      const download = result.value;
      iterator = download.chunks[Symbol.asyncIterator]();
      if (download.returnedRange || download.totalBytes !== null && download.totalBytes > this.quota) throw new StoredVideoError('This file exceeds the playback cache limit. Download it to use a system player.');
      let received = 0;
      for (;;) {
        this.controller.signal.throwIfAborted();
        const next = await iterator.next(); if (next.done) break;
        const chunk = next.value;
        if (!chunk.length || chunk.length > 4 * 1024 * 1024) throw new Error('Invalid media input chunk.');
        received += chunk.length;
        if (received > this.quota || download.totalBytes !== null && received > download.totalBytes) throw new Error('Invalid media file length.');
        for (let at = 0; at < chunk.length; at += 256 * 1024) {
          this.controller.signal.throwIfAborted();
          const result = parser.push(chunk.subarray(at, at + 256 * 1024));
          if (result.init) { this.init = await this.write(result.init); this.index = parser.index; }
          for (const fragment of result.fragments) {
            const stored = await this.write(fragment.bytes);
            this.fragments.push({ ...stored, start: fragment.start, end: fragment.end, key: fragment.key });
          }
          if (this.fragments.length) { this.resolveReady(this.index!); this.notify(); }
        }
      }
      if (download.totalBytes !== null && received !== download.totalBytes || download.responseBytes !== null && received !== download.responseBytes) throw new Error('Incomplete media file.');
      parser.finish();
    } finally { parser.close(); await iterator?.return?.(); }
    this.ended = true; this.notify();
  }
  private async bytesAt(entry: { offset: number; length: number }) {
    const bytes = new Uint8Array(entry.length);
    const work = (async () => {
      for (let at = 0; at < bytes.length;) {
        const value = await this.handle!.read(bytes, at, bytes.length - at, entry.offset + at);
        if (!value.bytesRead) throw new Error('Media cache was truncated.'); at += value.bytesRead;
      }
      return bytes;
    })();
    this.reads.add(work); try { return await work; } finally { this.reads.delete(work); }
  }
  async *stream(startSeconds = 0, signal: AbortSignal): AsyncIterable<D.MediaStreamPacket> {
    if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds >= this.cachedEnd) throw new StoredVideoError('Seek within the downloaded playable range.');
    let at = 0;
    for (let i = 0; i < this.fragments.length; i++) {
      if (this.fragments[i].start > startSeconds) break;
      if (this.fragments[i].key) at = i;
    }
    const generation = this.generation++; let sequence = 0;
    const check = () => { signal.throwIfAborted(); if (this.closed) throw new Error('Media cache is closed.'); if (this.failed) throw this.failed; };
    check();
    yield { kind: 'init', generation, sequence: sequence++, bytes: await this.bytesAt(this.init!), mimeType: this.index!.mimeType };
    for (;;) {
      check();
      if (at < this.fragments.length) {
        yield { kind: 'segment', generation, sequence: sequence++, bytes: await this.bytesAt(this.fragments[at++]) }; continue;
      }
      if (this.ended) return;
      await new Promise<void>(resolve => {
        const done = () => { this.wake.delete(done); signal.removeEventListener('abort', done); resolve(); };
        this.wake.add(done); signal.addEventListener('abort', done, { once: true });
        if (signal.aborted || this.closed || this.failed || at < this.fragments.length || this.ended) done();
      });
    }
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true; this.controller.abort(); this.notify(); await this.done;
      await Promise.allSettled([...this.reads]); await this.handle?.close();
      if (this.directory) await rm(this.directory, { recursive: true, force: true });
      this.fragments = []; this.handle = undefined;
    })();
  }
}
