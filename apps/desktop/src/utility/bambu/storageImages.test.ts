import { afterEach, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { BambuStorageFiles, type BambuStorageSource } from './storageFiles';
import { BambuStorageImages, thumbnailMime } from './storageImages';
const owners: BambuStorageImages[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); vi.useRealTimers(); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
async function fixture() {
  const source: BambuStorageSource = { configurationRevision: 'r1',
    list: vi.fn(async () => [{ name: 'part.gcode.3mf', path: '/part.gcode.3mf', sizeBytes: 3, modifiedAtSeconds: null }]),
    download: vi.fn(), remove: vi.fn(), resource: vi.fn(async (_path, resource) => resource === '_rels/.rels'
      ? new TextEncoder().encode('<Relationships><Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="Metadata/cover.png"/></Relationships>') : new Uint8Array(png)) };
  const files = new BambuStorageFiles(async () => ({ ok: true, value: source }));
  const page = await files.list({ target, storageId: 'external' as D.Id<'storage'>, location: { kind: 'collection', collectionId: 'model' as D.Id<'file-collection'> } });
  if (!page.ok) throw new Error('fixture'); const file = page.value.files[0].ref;
  const images = new BambuStorageImages(files); owners.push(images);
  const request: D.OpenMediaRequest = { target, requestId: 'request' as D.Id<'request'>, source: { kind: 'file-preview', target: file, previewId: 'thumbnail' as D.Id<'preview-option'> }, client: { video: [], imageMimeTypes: ['image/png'], contentFormats: [] } };
  return { source, files, file, images, request };
}
it('enumerates an independent preview then reads only relationships and the selected image', async () => {
  const f = await fixture(); expect(await f.files.listPreviews(f.file)).toMatchObject({ ok: true, value: { options: [{ kind: 'thumbnail' }] } });
  const result = await f.images.call('document', { method: 'open', input: f.request });
  expect(result).toMatchObject({ ok: true, value: { presentation: { kind: 'image', mimeType: 'image/png', url: `data:image/png;base64,${png.toString('base64')}` } } });
  expect(f.source.resource).toHaveBeenNthCalledWith(1, '/part.gcode.3mf', '_rels/.rels', expect.any(AbortSignal));
  expect(f.source.resource).toHaveBeenNthCalledWith(2, '/part.gcode.3mf', 'Metadata/cover.png', expect.any(AbortSignal));
  expect(f.source.download).not.toHaveBeenCalled(); expect(f.source.list).toHaveBeenCalledOnce();
  await f.images.call('document', { method: 'open', input: f.request }); expect(f.source.resource).toHaveBeenCalledTimes(2);
});
it('does not substitute a full download when optional subfiles are unavailable', async () => {
  const f = await fixture(); vi.mocked(f.source.resource).mockResolvedValue(null);
  expect(await f.images.call('document', { method: 'open', input: f.request })).toMatchObject({ ok: false, error: { code: 'preview-unavailable' } });
  expect(f.source.download).not.toHaveBeenCalled();
});
it('cancels an in-progress image read and honors a cancellation arriving before open', async () => {
  const f = await fixture(); let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(f.source.resource).mockImplementation(async (_path, _resource, signal) => {
    started(); await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); }); return null;
  });
  const opening = f.images.call('document', { method: 'open', input: f.request }); await entered;
  await f.images.call('document', { method: 'cancelOpen', input: { requestId: f.request.requestId } }); expect(await opening).toMatchObject({ ok: false });
  await f.images.call('document', { method: 'cancelOpen', input: { requestId: 'early' as D.Id<'request'> } });
  expect(await f.images.call('document', { method: 'open', input: { ...f.request, requestId: 'early' as D.Id<'request'> } })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  expect(f.source.resource).toHaveBeenCalledOnce();
});
it('keeps image resources document-owned and releases retained bytes on close', async () => {
  const f = await fixture(), result = await f.images.call('document', { method: 'open', input: f.request });
  if (!result.ok || !result.value || !('ref' in result.value)) throw new Error('No image'); const ref = result.value.ref;
  expect(await f.images.call('other', { method: 'get', input: ref })).toMatchObject({ ok: false });
  await f.images.call('document', { method: 'close', input: ref });
  expect(await f.images.call('document', { method: 'open', input: f.request })).toMatchObject({ ok: false, error: { code: 'lease-expired' } });
});
it.each(['available', 'missing'] as const)('keeps admitting thumbnails after hundreds of %s reads within one history window', async availability => {
  const f = await fixture();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  if (availability === 'missing') vi.mocked(f.source.resource).mockResolvedValue(null);
  try {
    for (let index = 0; index < 300; index++) {
      const result = await f.images.call('document', { method: 'open', input: { ...f.request, requestId: `thumbnail-${index}` as D.Id<'request'> } });
      if (availability === 'missing') expect(result).toMatchObject({ ok: false, error: { code: 'preview-unavailable' } });
      else {
        if (!result.ok || !result.value || !('ref' in result.value)) throw new Error(`Thumbnail ${index} was rejected`);
        await f.images.call('document', { method: 'close', input: result.value.ref });
      }
    }
    const reads = vi.mocked(f.source.resource).mock.calls.length;
    const last = await f.images.call('document', { method: 'open', input: { ...f.request, requestId: 'thumbnail-299' as D.Id<'request'> } });
    expect(last).toMatchObject({ ok: false, error: { code: availability === 'missing' ? 'preview-unavailable' : 'lease-expired' } });
    expect(f.source.resource).toHaveBeenCalledTimes(reads);
    // History remains bounded: its oldest terminal entry can be read again.
    const first = await f.images.call('document', { method: 'open', input: { ...f.request, requestId: 'thumbnail-0' as D.Id<'request'> } });
    expect(f.source.resource).toHaveBeenCalledTimes(reads + (availability === 'missing' ? 1 : 2));
    if (first.ok && first.value && 'ref' in first.value) await f.images.call('document', { method: 'close', input: first.value.ref });
  } finally { clock.mockRestore(); }
});
it('preserves pending deduplication and live leases while evicting completed request history', async () => {
  const f = await fixture(), read = vi.mocked(f.source.resource).getMockImplementation()!;
  let enter!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { enter = resolve; }), paused = new Promise<void>(resolve => { resume = resolve; });
  vi.mocked(f.source.resource).mockImplementationOnce(async (...args) => { enter(); await paused; return read(...args); });
  const opening = f.images.call('document', { method: 'open', input: f.request }); await started;
  const heldRequest = { ...f.request, requestId: 'held' as D.Id<'request'> };
  const held = await f.images.call('document', { method: 'open', input: heldRequest });
  if (!held.ok || !held.value || !('ref' in held.value)) throw new Error('No held image');
  for (let index = 0; index < 150; index++) {
    const result = await f.images.call('document', { method: 'open', input: { ...f.request, requestId: `churn-${index}` as D.Id<'request'> } });
    if (!result.ok || !result.value || !('ref' in result.value)) throw new Error('History blocked an image');
    await f.images.call('document', { method: 'close', input: result.value.ref });
  }
  const reads = vi.mocked(f.source.resource).mock.calls.length;
  expect(await f.images.call('document', { method: 'open', input: heldRequest })).toEqual(held);
  const duplicate = f.images.call('document', { method: 'open', input: f.request });
  resume(); expect(await duplicate).toEqual(await opening);
  expect(f.source.resource).toHaveBeenCalledTimes(reads + 1); // Only the original read's image remains; no duplicate relationship read.
  expect(await f.images.call('document', { method: 'open', input: { ...heldRequest, client: { ...heldRequest.client, imageMimeTypes: [] } } }))
    .toMatchObject({ ok: false, error: { code: 'invalid-request' } });
});
it('keeps a renewed live lease deduplicated after its original request-history deadline', async () => {
  vi.useFakeTimers();
  const f = await fixture(), result = await f.images.call('document', { method: 'open', input: f.request });
  if (!result.ok || !result.value || !('ref' in result.value)) throw new Error('No image');
  await vi.advanceTimersByTimeAsync(50_000);
  expect(await f.images.call('document', { method: 'renew', input: result.value.ref })).toMatchObject({ ok: true });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(await f.images.call('document', { method: 'open', input: f.request })).toMatchObject({ ok: true, value: { ref: result.value.ref } });
  expect(f.source.resource).toHaveBeenCalledTimes(2);
});
it('rejects a changed configuration', async () => {
  const f = await fixture(); vi.mocked(f.source.resource).mockImplementation(async () => { f.source.configurationRevision = 'r2'; return png; });
  expect((await f.images.call('document', { method: 'open', input: f.request })).ok).toBe(false);
});
it('identifies PNG/JPEG delivery types without imposing decoded dimension or JPEG marker restrictions', () => {
  const large = Buffer.from(png); large.writeUInt32BE(100_000, 16);
  expect(thumbnailMime(large)).toBe('image/png'); expect(thumbnailMime(png)).toBe('image/png');
  // Lossless JPEG SOF3, also beyond the previous 4096-pixel width limit.
  expect(thumbnailMime(Uint8Array.from([255, 216, 255, 195, 0, 8, 8, 0, 1, 32, 0, 0]))).toBe('image/jpeg');
  expect(thumbnailMime(Uint8Array.of(1, 2, 3))).toBeNull();
});
it('delivers large relationships and images even when live images exceed the former aggregate budget', async () => {
  const f = await fixture();
  const relationships = new TextEncoder().encode('<Relationships>' + ' '.repeat(1024 * 1024) + '<Relationship Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="Metadata/cover.png"/></Relationships>');
  const large = Buffer.alloc(5 * 1024 * 1024); png.copy(large);
  vi.mocked(f.source.resource).mockImplementation(async (_path, resource) => resource === '_rels/.rels' ? relationships : large);
  for (let i = 0; i < 4; i++) {
    const result = await f.images.call('document', { method: 'open', input: { ...f.request, requestId: `large-${i}` as D.Id<'request'> } });
    if (!result.ok || !result.value || !('presentation' in result.value) || result.value.presentation.kind !== 'image') throw new Error('Large thumbnail rejected');
    const data = Buffer.from(result.value.presentation.url.split(',')[1], 'base64');
    expect(data.length).toBe(large.length); expect(data.subarray(0, png.length)).toEqual(png);
  }
  expect(f.source.resource).toHaveBeenCalledTimes(8); expect(f.source.download).not.toHaveBeenCalled();
});
