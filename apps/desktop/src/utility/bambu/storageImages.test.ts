import { afterEach, expect, it, vi } from 'vitest';
import type * as D from '@orca/printer-control/domain';
import { BambuStorageFiles, type BambuStorageSource } from './storageFiles';
import { BambuStorageImages, thumbnailMime } from './storageImages';
const owners: BambuStorageImages[] = [];
afterEach(async () => { for (const owner of owners.splice(0)) await owner.close(); });
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
  expect(f.source.resource).toHaveBeenNthCalledWith(1, '/part.gcode.3mf', '_rels/.rels', 1024 * 1024, expect.any(AbortSignal));
  expect(f.source.resource).toHaveBeenNthCalledWith(2, '/part.gcode.3mf', 'Metadata/cover.png', 4 * 1024 * 1024, expect.any(AbortSignal));
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
  vi.mocked(f.source.resource).mockImplementation(async (_path, _resource, _limit, signal) => {
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
it('rejects a changed configuration and excessive decoded image dimensions', async () => {
  const f = await fixture(); vi.mocked(f.source.resource).mockImplementation(async () => { f.source.configurationRevision = 'r2'; return png; });
  expect((await f.images.call('document', { method: 'open', input: f.request })).ok).toBe(false);
  const large = Buffer.from(png); large.writeUInt32BE(100_000, 16); expect(thumbnailMime(large)).toBeNull(); expect(thumbnailMime(png)).toBe('image/png');
});
