import { expect, it, vi } from 'vitest';
import type { PrinterConfigurationDocument } from '../configuration';
import type * as D from '../domain';
import type { PrinterTransportRequest } from '../transport';
import { createSnapmakerService } from './service';

const id = <K extends string>(value: string) => value as D.Id<K>;
const target = { printerId: id<'printer'>('u1'), routeId: id<'route'>('snapmaker:u1') };
const internal = id<'storage'>('internal'), usb = id<'storage'>('usb');
const usbFile = '.udisk/目录/part #%.gcode';
const listRequest = { target, storageId: internal, location: { kind: 'collection', collectionId: id<'file-collection'>('gcode') }, pageSize: 1 } as const;
const png = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const unwrap = <T>(result: D.Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

function fixture() {
  const document: PrinterConfigurationDocument = { version: 1, printers: [
    { id: 'u1', driverId: 'snapmaker', displayName: 'U1', apiBaseUrl: 'http://printer/proxy/', apiKey: 'secret', consoleUrl: '' },
  ] };
  const fixtureData = {
    listing: [usbFile, 'part #%.gcode', 'nested/second.GCO', '.udisk-old/third.gcode', 'nested/no.txt', '../outside.gcode',
      'part #%.gcode'].map((path, index) => ({ path, size: 10 + index, modified: 1700000000.125 - index })),
    metadata: { thumbnails: [{ relative_path: '.thumbs/preview #%.png', width: 48, height: 48 }] },
    listStatus: 200, metadataStatus: 200, image: png,
  };
  const request = vi.fn(async ({ url }: PrinterTransportRequest) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/list')) return { status: fixtureData.listStatus, json: async () => ({ result: fixtureData.listing }), bytes: async () => new Uint8Array() };
    if (path.endsWith('/metadata')) return { status: fixtureData.metadataStatus, json: async () => ({ result: fixtureData.metadata }), bytes: async () => new Uint8Array() };
    return { status: 200, json: async () => ({}), bytes: async () => fixtureData.image };
  });
  const service = createSnapmakerService({
    host: { id: id<'agent-host'>('host'), name: 'Host', execution: 'browser' },
    configuration: { load: async () => structuredClone(document), save: async () => {} }, transport: { request },
  });
  const browse = async (storageId = internal) => unwrap(await service.files.list({ ...listRequest, storageId }));
  return { service, document, request, browse, data: fixtureData };
}

function openRequest(file: D.RemoteFileRef, option: D.FilePreviewOption): D.OpenMediaRequest {
  return {
    target: { ...target, expectedConfigurationRevision: file.configurationRevision }, requestId: id<'request'>('preview'),
    source: { kind: 'file-preview', target: file, previewId: option.id },
    client: { video: [], imageMimeTypes: ['image/png'], contentFormats: [] },
  };
}

it('enumerates only on demand and shares a scoped paged listing across internal and USB collections', async () => {
  const { service, request, browse, data } = fixture();
  const saved = unwrap(await service.listSaved());
  expect(saved[0].routes[0].capabilities).toMatchObject({ files: { list: { kind: 'supported' }, preview: { kind: 'supported' },
    download: { kind: 'unsupported' } }, commands: { 'files.delete': { kind: 'unsupported' }, 'jobs.start': { kind: 'unsupported' } } });
  expect(request).not.toHaveBeenCalled();
  expect(unwrap(await service.files.listStorages(target))).toMatchObject([
    { id: internal, availability: { kind: 'available' }, browsing: { constraints: { collections: [{ actions: [] }] } } },
    { id: usb, availability: { kind: 'available' } },
  ]);
  const onboard = await browse();
  const removable = await browse(usb);
  expect(onboard.files[0]).toMatchObject({ name: 'part #%.gcode', sizeBytes: 11, modifiedAtMs: 1699999999125 });
  expect(removable.files[0].name).toBe(onboard.files[0].name);
  expect(removable.files[0].ref.fileId).not.toBe(onboard.files[0].ref.fileId);
  expect(removable.nextCursor).toBeNull();
  const next = { ...listRequest, cursor: onboard.nextCursor! };
  const second = unwrap(await service.files.list(next));
  expect(second.files[0].name).toBe('second.GCO');
  expect(unwrap(await service.files.list({ ...listRequest, cursor: second.nextCursor! })).files.map(file => file.name)).toEqual(['third.gcode']);
  expect(await service.files.list({ ...next, storageId: usb })).toMatchObject({ ok: false, error: { code: 'listing-expired' } });
  expect(await service.files.list({ ...next, pageSize: 2 })).toMatchObject({ ok: false, error: { code: 'listing-expired' } });
  expect(request).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    method: 'GET', url: 'http://printer/proxy/server/files/list?root=gcodes', headers: { 'X-Api-Key': 'secret' },
  }));
  data.listing = [];
  expect(unwrap(await service.files.listStorages(target))[1].availability).toMatchObject({ kind: 'unknown' });
  expect(await service.files.list(next)).toMatchObject({ ok: false, error: { code: 'listing-expired' } });
  expect((await browse()).files).toEqual([]);
});

