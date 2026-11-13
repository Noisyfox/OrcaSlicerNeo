import { describe, expect, it, vi } from 'vitest';
import type * as D from '@orca/platform-contract';
import { BambuStorageError } from '@orca/bambu-native';
import { BambuStorageFiles, type BambuStorageSource } from './storageFiles';

const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
const request: D.ListFilesRequest = { target, storageId: 'external' as D.Id<'storage'>,
  location: { kind: 'collection', collectionId: 'model' as D.Id<'file-collection'> }, pageSize: 1 };
function fixture() {
  let clock = 0;
  const source: BambuStorageSource = {
    configurationRevision: 'revision-1',
    list: vi.fn(async () => [{ name: 'a.gcode.3mf', path: '/a.gcode.3mf', sizeBytes: 3, modifiedAtSeconds: 10 },
      { name: 'b.gcode.3mf', path: '/b.gcode.3mf', sizeBytes: 4, modifiedAtSeconds: 20 }]),
    download: vi.fn(async () => ({ totalBytes: 3, chunks: (async function* () { yield new Uint8Array([1, 2, 3]); })() })),
    resource: vi.fn(async () => null), remove: vi.fn(async () => undefined),
  };
  const resolve = vi.fn(async () => ({ ok: true as const, value: source }));
  const capabilities = vi.fn(async () => ({ internalModel: true, internalTimelapse: true }));
  const files = new BambuStorageFiles(resolve, () => clock, capabilities);
  return { files, source, resolve, capabilities, advance: () => { clock += 300_001; } };
}
const unwrap = <T>(value: D.Result<T>): T => { if (!value.ok) throw new Error(value.error.message); return value.value; };

