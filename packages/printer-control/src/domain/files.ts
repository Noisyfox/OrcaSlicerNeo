/** Remote resources and local streaming API. Files remain scoped to their printer route. */
import type { Id, Revision, UnixMs, Result, ReadOptions, Capability, Availability, PrinterTarget, TargetRequest, NonEmptyReadonlyArray } from './common';
import type { Submission } from './control';
export type PrintFormatId = 'gcode' | `vendor:${string}`;
export interface RemoteFileRef {
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
  /** Reject stale configuration rather than resolving this identity on a different device. */
  configurationRevision: Revision;
  storageId: Id<'storage'>;
  fileId: Id<'remote-file'>;
  contentRevision: Revision | null;
}

/** Strict matching requires atomic adapter support; never silently downgrade it. */
export type FileSelection = {
  consistency: 'require-version-match';
  file: RemoteFileRef & {
    contentRevision: Revision;
  };
} | {
  consistency: 'best-effort';
  file: RemoteFileRef;
};
export type VersionCheck = 'atomic' | 'best-effort' | 'unavailable';
export interface PrinterStorage {
  id: Id<'storage'>;
  name: string;
  kind: 'internal' | 'removable' | 'cloud' | 'other';
  availability: Availability;
  capacityBytes: number | null;
  freeBytes: number | null;
}
export interface RemoteDirectory {
  id: Id<'remote-directory'>;
  storageId: Id<'storage'>;
  parentId: Id<'remote-directory'> | null;
  name: string;
}
export type RemoteFileMetadata = {
  kind: 'print-file';
  format: PrintFormatId;
  estimatedDurationSeconds: number | null;
  materialKeys: readonly string[] | null;
} | {
  kind: 'timelapse' | 'recording';
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  relatedJobId: Id<'job'> | null;
} | {
  kind: 'image';
  width: number | null;
  height: number | null;
} | {
  kind: 'other';
};
export type RemoteFileKind = RemoteFileMetadata['kind'];
export interface RemoteFile {
  ref: RemoteFileRef;
  directoryId: Id<'remote-directory'> | null;
  name: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAtMs: UnixMs | null;
  modifiedAtMs: UnixMs | null;
  metadata: RemoteFileMetadata;
}
export interface RemoteFileDetails {
  file: RemoteFile;
  assessedAtMs: UnixMs;
  capabilityRevision: Revision;
  availability: {
    download: Availability;
    delete: Availability;
    startPrint: Availability;
  };
}
export type PreviewKind = 'thumbnail' | 'image' | 'video' | 'text' | 'toolpath';
export interface FilePreviewOption {
  /** Scoped to file/configuration/content; not a token for a prior listing session. */
  id: Id<'preview-option'>;
  kind: PreviewKind;
  label: string;
  contentFormat: string | null;
}
export interface FilePreviewListing {
  /** Identity/version assessed for these options; retain it when opening media. */
  file: RemoteFileRef;
  /** Empty means this file has no preview options, not that the query failed. */
  options: readonly FilePreviewOption[];
}
export interface ListFilesRequest {
  target: PrinterTarget;
  storageId: Id<'storage'>;
  directoryId: Id<'remote-directory'> | null;
  kinds?: readonly RemoteFileKind[];
  cursor?: string;
  pageSize?: number;
}
export interface RemoteFilePage {
  directories: readonly RemoteDirectory[];
  files: readonly RemoteFile[];
  nextCursor: string | null;
  listingRevision: Revision | null;
  pagination: 'snapshot' | 'best-effort';
}

/** Half-open range in bytes; adapters validate non-negative, increasing bounds. */
export interface ByteRange {
  startByte: number;
  endByteExclusive: number;
}

/**
 * Local stream handle, not a wire DTO. Consume once; early iterator return releases
 * the read. Late failures throw PrinterStreamError; returnedRange is the actual range.
 */
