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
    listStatus: 200, metadataStatus: 200, image: png, deleteMode: 'confirmed',
  };
  const request = vi.fn(async ({ method, url }: PrinterTransportRequest) => {
    const path = new URL(url).pathname;
    if (method === 'DELETE') {
      const filename = decodeURIComponent(path.split('/server/files/gcodes/')[1]);
      if (fixtureData.deleteMode === 'interrupted') throw new Error('connection interrupted');
      fixtureData.listing = fixtureData.listing.filter(item => item.path !== filename);
      return { status: 200, json: async () => ({ result: { action: 'delete_file', item: { root: 'gcodes', path: filename } } }), bytes: async () => new Uint8Array() };
    }
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
    download: { kind: 'supported' } }, commands: { 'files.delete': { kind: 'supported' }, 'jobs.start': { kind: 'unsupported' } } });
  expect(request).not.toHaveBeenCalled();
  expect(unwrap(await service.files.listStorages(target))).toMatchObject([
    { id: internal, availability: { kind: 'available' }, browsing: { constraints: { collections: [{ actions: ['download', 'delete'] }] } } },
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
  const traversal = file.fileId.slice(0, file.fileId.lastIndexOf(':') + 1) + '..%2Foutside.gcode';
  expect(await service.files.listPreviews({ ...file, fileId: id<'remote-file'>(traversal) }))
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

it('deletes a scoped USB file once and invalidates its snapshot only after dispatch', async () => {
  const { service, request, browse } = fixture();
  const file = (await browse(usb)).files[0].ref;
  const input = { target, requestId: id<'request'>('delete'), command: { type: 'files.delete', params: { target: file } } } as const;
  expect(await service.controls.evaluate(target, input.command)).toMatchObject({ ok: true, value: { availability: { kind: 'available' } } });
  expect(request).toHaveBeenCalledTimes(1);
  const outcome = await service.controls.submit(input);
  expect(outcome.kind).toBe('recorded');
  if (outcome.kind !== 'recorded') throw new Error('Deletion was not recorded');
  for await (const event of service.operations.watch(outcome.operation)) {
    if (event.phase.kind === 'completed') break;
    expect(event.phase.kind).not.toMatch(/failed|outcome-unknown/);
  }
  expect(await service.controls.submit(input)).toEqual(outcome);
  expect(request.mock.calls.filter(([call]) => call.method === 'DELETE').map(([call]) => call.url))
    .toEqual(['http://printer/proxy/server/files/gcodes/.udisk/%E7%9B%AE%E5%BD%95/part%20%23%25.gcode']);
  expect((await browse(usb)).files).toEqual([]);
});

it('rejects cross-storage deletion and records interrupted dispatch as unconfirmed', async () => {
  const { service, request, browse, data } = fixture();
  const file = (await browse(usb)).files[0].ref;
  const input = { target, requestId: id<'request'>('delete'), command: { type: 'files.delete', params: { target: file } } } as const;
  expect(await service.controls.submit({ ...input, command: { ...input.command, params: { target: { ...file, storageId: internal } } } }))
    .toMatchObject({ kind: 'rejected', error: { code: 'invalid-target' } });
  data.deleteMode = 'interrupted';
  const result = await service.controls.submit(input);
  if (result.kind !== 'recorded') throw new Error('Deletion was not recorded');
  for await (const event of service.operations.watch(result.operation)) {
    if (event.phase.kind === 'outcome-unknown') break;
    expect(event.phase.kind).not.toMatch(/failed|completed/);
  }
  expect(request.mock.calls.filter(([call]) => call.method === 'DELETE')).toHaveLength(1);
});

it('streams the authenticated USB path and rejects a stale route before starting a download', async () => {
  const { service, browse, document } = fixture();
  const target = (await browse(usb)).files[0].ref;
  const fetchFile = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('G90\n', {
    headers: { 'content-length': '4', 'content-type': 'text/plain' },
  }));
  try {
    const download = unwrap(await service.files.download({ target }));
    expect(download).toMatchObject({ suggestedFileName: 'part #%.gcode', totalBytes: 4, returnedRange: null });
    const decoder = new TextDecoder();
    let gcode = '';
    for await (const chunk of download.chunks) gcode += decoder.decode(chunk, { stream: true });
    expect(gcode + decoder.decode()).toBe('G90\n');
    expect(fetchFile).toHaveBeenCalledExactlyOnceWith(
      'http://printer/proxy/server/files/gcodes/.udisk/%E7%9B%AE%E5%BD%95/part%20%23%25.gcode',
      expect.objectContaining({ headers: { 'X-Api-Key': 'secret' }, redirect: 'error' }));
    document.printers[0].apiBaseUrl = 'http://other-printer/';
    expect(await service.files.download({ target })).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect(fetchFile).toHaveBeenCalledTimes(1);
  } finally { fetchFile.mockRestore(); }
});

it('streams decoded gzip G-code without treating the compressed length as the file size', async () => {
  const { service, browse } = fixture();
  const target = (await browse()).files[0].ref;
  const fetchFile = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('G90\n', {
    headers: { 'content-encoding': 'gzip', 'content-length': '24', 'content-type': 'text/plain' },
  }));
  try {
    const download = unwrap(await service.files.download({ target }));
    expect(download).toMatchObject({ totalBytes: null, responseBytes: null });
    const chunks = [];
    for await (const chunk of download.chunks) chunks.push(...chunk);
    expect(new TextDecoder().decode(Uint8Array.from(chunks))).toBe('G90\n');
  } finally { fetchFile.mockRestore(); }
});