it('opens an authenticated nested USB thumbnail with encoded path segments and idempotent close', async () => {
  const { service, request, browse } = fixture();
  const file = (await browse(usb)).files[0].ref;
  const { options } = unwrap(await service.files.listPreviews(file));
  const input = openRequest(file, options[0]);
  const preview = unwrap(await service.media.open(input));
  expect(preview).toMatchObject({ source: input.source, presentation: { kind: 'image', mimeType: 'image/png', url: 'data:image/png;base64,iVBORw0KGgo=' },
    expiresAtMs: null });
  expect(unwrap(await service.media.close(preview.ref))).toBeNull();
  expect(unwrap(await service.media.close(preview.ref))).toBeNull();
  expect(request.mock.calls.slice(1).map(([call]) => [call.method, call.url, call.headers])).toEqual([
    ['GET', `http://printer/proxy/server/files/metadata?filename=${encodeURIComponent(usbFile)}`, { 'X-Api-Key': 'secret' }],
    ['GET', 'http://printer/proxy/server/files/gcodes/.udisk/%E7%9B%AE%E5%BD%95/.thumbs/preview%20%23%25.png', { 'X-Api-Key': 'secret' }],
  ]);
});

it('keeps missing thumbnails optional and rejects unsafe paths or wrong image bytes', async () => {
  const { service, request, browse, data } = fixture();
  const { files } = await browse();
  const file = files[0].ref;
  data.metadataStatus = 404;
  expect(unwrap(await service.files.listPreviews(file)).options).toEqual([]);
  data.metadataStatus = 200;
  data.metadata.thumbnails[0].relative_path = '../outside.png';
  unwrap(await service.files.listStorages(target));
  expect(unwrap(await service.files.listPreviews(file)).options).toEqual([]);
  expect(request.mock.calls.every(([call]) => call.responseType !== 'bytes')).toBe(true);
  data.metadata.thumbnails[0].relative_path = '.thumbs/image.png';
  data.image = Uint8Array.of(0);
  unwrap(await service.files.listStorages(target));
  const preview = unwrap(await service.files.listPreviews(file)).options[0];
  expect(await service.media.open(openRequest(file, preview))).toMatchObject({ ok: false, error: { code: 'preview-unavailable' } });
  const before = request.mock.calls.length;
  expect(await service.files.listPreviews({ ...file, storageId: usb })).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
  expect(await service.files.listPreviews({ ...file, fileId: id<'remote-file'>('snapmaker-storage:..%2Foutside.gcode') }))
    .toMatchObject({ ok: false, error: { code: 'invalid-target' } });
  expect(request).toHaveBeenCalledTimes(before);
});

it('rejects cancelled reads and late previews after the printer route changes', async () => {
  const { service, request, browse, document } = fixture();
  const file = (await browse()).files[0].ref;
  const preview = unwrap(await service.files.listPreviews(file)).options[0];
  const controller = new AbortController();
  controller.abort();
  expect(await service.files.list(listRequest, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  request.mockImplementationOnce(async () => ({ status: 200, json: async () => ({}), bytes: async () => {
    document.printers[0].apiBaseUrl = 'http://other-printer/';
    return png;
  } }));
  expect(await service.media.open(openRequest(file, preview))).toMatchObject({ ok: false, error: { code: 'stale-context' } });
  expect(await service.files.listPreviews(file)).toMatchObject({ ok: false, error: { code: 'stale-context' } });
});

it('reports list authorization errors instead of showing an empty printer', async () => {
  const { service, data } = fixture();
  data.listStatus = 401;
  expect(await service.files.listStorages(target)).toMatchObject({ ok: false, error: { code: 'authentication-required' } });
});
