import { expect, it } from 'vitest';
import { isBambuControlRequest } from './bambuControl';
const target = { printerId: 'printer', routeId: 'route' };
it('admits scoped metadata requests and rejects paths, credentials, ambiguous locations and unbounded pages', () => {
  const input = { readId: 'read', request: { target, storageId: 'sdcard', location: { kind: 'collection', collectionId: 'model' }, pageSize: 100 } };
  expect(isBambuControlRequest({ method: 'storage.list', input })).toBe(true);
  expect(isBambuControlRequest({ method: 'storage.storages', input: { target, readId: 'read' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'storage.cancel', input: { readId: 'read' } })).toBe(true);
  for (const request of [ { ...input.request, path: '/host/private' }, { ...input.request, pageSize: 501 },
    { ...input.request, target: { ...target, accessCode: 'private' } },
    { ...input.request, location: { kind: 'collection', collectionId: 'model', directoryId: null } }, { ...input.request, cursor: 'x'.repeat(513) }])
    expect(isBambuControlRequest({ method: 'storage.list', input: { ...input, request } })).toBe(false);
  expect(isBambuControlRequest({ method: 'storage.download', input: { readId: 'read', path: '/host/file' } })).toBe(false);
});
it('admits remote preparation by agent-owned identity and rejects forged requirements or paths', () => {
  const file = { ...target, configurationRevision: 'r1', storageId: 'sdcard', fileId: 'file' };
  const request = { inspection: { file, id: 'inspection' }, targetId: 'plate', bindings: [], options: {}, suggest: true, allowAbnormalStorage: false };
  expect(isBambuControlRequest({ method: 'storage.inspectPrint', input: { file, readId: 'read' } })).toBe(true);
  expect(isBambuControlRequest({ method: 'storage.preparePrint', input: { request, readId: 'read' } })).toBe(true);
  for (const invalid of [{ ...request, requirements: {} }, { ...request, path: '/device/file' }, { ...request, options: { native_option: true } }, { ...request, bindings: Array(65).fill({ materialKey: 'm', pathId: 'p' }) }])
    expect(isBambuControlRequest({ method: 'storage.preparePrint', input: { request: invalid, readId: 'read' } })).toBe(false);
});
