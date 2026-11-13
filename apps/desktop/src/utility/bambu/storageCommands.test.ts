import { expect, it, vi } from 'vitest';
import type * as D from '@orca/platform-contract';
import { BambuStorageError } from '@orca/bambu-native';
import { BambuStorageFiles, type BambuStorageSource } from './storageFiles';
import { BambuStorageCommands } from './storageCommands';
import { BambuOperations } from './operations';
import type { BambuMonitor } from './monitor';
const target = { printerId: 'bambu:a' as D.Id<'printer'>, routeId: 'bambu:a:agent' as D.Id<'route'> };
async function fixture() {
  const source: BambuStorageSource = { configurationRevision: 'r1',
    list: vi.fn(async () => [{ name: 'part.gcode.3mf', path: '/part.gcode.3mf', sizeBytes: 3, modifiedAtSeconds: null }]),
    download: vi.fn(), resource: vi.fn(async () => null), remove: vi.fn(async () => {}) };
  const files = new BambuStorageFiles(async () => ({ ok: true, value: source }));
  const page = await files.list({ target, storageId: 'external' as D.Id<'storage'>, location: { kind: 'collection', collectionId: 'model' as D.Id<'file-collection'> } });
  if (!page.ok) throw new Error('fixture'); const file = page.value.files[0].ref;
  const monitor = { acquire: vi.fn(() => { throw new Error('Storage must not acquire MQTT'); }), context: vi.fn() } as unknown as BambuMonitor;
  const storage = new BambuStorageCommands(files, () => {}), operations = new BambuOperations(monitor, () => {}, undefined, undefined, storage);
  const request: D.CommandRequest = { target: { ...target, expectedConfigurationRevision: 'r1' }, requestId: 'delete' as D.Id<'request'>,
    command: { type: 'files.delete', params: { target: file } } };
  const outcome = async () => {
    const result = await operations.submit(request); if (result.kind !== 'recorded') throw new Error(result.kind);
    await vi.waitFor(() => { const found = operations.get(result.operation); expect(found.ok && found.value.kind === 'found' && found.value.operation.phase.kind).not.toBe('sent'); });
    const found = operations.get(result.operation); if (!found.ok || found.value.kind !== 'found') throw new Error('missing'); return found.value.operation;
  };
  return { source, files, file, monitor, operations, request, outcome };
}
it('deletes directly without metadata/version reads or acquiring a Monitor lease and deduplicates requests', async () => {
  const f = await fixture(); expect(await f.operations.evaluate(target, f.request.command)).toMatchObject({ ok: true, value: { availability: { kind: 'available' } } });
  expect((await f.outcome()).phase.kind).toBe('completed'); await f.operations.submit(f.request);
  expect(f.source.remove).toHaveBeenCalledOnce(); expect(f.source.list).toHaveBeenCalledOnce(); expect(f.monitor.acquire).not.toHaveBeenCalled(); expect(f.monitor.context).not.toHaveBeenCalled();
  expect(f.operations.find({ ...target, requestId: f.request.requestId })).toMatchObject({ ok: true, value: { kind: 'found', operation: { phase: { kind: 'completed' } } } });
  expect(await f.operations.submit({ ...f.request, command: { type: 'files.delete', params: { target: { ...f.file, fileId: 'other' as D.Id<'remote-file'> } } } })).toMatchObject({ kind: 'rejected' });
  await f.operations.close();
});
it('records explicit printer rejection separately from uncertain transport/protocol outcomes', async () => {
  for (const [error, expected] of [[new BambuStorageError('device-rejected', 'busy', 5), 'failed'], [new BambuStorageError('transport', 'lost'), 'outcome-unknown'], [new BambuStorageError('invalid-response', 'bad reply'), 'outcome-unknown']] as const) {
    const f = await fixture(); vi.mocked(f.source.remove).mockRejectedValue(error);
    expect((await f.outcome()).phase.kind).toBe(expected); expect(f.source.list).toHaveBeenCalledOnce(); expect(f.source.remove).toHaveBeenCalledOnce(); await f.operations.close();
  }
});
it('rejects a cross-printer ref or changed configuration before any mutation', async () => {
  const f = await fixture();
  expect(await f.operations.submit({ ...f.request, target: { ...target, printerId: 'bambu:b' as D.Id<'printer'> } })).toMatchObject({ kind: 'rejected', error: { code: 'invalid-target' } });
  f.source.configurationRevision = 'r2';
  expect(await f.operations.submit({ ...f.request, requestId: 'different' as D.Id<'request'> })).toMatchObject({ kind: 'rejected', error: { code: 'stale-context' } });
  expect(f.source.remove).not.toHaveBeenCalled(); await f.operations.close();
});
it('joins a dispatched deletion on close and retains its uncertain result', async () => {
  const f = await fixture(); vi.mocked(f.source.remove).mockImplementation(async (_file, signal) => {
    await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); });
    throw new BambuStorageError('cancelled', 'closed');
  });
  const submitted = await f.operations.submit(f.request); expect(submitted.kind).toBe('recorded'); await f.operations.close();
  expect(f.operations.find({ ...target, requestId: f.request.requestId })).toMatchObject({ ok: true, value: { kind: 'found', operation: { phase: { kind: 'outcome-unknown' } } } });
});