describe('Bambu storage file adapter', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]])('gates internal collections on reported capabilities (%s, %s), not emmc discovery', async (internalModel, internalTimelapse) => {
    const f = fixture();
    f.capabilities.mockResolvedValue({ internalModel, internalTimelapse });
    const storages = unwrap(await f.files.listStorages(target));
    expect(storages[0]).toMatchObject({ id: 'external', name: 'External', kind: 'removable' });
    expect(storages).toHaveLength(internalModel || internalTimelapse ? 2 : 1);
    if (storages[1]) expect(storages[1]).toMatchObject({ id: 'internal', name: 'Internal', browsing: { constraints: {
      collections: [internalModel ? { id: 'model' } : null, internalTimelapse ? { id: 'timelapse' } : null].filter(Boolean),
    } } });
    expect(await f.files.list({ ...request, storageId: 'internal' as D.Id<'storage'>, location: { kind: 'collection', collectionId: 'video' as D.Id<'file-collection'> } }))
      .toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(f.source.list).not.toHaveBeenCalled();
  });
  it('resolves each storage and its collections only when explicitly asked', async () => {
    const f = fixture(); expect(f.resolve).not.toHaveBeenCalled();
    const storages = unwrap(await f.files.listStorages(target));
    expect(storages.map(storage => [storage.name, storage.kind])).toEqual([['External', 'removable'], ['Internal', 'internal']]);
    expect(storages[0].browsing).toMatchObject({ kind: 'supported', constraints: { kind: 'collections', collections: [
      { name: 'Print files', kinds: ['print-file'], actions: ['download', 'delete', 'inspect-print'] },
      { name: 'Timelapses', kinds: ['timelapse'] }, { name: 'Recordings', kinds: ['recording'] },
    ] } });
  });

  it('pages a stable snapshot without another remote read and returns independent DTOs', async () => {
    const f = fixture(), first = unwrap(await f.files.list(request));
    expect(first.files).toHaveLength(1); expect(first.pagination).toBe('snapshot');
    first.files[0].name = 'mutated';
    const second = unwrap(await f.files.list({ ...request, cursor: first.nextCursor! }));
    expect(second.files[0].name).toBe('b.gcode.3mf'); expect(second.nextCursor).toBeNull();
    expect(f.source.list).toHaveBeenCalledTimes(1);
    const repeated = unwrap(await f.files.list({ ...request, cursor: first.nextCursor! }));
    expect(repeated.files[0].name).toBe('b.gcode.3mf');
  });

  it('rejects a cursor after changing printer, storage, collection, page size, configuration or expiry', async () => {
    const f = fixture(), first = unwrap(await f.files.list(request));
    const use = (changes: Partial<D.ListFilesRequest>) => f.files.list({ ...request, cursor: first.nextCursor!, ...changes });
    for (const changes of [{ target: { ...target, printerId: 'bambu:b' as D.Id<'printer'> } }, { storageId: 'internal' as D.Id<'storage'> },
      { location: { kind: 'collection', collectionId: 'video' as D.Id<'file-collection'> } as const }, { pageSize: 2 }])
      expect(await use(changes)).toMatchObject({ ok: false, error: { code: 'listing-expired' } });
    f.source.configurationRevision = 'revision-2';
    expect(await use({})).toMatchObject({ ok: false, error: { code: 'listing-expired' } });
    f.source.configurationRevision = 'revision-1'; f.advance();
    expect(await use({})).toMatchObject({ ok: false, error: { code: 'listing-expired' } });
  });

  it('retains file identity across content replacement and downloads without another listing', async () => {
    const f = fixture(), first = unwrap(await f.files.list(request)), ref = first.files[0].ref;
    vi.mocked(f.source.list).mockResolvedValue([{ name: 'a.gcode.3mf', path: '/a.gcode.3mf', sizeBytes: 999, modifiedAtSeconds: 999 }]);
    expect(unwrap(await f.files.list(request)).files[0].ref).toEqual(ref);
    const isolated = new BambuStorageFiles(f.resolve), download = unwrap(await isolated.download({ target: ref }));
    const chunks = []; for await (const chunk of download.chunks) chunks.push([...chunk]);
    expect(chunks).toEqual([[1, 2, 3]]); expect(f.source.list).toHaveBeenCalledTimes(2);
    expect(f.source.download).toHaveBeenCalledWith({ path: '/a.gcode.3mf' }, undefined);
    expect(await isolated.download({ target: { ...ref, configurationRevision: 'old' } })).toMatchObject({ ok: false, error: { code: 'stale-context' } });
    expect(f.source.download).toHaveBeenCalledTimes(1);
  });

  it('invalidates old paging after confirmed deletion and rejects fabricated reader access', async () => {
    const f = fixture(), first = unwrap(await f.files.list(request)), ref = first.files[0].ref;
    f.files.invalidate(ref);
    expect(await f.files.list({ ...request, cursor: first.nextCursor! })).toMatchObject({ ok: false, error: { code: 'listing-expired' } });
    expect(await f.files.download({ target: { ...ref, fileId: 'mem:/16' as D.Id<'remote-file'> } })).toMatchObject({ ok: false, error: { code: 'invalid-target' } });
    expect(await f.files.download({ target: ref, range: { startByte: 0, endByteExclusive: 1 } })).toMatchObject({ ok: false, error: { code: 'range-not-supported' } });
    expect(f.source.download).not.toHaveBeenCalled();
  });

  it('preserves late stream integrity failure as a sanitized domain error and joins early return', async () => {
    const f = fixture(), ref = unwrap(await f.files.list(request)).files[0].ref;
    let released = 0;
    vi.mocked(f.source.download).mockImplementation(async () => ({ totalBytes: 3, chunks: (async function* () {
      try { yield new Uint8Array([1]); throw new BambuStorageError('invalid-response', '/private/path'); }
      finally { released++; }
    })() }));
    const iterator = unwrap(await f.files.download({ target: ref })).chunks[Symbol.asyncIterator]();
    await iterator.next(); await expect(iterator.next()).rejects.toMatchObject({ detail: { code: 'device-failed', message: 'The printer returned inconsistent storage data.' } });
    expect(released).toBe(1);
    const another = unwrap(await f.files.download({ target: ref })).chunks[Symbol.asyncIterator]();
    await another.next(); await another.return?.(); expect(released).toBe(2);
  });
});