export interface BinaryRead {
  mimeType: string | null;
  totalBytes: number | null;
  responseBytes: number | null;
  returnedRange: ByteRange | null;
  chunks: AsyncIterable<Uint8Array>;
}
export interface DownloadedFile extends BinaryRead {
  file: RemoteFileRef;
  suggestedFileName: string;
}
export type FileChangeEvent = {
  type: 'directory-invalidated';
  storageId: Id<'storage'>;
  directoryId: Id<'remote-directory'> | null;
} | {
  type: 'storages-invalidated';
} | {
  type: 'resync-required';
};
export interface UploadRequest {
  target: TargetRequest;
  requestId: Id<'request'>;
  /** Adapter default permits upload without listing storage/directories first. */
  destination: { kind: 'default' } | {
    kind: 'directory';
    storageId: Id<'storage'>;
    directoryId: Id<'remote-directory'> | null;
  };
  fileName: string;
  format: PrintFormatId;
  sizeBytes: number;
  collisionPolicy: 'reject' | 'rename' | 'overwrite';
}
export interface UploadSource {
  chunks: AsyncIterable<Uint8Array>;
}
export interface UploadProgress {
  sentBytes: number;
  /** Transport byte total (including multipart overhead); null when not reported. */
  totalBytes: number | null;
  stage: 'transferring' | 'awaiting-confirmation';
}
export interface FileCapabilities {
  list: Capability<{
    storageIds: NonEmptyReadonlyArray<Id<'storage'>>;
    kinds: NonEmptyReadonlyArray<RemoteFileKind>;
  }>;
  stat: Capability<NonEmptyReadonlyArray<{
    storageId: Id<'storage'>;
    versionCheck: VersionCheck;
  }>>;
  download: Capability<NonEmptyReadonlyArray<{
    storageId: Id<'storage'>;
    byteRanges: boolean;
    versionCheck: VersionCheck;
  }>>;
  upload: Capability<NonEmptyReadonlyArray<{
    destination: UploadRequest['destination'];
    formats: NonEmptyReadonlyArray<PrintFormatId>;
    /** Unknown upload size limit; null does not mean unlimited. */
    maxBytes: number | null;
    collisionPolicies: NonEmptyReadonlyArray<UploadRequest['collisionPolicy']>;
  }>>;
  /** Covers both option enumeration and media opening, independently of stat. */
  preview: Capability<NonEmptyReadonlyArray<{
    storageId: Id<'storage'>;
    kinds: NonEmptyReadonlyArray<PreviewKind>;
    versionCheck: VersionCheck;
  }>>;
  changes: Capability<{
    storageIds: NonEmptyReadonlyArray<Id<'storage'>>;
    delivery: NonEmptyReadonlyArray<'push' | 'poll'>;
  }>;
}
export interface PrinterFiles {
  listStorages(target: PrinterTarget, options?: ReadOptions): Promise<Result<readonly PrinterStorage[]>>;
  list(request: ListFilesRequest, options?: ReadOptions): Promise<Result<RemoteFilePage>>;
  stat(selection: FileSelection, options?: ReadOptions): Promise<Result<RemoteFileDetails>>;
  /** Preview capability owns this query; no stat call or listing session is required. */
  listPreviews(selection: FileSelection, options?: ReadOptions): Promise<Result<FilePreviewListing>>;
  download(request: {
    target: FileSelection;
    range?: ByteRange;
  }, options?: ReadOptions): Promise<Result<DownloadedFile>>;
  /**
   * Register the operation before consuming source; resolve once recorded, not when
   * transfer finishes. Rejection does not consume source; operation owns it afterward.
   * Observe completion/cancellation through the service's operation tracker.
   */
  upload(request: UploadRequest, source: UploadSource): Promise<Submission>;
  /** Optional independent subscription. For a coherent watched listing, subscribe first; gaps require resync. */
  watchChanges(target: PrinterTarget, options?: ReadOptions): AsyncIterable<FileChangeEvent>;
}
