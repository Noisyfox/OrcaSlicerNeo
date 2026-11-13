/** Metadata-only Storage RPC. Destination paths, credentials and binary streams are host-private. */
import type * as D from '@orca/platform-contract';
import { isPrintOptions } from './bambuSubmission';
export interface BambuStorageInputs {
  'storage.storages': { target: D.PrinterTarget; readId: string };
  'storage.list': { request: D.ListFilesRequest; readId: string };
  'storage.previews': { file: D.RemoteFileRef; readId: string };
  'storage.stat': { file: D.RemoteFileRef; readId: string };
  'storage.inspectPrint': { file: D.RemoteFileRef; readId: string };
  'storage.preparePrint': { request: D.RemotePrintPreparationRequest; readId: string };
  'storage.releasePrint': { ref: D.RemotePrintInspectionRef; readId: string };
  'storage.cancel': { readId: string };
}
export interface BambuStorageResults {
  'storage.storages': D.Result<readonly D.PrinterStorage[]>;
  'storage.list': D.Result<D.RemoteFilePage>;
  'storage.previews': D.Result<D.FilePreviewListing>;
  'storage.stat': D.Result<D.RemoteFileDetails>;
  'storage.inspectPrint': D.Result<D.RemotePrintInspection>;
  'storage.preparePrint': D.Result<D.PrintPreparation>;
  'storage.releasePrint': D.Result<null>;
  'storage.cancel': D.Result<null>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const target = (value: unknown) => object(value) && exact(value, ['printerId', 'routeId']) && text(value.printerId) && text(value.routeId);
export function isStorageFileRef(value: unknown): value is D.RemoteFileRef {
  return object(value) && exact(value, ['printerId', 'routeId', 'configurationRevision', 'storageId', 'fileId']) &&
    text(value.printerId) && text(value.routeId) && text(value.configurationRevision) && text(value.storageId) && text(value.fileId, 16384);
}
export function isBambuStorageRequest(method: string, input: Record<string, unknown>): boolean {
  if (!text(input.readId)) return false;
  if (method === 'storage.cancel') return exact(input, ['readId']);
  if (method === 'storage.storages') return exact(input, ['target', 'readId']) && target(input.target);
  if (method === 'storage.stat' || method === 'storage.previews' || method === 'storage.inspectPrint') return exact(input, ['file', 'readId']) && isStorageFileRef(input.file);
  const inspection = (v: unknown) => object(v) && exact(v, ['file', 'id']) && isStorageFileRef(v.file) && text(v.id);
  if (method === 'storage.releasePrint') return exact(input, ['ref', 'readId']) && inspection(input.ref);
  if (method === 'storage.preparePrint') {
    const r = input.request;
    return exact(input, ['request', 'readId']) && object(r) &&
      exact(r, ['inspection', 'targetId', 'bindings', 'options', 'suggest', 'checkRecording', 'allowAbnormalStorage']) &&
      inspection(r.inspection) && text(r.targetId) && isPrintOptions(r.options) &&
      typeof r.suggest === 'boolean' && typeof r.allowAbnormalStorage === 'boolean' &&
      (r.checkRecording === undefined || typeof r.checkRecording === 'boolean') &&
      Array.isArray(r.bindings) && r.bindings.length <= 64 && r.bindings.every(b => object(b) &&
        exact(b, ['materialKey', 'pathId']) && text(b.materialKey) && text(b.pathId));
  }
  if (method !== 'storage.list' || !exact(input, ['request', 'readId']) || !object(input.request)) return false;
  const request = input.request, location = request.location;
  return exact(request, ['target', 'storageId', 'location', 'kinds', 'cursor', 'pageSize']) && target(request.target) && text(request.storageId) &&
    object(location) && (location.kind === 'collection' && exact(location, ['kind', 'collectionId']) && text(location.collectionId) ||
      location.kind === 'directory' && exact(location, ['kind', 'directoryId']) && (location.directoryId === null || text(location.directoryId))) &&
    (request.kinds === undefined || Array.isArray(request.kinds) && request.kinds.length > 0 && request.kinds.length <= 5 &&
      request.kinds.every(kind => ['print-file', 'timelapse', 'recording', 'image', 'other'].includes(String(kind)))) &&
    (request.cursor === undefined || text(request.cursor)) &&
    (request.pageSize === undefined || Number.isSafeInteger(request.pageSize) && Number(request.pageSize) >= 1 && Number(request.pageSize) <= 500);
}
