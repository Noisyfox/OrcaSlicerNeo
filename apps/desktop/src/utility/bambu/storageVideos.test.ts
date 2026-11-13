import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type * as D from '@orca/platform-contract';
import { BambuStorageFiles } from './storageFiles';
import { BambuStorageVideos } from './storageVideos';
it('cold-start cleanup removes orphan caches but preserves live owners and unrelated directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neo-video-owner-'));
  const live = `process-${process.pid}-${randomUUID()}`, dead = `process-2147483647-${randomUUID()}`;
  await Promise.all([live, dead, 'unrecognized'].map(name => mkdir(join(root, name))));
  const resolve = vi.fn(async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: 'Not used.' } }));
  const owner = new BambuStorageVideos(new BambuStorageFiles(resolve), root, () => {});
  try { await owner.close(); expect((await readdir(root)).sort()).toEqual([live, 'unrecognized'].sort()); expect(resolve).not.toHaveBeenCalled(); }
  finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects unsupported browser capabilities without allocating a printer reader', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neo-video-owner-'));
  const resolve = vi.fn(async () => ({ ok: false as const, error: { code: 'unsupported' as const, message: 'Not used.' } }));
  const owner = new BambuStorageVideos(new BambuStorageFiles(resolve), root, () => {});
  const request = { requestId: 'r', target: { printerId: 'p', routeId: 'r' }, source: { kind: 'file-preview', previewId: 'video', target: { printerId: 'p', routeId: 'r' } }, client: { video: [] } } as unknown as D.OpenMediaRequest;
  try { expect(await owner.call('document', { method: 'open', input: request })).toMatchObject({ ok: false, error: { code: 'no-compatible-media' } }); expect(resolve).not.toHaveBeenCalled(); }
  finally { await owner.close(); await rm(root, { recursive: true, force: true }); }
});
