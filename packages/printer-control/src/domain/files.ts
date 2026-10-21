/** Remote resources and local streaming API. Files remain scoped to their printer route. */
import type { Id, Revision, UnixMs, Result, ReadOptions, Capability, Availability } from './common';
import type { Submission } from './control';
export type PrintFormatId = 'gcode' | `vendor:${string}`;
export interface RemoteFileRef {
  printerId: Id<'printer'>;
  routeId: Id<'route'>;
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
  previews: readonly FilePreviewOption[];
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
  id: Id<'preview-option'>;
  kind: PreviewKind;
  label: string;
  contentFormat: string | null;
}
export interface ListFilesRequest {
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
  requestId: Id<'request'>;
  storageId: Id<'storage'>;
  directoryId: Id<'remote-directory'> | null;
  fileName: string;
  format: PrintFormatId;
  sizeBytes: number;
  collisionPolicy: 'reject' | 'rename';
}
export interface UploadSource {
  chunks: AsyncIterable<Uint8Array>;
}
export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
  stage: 'transferring' | 'awaiting-confirmation';
}
export interface FileCapabilities {
  list: Capability<{
    storageIds: readonly Id<'storage'>[];
    kinds: readonly RemoteFileKind[];
  }>;
  stat: Capability<readonly {
    storageId: Id<'storage'>;
    versionCheck: VersionCheck;
  }[]>;
  download: Capability<readonly {
    storageId: Id<'storage'>;
    byteRanges: boolean;
    versionCheck: VersionCheck;
  }[]>;
  upload: Capability<readonly {
    storageId: Id<'storage'>;
    formats: readonly PrintFormatId[];
    maxBytes: number | null;
    collisionPolicies: readonly ('reject' | 'rename')[];
  }[]>;
  preview: Capability<readonly {
    storageId: Id<'storage'>;
    kinds: readonly PreviewKind[];
    versionCheck: VersionCheck;
  }[]>;
  changes: Capability<{
    storageIds: readonly Id<'storage'>[];
    delivery: readonly ('push' | 'poll')[];
  }>;
}
export interface PrinterFiles {
  listStorages(options?: ReadOptions): Promise<Result<readonly PrinterStorage[]>>;
  list(request: ListFilesRequest, options?: ReadOptions): Promise<Result<RemoteFilePage>>;
  stat(selection: FileSelection, options?: ReadOptions): Promise<Result<RemoteFileDetails>>;
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
  /** Subscribe before listing; gaps emit resync-required. */
  watchChanges(options?: ReadOptions): AsyncIterable<FileChangeEvent>;
}
