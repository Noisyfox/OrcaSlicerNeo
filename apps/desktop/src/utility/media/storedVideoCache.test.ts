import { expect, it } from 'vitest';
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as D from '@orca/platform-contract';
import { ProgressiveMp4 } from './progressiveMp4';
import { StoredVideoCache } from './storedVideoCache';

async function fixture(fastStart: 'in-memory' | false = 'in-memory', frames = 60) {
  const target = new BufferTarget(), source = new EncodedVideoPacketSource('avc');
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart }) });
  output.addVideoTrack(source); await output.start();
  const sps = Buffer.from('2742000d898a140a0cfcf35010d01078402115', 'hex'), pps = Buffer.from('28ce3c80', 'hex');
  const config = { codec: 'avc1.42000d', codedWidth: 320, codedHeight: 180,
    description: Buffer.concat([Buffer.from([1,66,0,13,255,225,0,sps.length]), sps, Buffer.from([1,0,pps.length]), pps]) };
  // Synthetic slices verify demux/index/cache behavior, not decoding. Browser E2E uses encoded frames.
  for (let i = 0; i < frames; i++) await source.add(new EncodedPacket(new Uint8Array([0,0,0,2,i % 30 ? 0x41 : 0x65,0xb8]),
    i % 30 ? 'delta' : 'key', i / 30, 1 / 30, i), i ? undefined : { decoderConfig: config });
  source.close(); await output.finalize(); return new Uint8Array(target.buffer!);
}
const download = (bytes: Uint8Array, chunks: AsyncIterable<Uint8Array>): D.Result<D.DownloadedFile> => ({ ok: true, value: {
  file: {} as D.RemoteFileRef, suggestedFileName: 'fixture.mp4', mimeType: 'video/mp4', totalBytes: bytes.length,
  responseBytes: bytes.length, returnedRange: null, chunks,
} });

it('progressively indexes fast-start AVC and rejects tail indexes without reading their media payload', async () => {
  const bytes = await fixture(), parser = new ProgressiveMp4(); let count = 0, init = false;
  for (let at = 0; at < bytes.length; at += 97) {
    const result = parser.push(bytes.subarray(at, at + 97)); count += result.fragments.length; init ||= !!result.init;
  }
  parser.finish(); expect(init).toBe(true); expect(count).toBe(60); expect(parser.index?.durationSeconds).toBeCloseTo(2); parser.close();
  const tail = await fixture(false), other = new ProgressiveMp4();
  expect(() => other.push(tail.subarray(0, 64))).toThrow('progressively'); other.close();
});
it('rejects oversized sample declarations before parsing and never marks a failed terminal checksum complete', async () => {
  const bytes = await fixture(), corrupt = Buffer.from(bytes), marker = corrupt.indexOf(Buffer.from('stsz'));
  expect(marker).toBeGreaterThan(0); corrupt.writeUInt32BE(0xffffffff, marker + 12);
  const parser = new ProgressiveMp4(); expect(() => parser.push(corrupt)).toThrow('progressively'); parser.close();
  const root = await mkdtemp(join(tmpdir(), 'neo-video-test-'));
  const cache = new StoredVideoCache(root, async () => download(bytes, (async function* () { yield bytes; throw new Error('Checksum mismatch'); })()), () => {});
  try { await cache.done; expect(cache.complete).toBe(false); expect(cache.error?.message).toBe('Checksum mismatch'); }
  finally { await cache.close(); await rm(root, { recursive: true, force: true }); }
});
it('writes before exposing ranges, holds only disk packets, seeks at a cached keyframe and joins cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neo-video-test-')), bytes = await fixture();
  let release!: () => void, returned = false;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const cache = new StoredVideoCache(root, async signal => download(bytes, (async function* () {
    try {
      yield bytes.subarray(0, bytes.length - 60);
      await Promise.race([barrier, new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))]);
      signal.throwIfAborted(); yield bytes.subarray(bytes.length - 60);
    } finally { returned = true; }
  })()), () => {});
  try {
    await cache.ready; expect(cache.complete).toBe(false); expect(cache.cachedEnd).toBeGreaterThan(1);
    const stream = cache.stream(1.25, new AbortController().signal)[Symbol.asyncIterator]();
    expect((await stream.next()).value).toMatchObject({ kind: 'init', sequence: 0 });
    expect((await stream.next()).value).toMatchObject({ kind: 'segment', sequence: 1 }); await stream.return?.();
    await expect(cache.stream(3, new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('downloaded');
    release(); await cache.done; expect(cache.complete).toBe(true); expect(cache.error).toBeUndefined(); expect(returned).toBe(true);
    await cache.close(); expect(await readdir(root)).toEqual([]);
  } finally { release(); await cache.close(); await rm(root, { recursive: true, force: true }); }
});
it('cancellation joins the source and removes cache; quotas and truncation fail explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neo-video-test-')), bytes = await fixture(); let returned = false;
  const cache = new StoredVideoCache(root, async signal => download(bytes, (async function* () {
    try { yield bytes.subarray(0, bytes.length - 60); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); signal.throwIfAborted(); }
    finally { returned = true; }
  })()), () => {});
  try {
    await cache.ready; await cache.close(); expect(returned).toBe(true); expect(await readdir(root)).toEqual([]);
    const limited = new StoredVideoCache(root, async () => download(bytes, (async function* () { yield bytes; })()), () => {}, 100);
    await expect(limited.ready).rejects.toThrow('limit'); await limited.close();
    const truncated = new StoredVideoCache(root, async () => download(bytes, (async function* () { yield bytes.subarray(0, bytes.length - 4); })()), () => {});
    await truncated.done; expect(truncated.error?.message).toContain('Incomplete'); await truncated.close();
    expect(await readdir(root)).toEqual([]);
  } finally { await cache.close(); await rm(root, { recursive: true, force: true }); }
});
